import { bootHarness, Harness, E2eUser, oppPayload, studentPayload, uniq } from './e2e/harness';
import { adminApprove, adminQueueIds, detail, expectNoSecrets, verifyToken } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { FacultyUniversityScopeAssignment } from '../src/faculty-university-scope/entities/faculty-university-scope-assignment.entity';
import { OpportunityApplication } from '../src/opportunities/entities/opportunity-application.entity';
import { Participation } from '../src/engagement/entities/participant.entity';
import { StudentReport } from '../src/reports/entities/student-report.entity';

/**
 * Access-consistency matrix: every row a role's list / queue / dashboard shows must be openable
 * (detail) and actionable (the button the UI offers) by that SAME login, while unrelated logins
 * still get 404 / 403. Real Nest app + real Postgres scratch DB; mail is mocked.
 */
describe('Access consistency: list rule == detail rule == action rule (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
  });
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => h.mail.reset());

  const idsOf = (res: any): string[] => {
    expect(res.status).toBe(200);
    const rows: any[] = Array.isArray(res.body) ? res.body : (res.body.data ?? res.body.items ?? []);
    return rows.map((r) => r.id ?? r.opportunity_id);
  };
  const rowOf = (res: any, id: string): any => {
    expect(res.status).toBe(200);
    const rows: any[] = Array.isArray(res.body) ? res.body : (res.body.data ?? []);
    return rows.find((r) => (r.id ?? r.opportunity_id) === id);
  };

  const ngoWithOrg = async (orgType = 'NGO', name?: string, role: UserRole = UserRole.NGO) => {
    const org = await h.makeOrg(name, orgType);
    const user = await h.makeUser(role, { org });
    return { org, user };
  };

  /** Student wizard submit; returns the persisted row (pending faculty review). */
  const studentSubmit = async (student: E2eUser, facultyEmail: string, over: Record<string, any> = {}) => {
    const res = await h.as(student).post('/student/opportunity').send(studentPayload(facultyEmail, over));
    expect(res.status).toBe(201);
    return h.reload(res.body.data.id);
  };

  const orgCreate = async (user: E2eUser, body: Record<string, any>) => {
    const res = await h.as(user).post('/opportunities').send(body);
    expect(res.status).toBe(201);
    return h.reload(res.body.id);
  };

  // ------------------------------------------------------------------ faculty
  describe('faculty: approvals list == detail == approve / reject / revise', () => {
    const approvalsHas = async (f: E2eUser, id: string) => idsOf(await h.as(f).get('/faculty/approvals')).includes(id);

    it('named supervisor (supervision.contact): listed, opens both detail endpoints, approves', async () => {
      const student = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const opp = await studentSubmit(student, fac.email);
      expect(await approvalsHas(fac, opp.id)).toBe(true);
      expect((await detail(h, fac, opp.id)).status).toBe(201);
      expect((await h.as(fac).get(`/faculty/approvals/${opp.id}`)).status).toBe(200);
      expect(rowOf(await h.as(fac).get('/faculty/approvals'), opp.id).approval_action).toBe('faculty_review');
      expect((await h.as(fac).post(`/faculty/approvals/${opp.id}/approve`).send({})).status).toBe(201);
    });

    it('university-scope delegate: listed, opens both detail endpoints, approve / revise / reject work; other scope + unassigned faculty are refused', async () => {
      const uniName = `Scope Uni ${uniq()}`;
      const uniOrg = await h.makeOrg(uniName, 'UNIVERSITY');
      const otherUniOrg = await h.makeOrg(`Other Uni ${uniq()}`, 'UNIVERSITY');
      const delegate = await h.makeUser(UserRole.FACULTY);
      const delegateOther = await h.makeUser(UserRole.FACULTY);
      const unassigned = await h.makeUser(UserRole.FACULTY);
      const named = await h.makeUser(UserRole.FACULTY);
      const assigns = h.ds.getRepository(FacultyUniversityScopeAssignment);
      await assigns.save(assigns.create({ facultyUser: { id: delegate.id } as any, universityOrganization: { id: uniOrg.id } as any }));
      await assigns.save(assigns.create({ facultyUser: { id: delegateOther.id } as any, universityOrganization: { id: otherUniOrg.id } as any }));

      const student = await h.makeUser(UserRole.STUDENT, { overrides: { university: uniName } as any });
      const approveRow = await studentSubmit(student, named.email);
      const reviseRow = await studentSubmit(student, named.email);
      const rejectRow = await studentSubmit(student, named.email);
      for (const opp of [approveRow, reviseRow, rejectRow]) {
        expect(await approvalsHas(delegate, opp.id)).toBe(true);
        expect((await detail(h, delegate, opp.id)).status).toBe(201);
        expect((await h.as(delegate).get(`/faculty/approvals/${opp.id}`)).status).toBe(200);
        // negatives: other university's delegate, unassigned faculty
        expect(await approvalsHas(delegateOther, opp.id)).toBe(false);
        expect((await detail(h, delegateOther, opp.id)).status).toBe(404);
        expect((await detail(h, unassigned, opp.id)).status).toBe(404);
        expect((await h.as(delegateOther).post(`/faculty/approvals/${opp.id}/approve`).send({})).status).toBe(403);
        expect((await h.as(unassigned).post(`/faculty/approvals/${opp.id}/approve`).send({})).status).toBe(403);
      }
      expect((await h.as(delegate).post(`/faculty/approvals/${approveRow.id}/approve`).send({})).status).toBe(201);
      expect((await h.as(delegate).post(`/faculty/approvals/${reviseRow.id}/revise`).send({ reason: 'please fix the hours' })).status).toBe(201);
      expect((await h.as(delegate).post(`/faculty/approvals/${rejectRow.id}/reject`).send({ reason: 'not eligible for credit' })).status).toBe(201);
      expect((await h.reload(approveRow.id)).workflowStage).toBe('pending_admin');
      expect((await h.reload(reviseRow.id)).workflowStage).toBe('revision');
      expect((await h.reload(rejectRow.id)).workflowStage).toBe('rejected');
    });

    it('faculty named ONLY through the NGO "academic / faculty link" email: listed, opens detail, approves', async () => {
      const { user: ngo } = await ngoWithOrg();
      const fir = await h.makeUser(UserRole.FACULTY);
      const stranger = await h.makeUser(UserRole.FACULTY);
      const opp = await orgCreate(
        ngo,
        oppPayload({
          visibility_and_academic_linkage: { faculty_institutional_representative: { official_email: fir.email, name: 'Dr Link' } },
        }),
      );
      expect(opp.workflowStage).toBe('pending_faculty');
      expect(await approvalsHas(fir, opp.id)).toBe(true);
      expect((await detail(h, fir, opp.id)).status).toBe(201);
      expect((await h.as(fir).get(`/faculty/approvals/${opp.id}`)).status).toBe(200);
      expect((await detail(h, stranger, opp.id)).status).toBe(404);
      expect((await h.as(stranger).get(`/faculty/approvals/${opp.id}`)).status).toBe(404);
      expect((await h.as(stranger).post(`/faculty/approvals/${opp.id}/approve`).send({})).status).toBe(403);
      expect((await h.as(fir).post(`/faculty/approvals/${opp.id}/approve`).send({})).status).toBe(201);
    });

    it('faculty-link email while supervision.contact names someone else: the listed faculty can still approve / revise / reject', async () => {
      const { user: ngo } = await ngoWithOrg();
      const contactFac = await h.makeUser(UserRole.FACULTY);
      const fir = await h.makeUser(UserRole.FACULTY);
      const mk = async () => {
        const opp = await orgCreate(ngo, oppPayload({ supervision: { contact: contactFac.email, supervisor_name: 'Dr C' } }));
        await h.opps.update(opp.id, {
          visibility_and_academic_linkage: { faculty_institutional_representative: { official_email: fir.email } },
        } as any);
        return opp;
      };
      const a = await mk();
      const b = await mk();
      const c = await mk();
      for (const o of [a, b, c]) {
        expect(await approvalsHas(fir, o.id)).toBe(true);
        expect((await detail(h, fir, o.id)).status).toBe(201);
      }
      expect((await h.as(fir).post(`/faculty/approvals/${a.id}/approve`).send({})).status).toBe(201);
      expect((await h.as(fir).post(`/faculty/approvals/${b.id}/revise`).send({ reason: 'needs more detail' })).status).toBe(201);
      expect((await h.as(fir).post(`/faculty/approvals/${c.id}/reject`).send({ reason: 'not suitable at all' })).status).toBe(201);
    });

    it('secondary faculty on an application: listed on faculty/mine and can open the record; unrelated faculty cannot', async () => {
      const { user: ngo } = await ngoWithOrg();
      const student = await h.makeUser(UserRole.STUDENT);
      const primary = await h.makeUser(UserRole.FACULTY);
      const secondary = await h.makeUser(UserRole.FACULTY);
      const stranger = await h.makeUser(UserRole.FACULTY);
      const opp = await orgCreate(ngo, oppPayload());
      await adminApprove(h, admin, opp.id);
      const apps = h.ds.getRepository(OpportunityApplication);
      await apps.save(
        apps.create({
          opportunityId: opp.id,
          studentUserId: student.id,
          internalStatus: 'pending_faculty',
          primaryFacultyEmail: primary.email,
          secondaryFacultyEmail: secondary.email,
          applyPayload: {},
        } as any),
      );
      for (const f of [primary, secondary]) {
        expect(idsOf(await h.as(f).get('/opportunities/faculty/mine'))).toContain(opp.id);
        expect((await detail(h, f, opp.id)).status).toBe(201);
      }
      expect(idsOf(await h.as(stranger).get('/opportunities/faculty/mine'))).not.toContain(opp.id);
      // an unrelated faculty sees the live record but never the creator's contact details
      const strangerView = await detail(h, stranger, opp.id);
      expect(strangerView.body.data.creator?.email ?? null).toBeNull();
      // join-applications queue: primary lists + approves; the row's action rule is the list rule
      const list = await h.as(primary).get('/faculty/applications?status=pending');
      expect(list.status).toBe(200);
      const appRow = (list.body.data as any[]).find((r) => r.opportunity_id === opp.id);
      expect(appRow).toBeTruthy();
      expect((await h.as(stranger).post(`/faculty/applications/${appRow.id}/approve`).send({})).status).toBe(403);
      expect((await h.as(primary).post(`/faculty/applications/${appRow.id}/approve`).send({})).status).toBe(201);
    });

    it('secondary faculty on the join-applications queue: listed, approve / reject work; unrelated faculty neither see nor act', async () => {
      const { user: ngo } = await ngoWithOrg();
      const s1 = await h.makeUser(UserRole.STUDENT);
      const s2 = await h.makeUser(UserRole.STUDENT);
      const primary = await h.makeUser(UserRole.FACULTY);
      const secondary = await h.makeUser(UserRole.FACULTY);
      const stranger = await h.makeUser(UserRole.FACULTY);
      const opp = await orgCreate(ngo, oppPayload());
      await adminApprove(h, admin, opp.id);
      const apps = h.ds.getRepository(OpportunityApplication);
      const mk = async (student: E2eUser) =>
        apps.save(
          apps.create({
            opportunityId: opp.id,
            studentUserId: student.id,
            internalStatus: 'pending_faculty',
            primaryFacultyEmail: primary.email,
            secondaryFacultyEmail: `  ${secondary.email.toUpperCase()} `, // stored un-normalised on purpose
            applyPayload: {},
          } as any) as unknown as OpportunityApplication,
        );
      const a1 = await mk(s1);
      const a2 = await mk(s2);
      const queueIds = async (f: E2eUser, status = 'pending') =>
        ((await h.as(f).get(`/faculty/applications?status=${status}`)).body.data as any[]).map((r) => r.id);
      expect(await queueIds(secondary)).toEqual(expect.arrayContaining([a1.id, a2.id]));
      expect(await queueIds(primary)).toEqual(expect.arrayContaining([a1.id, a2.id]));
      expect(await queueIds(stranger)).not.toContain(a1.id);
      // negative controls
      expect((await h.as(stranger).post(`/faculty/applications/${a1.id}/approve`).send({})).status).toBe(403);
      expect((await h.as(stranger).post(`/faculty/applications/${a1.id}/reject`).send({ reason: 'nope nope' })).status).toBe(403);
      // secondary acts on what the queue shows
      expect((await h.as(secondary).post(`/faculty/applications/${a1.id}/approve`).send({})).status).toBe(201);
      expect((await h.as(secondary).post(`/faculty/applications/${a2.id}/reject`).send({ reason: 'not a fit for this' })).status).toBe(201);
      expect((await apps.findOneByOrFail({ id: a1.id })).internalStatus).toBe('pending_admin');
      expect((await apps.findOneByOrFail({ id: a2.id })).internalStatus).toBe('faculty_rejected');
      expect(await queueIds(secondary)).not.toContain(a1.id);
      expect(await queueIds(secondary, 'history')).toEqual(expect.arrayContaining([a1.id, a2.id]));
      expect(await queueIds(stranger, 'history')).not.toContain(a1.id);
    });

    /** Student row past faculty review whose ONLY link to `pf` is one partner-contact field. */
    const partnerGateRowNaming = async (mutate: (opp: any, pf: E2eUser) => any) => {
      const student = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const opp = await studentSubmit(student, fac.email, {
        executing_context: { type: 'partner', partner: { official_email: `host.${uniq()}@elsewhere.test`, organization_name: 'Host Ltd' } },
      });
      await verifyToken(h, opp.faculty_verification_token!);
      expect((await h.reload(opp.id)).workflowStage).toBe('pending_partner');
      return opp;
    };

    it.each([
      ['external_partner_collaboration.official_email', (o: any, e: string) => ({ external_partner_collaboration: { official_email: e } })],
      ['supervision.partner_email', (o: any, e: string) => ({ supervision: { ...o.supervision, partner_email: e } })],
      ['supervision.external_partner_email', (o: any, e: string) => ({ supervision: { ...o.supervision, external_partner_email: e } })],
      ['executing_context.partner.official_email', (o: any, e: string) => ({ executing_context: { ...o.executing_context, partner: { ...o.executing_context.partner, official_email: e } } })],
    ])('faculty named only via %s: approvals list == both detail reads == partner-ack action; unrelated faculty refused', async (_name, patch) => {
      const pf = await h.makeUser(UserRole.FACULTY);
      const stranger = await h.makeUser(UserRole.FACULTY);
      const row = await partnerGateRowNaming(() => null);
      const fresh = await h.reload(row.id);
      await h.opps.update(row.id, (patch as any)(fresh, pf.email));
      expect(await approvalsHas(pf, row.id)).toBe(true);
      expect(rowOf(await h.as(pf).get('/faculty/approvals'), row.id).approval_action).toBe('partner_ack');
      expect((await detail(h, pf, row.id)).status).toBe(201);
      expect((await h.as(pf).get(`/faculty/approvals/${row.id}`)).status).toBe(200);
      // negative controls
      expect(await approvalsHas(stranger, row.id)).toBe(false);
      expect((await detail(h, stranger, row.id)).status).toBe(404);
      expect((await h.as(stranger).get(`/faculty/approvals/${row.id}`)).status).toBe(404);
      expect((await h.as(stranger).post(`/partners/approvals/${row.id}/approve`).send({})).status).toBe(403);
      // the action the list offers works for the listed login
      expect((await h.as(pf).post(`/partners/approvals/${row.id}/approve`).send({})).status).toBe(201);
      expect((await h.reload(row.id)).partnerApprovalStatus).toBe('approved');
    });

    it('partner-contact-only faculty is NOT offered the faculty gate (no list row that would 403); the named supervisor still is', async () => {
      const student = await h.makeUser(UserRole.STUDENT);
      const supervisor = await h.makeUser(UserRole.FACULTY);
      const pf = await h.makeUser(UserRole.FACULTY);
      const opp = await studentSubmit(student, supervisor.email, {
        executing_context: { type: 'partner', partner: { official_email: `host.${uniq()}@elsewhere.test`, organization_name: 'Host Ltd' } },
      });
      await h.opps.update(opp.id, { external_partner_collaboration: { official_email: pf.email } } as any);
      expect(opp.workflowStage).toBe('pending_faculty');
      expect(await approvalsHas(supervisor, opp.id)).toBe(true);
      expect(await approvalsHas(pf, opp.id)).toBe(false); // list == action: pf cannot act on the faculty gate
      expect((await h.as(pf).post(`/faculty/approvals/${opp.id}/approve`).send({})).status).toBe(403);
      expect((await detail(h, pf, opp.id)).status).toBe(201); // read access via the contact email is unchanged
      expect((await h.as(supervisor).post(`/faculty/approvals/${opp.id}/approve`).send({})).status).toBe(201);
    });

    it('university-scope delegate on the join-applications queue: listed, approve works; unassigned faculty refused', async () => {
      const uniName = `Join Uni ${uniq()}`;
      const uniOrg = await h.makeOrg(uniName, 'UNIVERSITY');
      const delegate = await h.makeUser(UserRole.FACULTY);
      const unassigned = await h.makeUser(UserRole.FACULTY);
      const assigns = h.ds.getRepository(FacultyUniversityScopeAssignment);
      await assigns.save(assigns.create({ facultyUser: { id: delegate.id } as any, universityOrganization: { id: uniOrg.id } as any }));
      const student = await h.makeUser(UserRole.STUDENT, { overrides: { university: uniName } as any });
      const { user: ngo } = await ngoWithOrg();
      const opp = await orgCreate(ngo, oppPayload());
      await adminApprove(h, admin, opp.id);
      const apps = h.ds.getRepository(OpportunityApplication);
      const app = await apps.save(
        apps.create({ opportunityId: opp.id, studentUserId: student.id, internalStatus: 'pending_faculty', primaryFacultyEmail: 'nobody@x.org', applyPayload: {} } as any) as unknown as OpportunityApplication,
      );
      const list = await h.as(delegate).get('/faculty/applications?status=pending');
      expect((list.body.data as any[]).some((r) => r.id === app.id)).toBe(true);
      expect((await detail(h, delegate, opp.id)).body.data.creator?.email).toBeTruthy(); // delegate acts, so sees contacts
      expect((await h.as(unassigned).post(`/faculty/applications/${app.id}/approve`).send({})).status).toBe(403);
      expect((await h.as(delegate).post(`/faculty/applications/${app.id}/approve`).send({})).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------ partner / org
  describe('partner / NGO / corporate / org-admin: partner_id=me list == detail == actions', () => {
    /** Student row that names `partner` as the host, already past faculty review. */
    const studentRowAwaitingPartner = async (partnerFields: Record<string, any>) => {
      const student = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const opp = await studentSubmit(student, fac.email, partnerFields);
      await verifyToken(h, opp.faculty_verification_token!);
      const after = await h.reload(opp.id);
      expect(after.workflowStage).toBe('pending_partner');
      return after;
    };
    const partnerList = (u: E2eUser) => h.as(u).get('/opportunities?partner_id=me');

    it('partner named through a LATER contact field (not the first non-empty one): listed, opens, approves', async () => {
      const first = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const later = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const stranger = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const opp = await studentRowAwaitingPartner({
        executing_context: { type: 'partner', partner: { official_email: first.email, organization_name: 'Host One' } },
      });
      // a second, different partner contact appears on the record (e.g. admin-edited / resubmitted)
      await h.opps.update(opp.id, { partner_organization: { official_email: later.email, organization_name: 'Host Two' } } as any);
      for (const p of [first, later]) {
        expect(idsOf(await partnerList(p))).toContain(opp.id);
        expect((await detail(h, p, opp.id)).status).toBe(201);
        expect(rowOf(await partnerList(p), opp.id).viewer_access.can_partner_review).toBe(true);
      }
      expect(idsOf(await partnerList(stranger))).not.toContain(opp.id);
      expect((await detail(h, stranger, opp.id)).status).toBe(404);
      expect((await h.as(stranger).post(`/partners/approvals/${opp.id}/approve`).send({})).status).toBe(403);
      expect((await h.as(later).post(`/partners/approvals/${opp.id}/approve`).send({})).status).toBe(201);
      expect((await h.reload(opp.id)).partnerApprovalStatus).toBe('approved');
    });

    it('partner identified only by organisation NAME: listed, opens, can act', async () => {
      const orgName = `Nameonly ${uniq()} Foundation`;
      const { user: named } = await ngoWithOrg('NGO', orgName);
      const opp = await studentRowAwaitingPartner({
        executing_context: { type: 'partner', partner: { official_email: `someone.${uniq()}@elsewhere.test`, organization_name: orgName } },
      });
      expect(idsOf(await partnerList(named))).toContain(opp.id);
      expect((await detail(h, named, opp.id)).status).toBe(201);
      expect(rowOf(await partnerList(named), opp.id).viewer_access.can_partner_review).toBe(true);
      expect((await h.as(named).post(`/partners/approvals/${opp.id}/revise`).send({ reason: 'clarify scope' })).status).toBe(201);
    });

    it('student row hosted by the partner org (organizationId): every member of that org lists / opens / approves; other org does not', async () => {
      const { org, user: member } = await ngoWithOrg();
      const colleague = await h.makeUser(UserRole.ORGANIZATION_ADMIN, { org });
      const other = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const opp = await studentRowAwaitingPartner({
        executing_context: { type: 'partner', partner: { official_email: `nobody.${uniq()}@elsewhere.test`, organization_name: 'Someone Else Ltd' } },
      });
      await h.opps.update(opp.id, { organizationId: org.id } as any);
      for (const p of [member, colleague]) {
        expect(idsOf(await partnerList(p))).toContain(opp.id);
        expect((await detail(h, p, opp.id)).status).toBe(201);
        expect(rowOf(await partnerList(p), opp.id).viewer_access.can_partner_review).toBe(true);
      }
      expect(idsOf(await partnerList(other))).not.toContain(opp.id);
      expect((await detail(h, other, opp.id)).status).toBe(404);
      expect((await h.as(other).post(`/partners/approvals/${opp.id}/approve`).send({})).status).toBe(403);
      expect((await h.as(colleague).post(`/partners/approvals/${opp.id}/approve`).send({})).status).toBe(201);
    });

    it('org-created row: creator + colleague list / open / edit; the list tells the UI they are NOT the partner reviewer (backend refuses that too)', async () => {
      const { org, user: creator } = await ngoWithOrg();
      const colleague = await h.makeUser(UserRole.NGO, { org });
      const partnerUser = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const opp = await orgCreate(
        creator,
        oppPayload({ partner_organization: { organization_name: 'Collab Org', official_email: partnerUser.email } }),
      );
      for (const u of [creator, colleague]) {
        expect(idsOf(await partnerList(u))).toContain(opp.id);
        const d = await detail(h, u, opp.id);
        expect(d.status).toBe(201);
        expect(d.body.data.viewer_access.can_edit).toBe(true);
        expect(rowOf(await partnerList(u), opp.id).viewer_access).toMatchObject({ is_org_owner: true, can_partner_review: false });
        expect((await h.as(u).post(`/partners/approvals/${opp.id}/approve`).send({})).status).toBe(403);
      }
      // the named partner: listed, may review, but is NOT offered Edit (and the backend refuses it)
      const pd = await detail(h, partnerUser, opp.id);
      expect(pd.status).toBe(201);
      expect(pd.body.data.viewer_access.can_edit).toBe(false);
      expect(rowOf(await partnerList(partnerUser), opp.id).viewer_access).toMatchObject({ is_org_owner: false, can_partner_review: true });
      expect((await h.as(partnerUser).post('/opportunities/update').send({ id: opp.id, title: 'Hijacked title' })).status).toBe(403);
    });

    it('executing-organization contact: the row is listed, opens (so Confirm is reachable), confirms; unrelated org cannot', async () => {
      const { user: ngo } = await ngoWithOrg();
      const execUser = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const stranger = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const opp = await orgCreate(
        ngo,
        oppPayload({
          executing_organization: { name: 'Exec Org', official_email: execUser.email },
          partner_organization: { organization_name: 'Collab Org' },
        }),
      );
      expect(opp.status).toBe('pending_execution');
      expect(idsOf(await partnerList(execUser))).toContain(opp.id);
      expect(rowOf(await partnerList(execUser), opp.id).viewer_access.is_executing_contact).toBe(true);
      const d = await detail(h, execUser, opp.id);
      expect(d.status).toBe(201);
      expect(d.body.data.viewer_access.can_edit).toBe(false);
      expectNoSecrets(d, '(exec contact detail)');
      expect(idsOf(await partnerList(stranger))).not.toContain(opp.id);
      expect((await detail(h, stranger, opp.id)).status).toBe(404);
      expect((await h.as(stranger).post('/opportunities/verify/executing-org').send({ id: opp.id })).status).toBe(403);
      expect((await h.as(execUser).post('/opportunities/verify/executing-org').send({ id: opp.id })).status).toBe(201);
    });

    it('university login named by e-mail as the partner reviewer sees the row in its queue and can act', async () => {
      const uniName = `Email Uni ${uniq()}`;
      const uniOrg = await h.makeOrg(uniName, 'UNIVERSITY');
      const uniUser = await h.makeUser(UserRole.UNIVERSITY, { org: uniOrg });
      const opp = await studentRowAwaitingPartner({
        executing_context: { type: 'partner', partner: { official_email: uniUser.email, organization_name: 'Unrelated Name Co' } },
      });
      expect(idsOf(await partnerList(uniUser))).toContain(opp.id);
      expect((await detail(h, uniUser, opp.id)).status).toBe(201);
      expect((await h.as(uniUser).post(`/partners/approvals/${opp.id}/approve`).send({})).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------ university
  describe('university dashboards: everything listed opens (read-only, contacts redacted)', () => {
    it('opportunity in the university scope: partner_id=me list, dashboard recentProjects and detail agree; other universities / NGOs get 404', async () => {
      const uniName = `Dash Uni ${uniq()}`;
      const uniOrg = await h.makeOrg(uniName, 'UNIVERSITY');
      const uniUser = await h.makeUser(UserRole.UNIVERSITY, { org: uniOrg });
      const otherUni = await h.makeUser(UserRole.UNIVERSITY, { org: await h.makeOrg(`Foreign Uni ${uniq()}`, 'UNIVERSITY') });
      const ngo = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
      const student = await h.makeUser(UserRole.STUDENT, { overrides: { university: uniName } as any });
      const fac = await h.makeUser(UserRole.FACULTY);
      const opp = await studentSubmit(student, fac.email);

      expect(idsOf(await h.as(uniUser).get('/opportunities?partner_id=me'))).toContain(opp.id);
      const dash = await h.as(uniUser).get('/partners/dashboard');
      expect(dash.status).toBe(200);
      const recent: any[] = dash.body.data.recentProjects;
      expect(recent.map((r) => r.id)).toContain(opp.id);
      for (const r of recent) {
        const d = await detail(h, uniUser, r.id);
        expect(d.status).toBe(201);
        expect(d.body.data.viewer_access.can_edit).toBe(false);
      }
      const d = await detail(h, uniUser, opp.id);
      expect(d.body.data.creator?.email ?? null).toBeNull(); // no student contact leak
      expect(JSON.stringify(d.body.data.supervision ?? {})).not.toContain(fac.email);
      // no action rights come with read access
      expect((await h.as(uniUser).post(`/partners/approvals/${opp.id}/approve`).send({})).status).toBe(403);
      expect((await h.as(uniUser).post('/opportunities/update').send({ id: opp.id, title: 'Renamed by uni' })).status).toBe(403);
      // negatives
      expect(idsOf(await h.as(otherUni).get('/opportunities?partner_id=me'))).not.toContain(opp.id);
      expect((await detail(h, otherUni, opp.id)).status).toBe(404);
      expect((await detail(h, ngo, opp.id)).status).toBe(404);
    });

    it('report on a university-scope opportunity: /partner/reports lists it, /partner/reports/:id opens it read-only (viewer_can_review=false), verify stays 403', async () => {
      const uniName = `Report Uni ${uniq()}`;
      const uniOrg = await h.makeOrg(uniName, 'UNIVERSITY');
      const uniUser = await h.makeUser(UserRole.UNIVERSITY, { org: uniOrg });
      const otherUni = await h.makeUser(UserRole.UNIVERSITY, { org: await h.makeOrg(`Alien Uni ${uniq()}`, 'UNIVERSITY') });
      const { user: hostNgo } = await ngoWithOrg();
      const student = await h.makeUser(UserRole.STUDENT, { overrides: { university: uniName } as any });
      const opp = await orgCreate(hostNgo, oppPayload());
      await adminApprove(h, admin, opp.id);
      // the university's student created / participates on this NGO listing
      await h.opps.update(opp.id, { creatorId: student.id } as any).catch(() => undefined);
      const reports = h.ds.getRepository(StudentReport);
      const rep = await reports.save(
        reports.create({
          studentId: student.id,
          opportunityId: opp.id,
          project_id: opp.id,
          status: 'submitted',
          faculty_status: 'approved',
          partner_status: 'pending',
        } as any) as unknown as StudentReport,
      );
      const list = await h.as(uniUser).get('/partner/reports?limit=50');
      expect(list.status).toBe(200);
      expect(((list.body.data ?? []) as any[]).map((r) => r.id)).toContain(rep.id);
      const open = await h.as(uniUser).get(`/partner/reports/${rep.id}`);
      expect(open.status).toBe(200);
      expect(open.body.data.viewer_can_review).toBe(false);
      expect((await h.as(uniUser).patch(`/partner/reports/${rep.id}/verify`).send({ action: 'approve' })).status).toBe(403);
      // negatives: another university / the host NGO's own view is a review view
      expect((await h.as(otherUni).get(`/partner/reports/${rep.id}`)).status).toBe(403);
      const host = await h.as(hostNgo).get(`/partner/reports/${rep.id}`);
      expect(host.status).toBe(200);
      expect(host.body.data.viewer_can_review).toBe(true);
    });
  });

  // ------------------------------------------------------------------ student
  describe('student: creator / participant / applicant can open what their own lists show', () => {
    it('a pending join request keeps the (non-public) listing openable for that student only', async () => {
      const { user: ngo } = await ngoWithOrg();
      const applicant = await h.makeUser(UserRole.STUDENT);
      const other = await h.makeUser(UserRole.STUDENT);
      const opp = await orgCreate(ngo, oppPayload());
      await adminApprove(h, admin, opp.id);
      const apps = h.ds.getRepository(OpportunityApplication);
      await apps.save(
        apps.create({ opportunityId: opp.id, studentUserId: applicant.id, internalStatus: 'pending_faculty', primaryFacultyEmail: 'x@y.test', applyPayload: {} } as any),
      );
      // listing leaves the public directory (closed)
      await h.opps.update(opp.id, { status: 'closed', workflowStage: 'closed' } as any);
      expect((await detail(h, applicant, opp.id)).status).toBe(201);
      expect((await detail(h, other, opp.id)).status).toBe(404);
    });

    it('creator opens own pipeline row; a different student cannot', async () => {
      const s1 = await h.makeUser(UserRole.STUDENT);
      const s2 = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const opp = await studentSubmit(s1, fac.email);
      expect(idsOf(await h.as(s1).get('/student/opportunity/mine'))).toContain(opp.id);
      expect((await detail(h, s1, opp.id)).status).toBe(201);
      expect((await detail(h, s2, opp.id)).status).toBe(404);
    });
  });

  describe('student endpoints by opportunity id: same visibility as POST /opportunities/detail', () => {
    const project = (u: E2eUser, id: string) => h.as(u).get(`/student/projects/${id}`);
    const guide = (u: E2eUser, id: string) => h.as(u).get(`/student/opportunities/${id}/participation-guide`);

    it('GET /student/projects/:id: someone else\'s pending / draft / rejected / unapproved rows are 404; live, own, applied, participating and admin open', async () => {
      const { user: ngo } = await ngoWithOrg();
      const owner = await h.makeUser(UserRole.STUDENT);
      const stranger = await h.makeUser(UserRole.STUDENT);
      const applicant = await h.makeUser(UserRole.STUDENT);
      const member = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);

      const pendingStudentRow = await studentSubmit(owner, fac.email);
      const unapprovedOrgRow = await orgCreate(ngo, oppPayload());
      const draftRes = await h.as(owner).post('/student/opportunity').send({ ...studentPayload(fac.email), draft: true });
      const draftId = draftRes.body?.data?.id ?? draftRes.body?.id;
      const rejectedRow = await orgCreate(ngo, oppPayload());
      await h.opps.update(rejectedRow.id, { status: 'rejected', workflowStage: 'rejected' } as any);
      const live = await orgCreate(ngo, oppPayload());
      expect((await adminApprove(h, admin, live.id)).status).toBeLessThan(300);

      // strangers: non-public rows are not readable, and 404 is indistinguishable from "no such id"
      const hidden = [pendingStudentRow.id, unapprovedOrgRow.id, rejectedRow.id, ...(draftId ? [draftId] : [])];
      for (const id of hidden) expect((await project(stranger, id)).status).toBe(404);
      expect((await project(stranger, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
      // owner still opens their own; admin opens anything
      const own = await project(owner, pendingStudentRow.id);
      expect(own.status).toBe(200);
      expectNoSecrets(own, 'own project');
      for (const id of hidden) expect((await project(admin, id)).status).toBe(200);
      if (draftId) expect((await project(owner, draftId)).status).toBe(200);

      // live public row: anyone can open, but reviewer contact details are stripped
      const pub = await project(stranger, live.id);
      expect(pub.status).toBe(200);
      expectNoSecrets(pub, 'public project');
      expect(pub.body.data.id).toBe(live.id);

      // applied / participating students keep access after the listing leaves the public directory
      const apps = h.ds.getRepository(OpportunityApplication);
      await apps.save(
        apps.create({ opportunityId: live.id, studentUserId: applicant.id, internalStatus: 'pending_faculty', primaryFacultyEmail: 'x@y.test', applyPayload: {} } as any),
      );
      await h.ds.getRepository(Participation).save(
        h.ds.getRepository(Participation).create({ studentId: member.id, projectId: live.id, status: 'approved', fullName: 'Member One', mobile: '03001234567', email: member.email, cnicHash: `h${uniq()}`, cnic: 'enc', cnicLast4: '0000' } as any),
      );
      await h.opps.update(live.id, { status: 'closed', workflowStage: 'closed' } as any);
      expect((await project(applicant, live.id)).status).toBe(200);
      expect((await project(member, live.id)).status).toBe(200);
      expect((await project(stranger, live.id)).status).toBe(404);
    });

    it('GET /student/projects/:id redacts supervisor / partner contact details for non-reviewers but not for the owner', async () => {
      const owner = await h.makeUser(UserRole.STUDENT);
      const stranger = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const opp = await studentSubmit(owner, fac.email);
      // make it public-live so the stranger may open it at all
      await h.opps.update(opp.id, { status: 'live', workflowStage: 'live', admin_approved: true, faculty_verified: true } as any);
      const seenByOwner = await project(owner, opp.id);
      expect(seenByOwner.status).toBe(200);
      expect(JSON.stringify(seenByOwner.body.data.supervision ?? {})).toContain(fac.email);
      const seenByStranger = await project(stranger, opp.id);
      expect(seenByStranger.status).toBe(200);
      expect(JSON.stringify(seenByStranger.body)).not.toContain(fac.email);
      expectNoSecrets(seenByStranger, 'stranger view');
    });

    it('GET /student/opportunities/:id/participation-guide: hidden rows are 404 for strangers, visible for owner / live browsing', async () => {
      const { user: ngo } = await ngoWithOrg();
      const owner = await h.makeUser(UserRole.STUDENT);
      const stranger = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const pending = await studentSubmit(owner, fac.email);
      const live = await orgCreate(ngo, oppPayload());
      await adminApprove(h, admin, live.id);
      expect((await guide(stranger, pending.id)).status).toBe(404);
      expect((await guide(owner, pending.id)).status).toBe(200);
      expect((await guide(stranger, live.id)).status).toBe(200);
    });

    it('GET /students/reports/:id: university reads only its scope (read-only), foreign university / stranger student are refused, NGO host reviews', async () => {
      const uniName = `RptRole Uni ${uniq()}`;
      const uniUser = await h.makeUser(UserRole.UNIVERSITY, { org: await h.makeOrg(uniName, 'UNIVERSITY') });
      const otherUni = await h.makeUser(UserRole.UNIVERSITY, { org: await h.makeOrg(`RptRole Alien ${uniq()}`, 'UNIVERSITY') });
      const { user: hostNgo } = await ngoWithOrg();
      const student = await h.makeUser(UserRole.STUDENT, { overrides: { university: uniName } as any });
      const stranger = await h.makeUser(UserRole.STUDENT);
      const opp = await orgCreate(hostNgo, oppPayload());
      await adminApprove(h, admin, opp.id);
      await h.opps.update(opp.id, { creatorId: student.id } as any).catch(() => undefined);
      const reports = h.ds.getRepository(StudentReport);
      const rep = await reports.save(
        reports.create({ studentId: student.id, opportunityId: opp.id, project_id: opp.id, status: 'submitted', faculty_status: 'approved', partner_status: 'pending' } as any) as unknown as StudentReport,
      );
      const uni = await h.as(uniUser).get(`/students/reports/${rep.id}`);
      expect(uni.status).toBe(200);
      expect(uni.body.data.viewer_can_review).toBe(false);
      expect((await h.as(otherUni).get(`/students/reports/${rep.id}`)).status).toBe(403);
      const host = await h.as(hostNgo).get(`/students/reports/${rep.id}`);
      expect(host.status).toBe(200);
      expect(host.body.data.viewer_can_review).toBe(true);
      // a stranger student gets an empty placeholder, never the report
      const strangerRead = await h.as(stranger).get(`/students/reports/${rep.id}`);
      expect(strangerRead.body?.data ?? null).toBeNull();
      expect((await h.as(student).get(`/students/reports/${rep.id}`)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ admin
  describe('admin: queue flag == approve gate', () => {
    it('every queue row with admin_can_approve=true approves; every false row is refused with 400', async () => {
      const { user: ngo } = await ngoWithOrg();
      const fac = await h.makeUser(UserRole.FACULTY);
      const ready = await orgCreate(ngo, oppPayload());
      const waiting = await orgCreate(ngo, oppPayload({ supervision: { contact: fac.email } }));
      const queue = (await h.as(admin).get('/admin/opportunities/approval-queue?queue=pending')).body.data as any[];
      const readyRow = queue.find((r) => r.id === ready.id);
      expect(readyRow.admin_can_approve).toBe(true);
      expect((await adminQueueIds(h, admin)).includes(waiting.id)).toBe(false); // faculty gate open: not on the CIEL queue
      expect((await adminApprove(h, admin, waiting.id)).status).toBe(400);
      expect((await adminApprove(h, admin, ready.id)).status).toBe(201);
      expect((await detail(h, admin, waiting.id)).status).toBe(201);
    });
  });
});

import { bootHarness, Harness, E2eUser, oppPayload, studentPayload, uniq } from './e2e/harness';
import { adminApprove, adminQueueIds, detail, expectNoSecrets, verifyToken } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { FacultyUniversityScopeAssignment } from '../src/faculty-university-scope/entities/faculty-university-scope-assignment.entity';
import { OpportunityApplication } from '../src/opportunities/entities/opportunity-application.entity';
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

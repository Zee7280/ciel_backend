/**
 * Faculty ↔ University scope, end to end on a real database:
 * - students are matched to the delegated university by the same spelling-tolerant rule as apply
 *   eligibility ("BNU", "Beaconhouse  National University (BNU)") or by an account link to the org;
 * - every application the delegated faculty sees as "can decide" can actually be approved, and a
 *   student of another university can not;
 * - a university can not take over a faculty already authorised for another university.
 */
import { DeepPartial } from 'typeorm';
import { UserRole } from '../src/users/enums/user-role.enum';
import { User } from '../src/users/entities/user.entity';
import { Organization } from '../src/organizations/entities/organization.entity';
import { Opportunity } from '../src/opportunities/entities/opportunity.entity';
import { OpportunityApplication } from '../src/opportunities/entities/opportunity-application.entity';
import { FacultyUniversityScopeService } from '../src/faculty-university-scope/faculty-university-scope.service';
import { FacultyUniversityScopeAssignment } from '../src/faculty-university-scope/entities/faculty-university-scope-assignment.entity';
import { Participation } from '../src/engagement/entities/participant.entity';
import { OrganizationsService } from '../src/organizations/organizations.service';
import { Section1AnalyticsService } from '../src/analytics/section1-analytics.service';
import { bootHarness, Harness, E2eUser, oppPayload } from './e2e/harness';
import { adminApprove } from './e2e/helpers';

type ListRow = {
  id: string;
  student_email?: string;
  can_decide?: boolean;
};
type ListBody = { data: ListRow[] };
type AdminListRow = {
  faculty_user_id?: string;
  university_organization_id?: string;
  assigned_by_name?: string | null;
  assigned_by_email?: string | null;
  assigned_by_role?: string | null;
};

describe('Faculty ↔ University scope (e2e)', () => {
  let h: Harness;
  let admin: E2eUser;
  let bnu: Organization;
  let lums: Organization;
  let delegate: E2eUser;
  let primaryFaculty: E2eUser;
  let bnuOperator: E2eUser;
  let lumsOperator: E2eUser;
  let opp: Opportunity;
  const apps: Record<string, string> = {};
  const students: Record<string, E2eUser> = {};

  const BNU_NAME = 'Beaconhouse National University (BNU)';

  const liveOpp = async () => {
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const res = await h.as(ngo).post('/opportunities').send(oppPayload());
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    await adminApprove(h, admin, id);
    await h.opps.update(id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
    } as DeepPartial<Opportunity>);
    return h.reload(id);
  };

  const applyAs = async (key: string, s: E2eUser, opportunityId: string) => {
    const repo = h.ds.getRepository(OpportunityApplication);
    const row = await repo.save(
      repo.create({
        opportunityId,
        studentUserId: s.id,
        internalStatus: 'pending_faculty',
        // Someone else is the primary supervisor, so only the delegated scope can grant access.
        primaryFacultyEmail: primaryFaculty.email,
        applyPayload: {},
      } as DeepPartial<OpportunityApplication>),
    );
    apps[key] = row.id;
    return row.id;
  };

  const pendingFor = async (u: E2eUser) => {
    const res = await h.as(u).get('/faculty/applications?status=pending');
    expect(res.status).toBe(200);
    return (res.body as ListBody).data;
  };

  const scopeRow = async () =>
    h.ds.getRepository(FacultyUniversityScopeAssignment).findOne({
      where: { facultyUser: { id: delegate.id } },
      relations: ['universityOrganization'],
    });

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    bnu = await h.makeOrg(BNU_NAME, 'UNIVERSITY');
    lums = await h.makeOrg(
      'Lahore University of Management Sciences (LUMS)',
      'UNIVERSITY',
    );
    delegate = await h.makeUser(UserRole.FACULTY);
    primaryFaculty = await h.makeUser(UserRole.FACULTY);
    bnuOperator = await h.makeUser(UserRole.UNIVERSITY, { org: bnu });
    lumsOperator = await h.makeUser(UserRole.UNIVERSITY, { org: lums });

    const mk = (university: string, org?: Organization) =>
      h.makeUser(UserRole.STUDENT, {
        org: org ?? null,
        overrides: { university, institution: '' } as Partial<User>,
      });
    students.full = await mk(BNU_NAME);
    students.abbr = await mk('BNU');
    students.spaced = await mk('Beaconhouse  National University (BNU)');
    students.linked = await mk('', bnu);
    students.lums = await mk('LUMS');
    students.lahoreSuffix = await mk('Beaconhouse National University, Lahore');

    opp = await liveOpp();
    for (const [key, s] of Object.entries(students)) {
      await applyAs(key, s, opp.id);
    }
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('before any assignment the faculty sees none of these applications', async () => {
    const ids = (await pendingFor(delegate)).map((r) => r.id);
    for (const id of Object.values(apps)) expect(ids).not.toContain(id);
    const res = await h
      .as(delegate)
      .post(`/faculty/applications/${apps.abbr}/approve`);
    expect(res.status).toBe(403);
  });

  it('admin assigns the scope; the list says who assigned it', async () => {
    const res = await h
      .as(admin)
      .post('/admin/faculty-university-scope')
      .send({ facultyUserId: delegate.id, universityOrganizationId: bnu.id });
    expect(res.status).toBe(201);

    const list = await h.as(admin).get('/admin/faculty-university-scope');
    expect(list.status).toBe(200);
    const row = (list.body as { data: AdminListRow[] }).data.find(
      (r) => r.faculty_user_id === delegate.id,
    );
    expect(row?.university_organization_id).toBe(bnu.id);
    expect(row?.assigned_by_email).toBe(admin.email);
    expect(row?.assigned_by_name).toBeTruthy();
    expect(row?.assigned_by_role).toBe(UserRole.SUPER_ADMIN);
  });

  it('lists every BNU student by any spelling or by org link, and nobody else', async () => {
    const rows = await pendingFor(delegate);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const key of ['full', 'abbr', 'spaced', 'linked']) {
      expect(byId.has(apps[key])).toBe(true);
      expect(byId.get(apps[key])?.can_decide).toBe(true);
    }
    expect(byId.has(apps.lums)).toBe(false);
    expect(byId.has(apps.lahoreSuffix)).toBe(false);
  });

  it('can approve every application it may decide (no list/approve mismatch)', async () => {
    for (const key of ['abbr', 'spaced', 'linked']) {
      const res = await h
        .as(delegate)
        .post(`/faculty/applications/${apps[key]}/approve`);
      expect(res.status).toBeLessThan(300);
      const row = await h.ds
        .getRepository(OpportunityApplication)
        .findOne({ where: { id: apps[key] } });
      expect(row?.internalStatus).toBe('pending_admin');
      expect(row?.facultyDecidedBy).toBe(delegate.id);
    }
  });

  it('can reject a BNU application', async () => {
    const res = await h
      .as(delegate)
      .post(`/faculty/applications/${apps.full}/reject`)
      .send({ reason: 'Not a fit for this cohort' });
    expect(res.status).toBeLessThan(300);
  });

  it('can NOT approve or reject a student of another university', async () => {
    for (const key of ['lums', 'lahoreSuffix']) {
      const ok = await h
        .as(delegate)
        .post(`/faculty/applications/${apps[key]}/approve`);
      expect(ok.status).toBe(403);
      const no = await h
        .as(delegate)
        .post(`/faculty/applications/${apps[key]}/reject`)
        .send({ reason: 'x' });
      expect(no.status).toBe(403);
      const row = await h.ds
        .getRepository(OpportunityApplication)
        .findOne({ where: { id: apps[key] } });
      expect(row?.internalStatus).toBe('pending_faculty');
    }
  });

  it('opportunity visibility uses the same tolerant match (SQL path)', async () => {
    const scope = h.app.get(FacultyUniversityScopeService);
    // Only an abbreviation-spelling student applied to this one.
    const onlyAbbr = await liveOpp();
    const s = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: 'bnu', institution: '' } as Partial<User>,
    });
    await applyAs('onlyAbbr', s, onlyAbbr.id);
    // Only a LUMS student applied to this one.
    const onlyLums = await liveOpp();
    const l = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: 'LUMS', institution: '' } as Partial<User>,
    });
    await applyAs('onlyLums', l, onlyLums.id);

    const ids = await scope.resolveOpportunityIdsForUniversityOrganization(
      bnu.id,
    );
    expect(ids).toContain(onlyAbbr.id);
    expect(ids).not.toContain(onlyLums.id);
  });

  it('another university can NOT take over this faculty (409), and nothing changes', async () => {
    const res = await h
      .as(lumsOperator)
      .post('/partners/community-service/faculty-representatives')
      .send({ faculty_email: delegate.email });
    expect(res.status).toBe(409);
    expect(String((res.body as { message?: string }).message)).toMatch(
      /another university/i,
    );
    expect((await scopeRow())?.universityOrganization?.id).toBe(bnu.id);
    // The delegate keeps working for BNU: a new BNU application shows up and can be decided.
    const s = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: 'BNU', institution: '' } as Partial<User>,
    });
    const id = await applyAs('afterTakeover', s, opp.id);
    const row = (await pendingFor(delegate)).find((r) => r.id === id);
    expect(row?.can_decide).toBe(true);
  });

  it('its own university can re-confirm the faculty without changing the scope', async () => {
    const res = await h
      .as(bnuOperator)
      .post('/partners/community-service/faculty-representatives')
      .send({ faculty_email: delegate.email });
    expect(res.status).toBe(201);
    expect((await scopeRow())?.universityOrganization?.id).toBe(bnu.id);
    const list = await h.as(admin).get('/admin/faculty-university-scope');
    const row = (list.body as { data: AdminListRow[] }).data.find(
      (r) => r.faculty_user_id === delegate.id,
    );
    // Re-confirming changes nothing: the admin who granted the scope stays on record.
    expect(row?.assigned_by_role).toBe(UserRole.SUPER_ADMIN);
    expect(row?.assigned_by_email).toBe(admin.email);
  });

  it('a university can still authorise an unassigned faculty of its own', async () => {
    const fresh = await h.makeUser(UserRole.FACULTY);
    const res = await h
      .as(lumsOperator)
      .post('/partners/community-service/faculty-representatives')
      .send({ faculty_email: fresh.email });
    expect(res.status).toBe(201);
  });

  it('CIEL PK admin can still move the faculty; access follows the new university', async () => {
    const res = await h
      .as(admin)
      .post('/admin/faculty-university-scope')
      .send({ facultyUserId: delegate.id, universityOrganizationId: lums.id });
    expect(res.status).toBe(201);
    expect((await scopeRow())?.universityOrganization?.id).toBe(lums.id);

    const ids = (await pendingFor(delegate)).map((r) => r.id);
    expect(ids).toContain(apps.lums);
    expect(ids).not.toContain(apps.lahoreSuffix);
    const lumsOk = await h
      .as(delegate)
      .post(`/faculty/applications/${apps.lums}/approve`);
    expect(lumsOk.status).toBeLessThan(300);
  });

  it('after removal the faculty loses delegated access', async () => {
    // A pending application the delegate can provably decide right now (scope is LUMS here) …
    const s = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: 'LUMS', institution: '' } as Partial<User>,
    });
    const id = await applyAs('beforeRemoval', s, opp.id);
    expect(
      (await pendingFor(delegate)).find((r) => r.id === id)?.can_decide,
    ).toBe(true);

    const del = await h
      .as(admin)
      .del(`/admin/faculty-university-scope/${delegate.id}`);
    expect(del.status).toBe(200);
    expect(await scopeRow()).toBeNull();

    // … is gone from the list and can no longer be decided.
    expect((await pendingFor(delegate)).map((r) => r.id)).not.toContain(id);
    const res = await h
      .as(delegate)
      .post(`/faculty/applications/${id}/approve`);
    expect(res.status).toBe(403);
    const row = await h.ds
      .getRepository(OpportunityApplication)
      .findOne({ where: { id } });
    expect(row?.internalStatus).toBe('pending_faculty');
  });

  it('university dashboards count the same students the scope sees (no opportunity-without-students)', async () => {
    type AffiliatedIds = {
      resolveUniversityAffiliatedStudentIds(
        orgId: string,
        orgName: string,
      ): Promise<Set<string>>;
    };
    type ScopedParticipations = {
      loadUniversityScopedParticipations(
        orgId: string,
      ): Promise<Array<{ student?: { id: string } | null }>>;
    };
    // Private query helpers, reached through the typed view of the two services.
    const orgs = h.app.get<unknown, AffiliatedIds>(OrganizationsService);
    const section1 = h.app.get<unknown, ScopedParticipations>(
      Section1AnalyticsService,
    );
    const dashOpp = await liveOpp();
    const join = async (s: E2eUser) => {
      const repo = h.ds.getRepository(Participation);
      await repo.save(
        repo.create({
          projectId: dashOpp.id,
          student: { id: s.id },
          fullName: 'Dash Student',
          mobile: '+923001234567',
          email: s.email,
        } as DeepPartial<Participation>),
      );
    };
    const bnuAbbr = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: 'BNU', institution: '' } as Partial<User>,
    });
    const bnuLinked = await h.makeUser(UserRole.STUDENT, {
      org: bnu,
      overrides: { university: '', institution: '' } as Partial<User>,
    });
    const lumsStudent = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: 'LUMS', institution: '' } as Partial<User>,
    });
    for (const s of [bnuAbbr, bnuLinked, lumsStudent]) await join(s);

    // The opportunity is in BNU's scope …
    const scope = h.app.get(FacultyUniversityScopeService);
    expect(
      await scope.resolveOpportunityIdsForUniversityOrganization(bnu.id),
    ).toContain(dashOpp.id);
    // … and so are its BNU students (any spelling or org link), never the LUMS one.
    const affiliated = await orgs.resolveUniversityAffiliatedStudentIds(
      bnu.id,
      bnu.name,
    );
    expect(affiliated.has(bnuAbbr.id)).toBe(true);
    expect(affiliated.has(bnuLinked.id)).toBe(true);
    expect(affiliated.has(lumsStudent.id)).toBe(false);

    const scoped = (
      await section1.loadUniversityScopedParticipations(bnu.id)
    ).map((p) => p.student?.id);
    expect(scoped).toContain(bnuAbbr.id);
    expect(scoped).toContain(bnuLinked.id);
    expect(scoped).not.toContain(lumsStudent.id);
  });

  it('non-admins can not use the admin endpoints', async () => {
    for (const u of [delegate, bnuOperator, students.abbr]) {
      const res = await h
        .as(u)
        .post('/admin/faculty-university-scope')
        .send({ facultyUserId: delegate.id, universityOrganizationId: bnu.id });
      expect(res.status).toBe(403);
    }
  });
});

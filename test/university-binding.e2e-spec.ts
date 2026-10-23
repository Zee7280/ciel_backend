/**
 * University ↔ students ↔ faculty binding, end to end on a real database. One rule decides who
 * belongs to a university (FacultyUniversityScopeService / university-affiliation.util), and every
 * university view must agree with it:
 * - its own students' reports are listed, another university's students on the same listing are
 *   not — even when they typed this university on their seat;
 * - a blank profile is completed by the university entered on the project seat;
 * - faculty registered at the university wait under "awaiting" and can be authorised in one call;
 *   a faculty registered at another listed university is refused;
 * - opportunities an authorised faculty publishes belong to the university;
 * - an admin can rename an off-list university ("uni") to its listed name, never to free text.
 */
import { DeepPartial } from 'typeorm';
import { UserRole } from '../src/users/enums/user-role.enum';
import { Opportunity } from '../src/opportunities/entities/opportunity.entity';
import { Participation } from '../src/engagement/entities/participant.entity';
import { StudentReport } from '../src/reports/entities/student-report.entity';
import { Organization } from '../src/organizations/entities/organization.entity';
import { bootHarness, Harness, E2eUser, oppPayload } from './e2e/harness';
import { adminApprove } from './e2e/helpers';

type Row = { id: string };
type ListBody = { data: Row[] };
type RepRow = { faculty_user_id?: string; faculty_email?: string };

const GIFT = 'GIFT University';

describe('University binding (e2e)', () => {
  let h: Harness;
  let admin: E2eUser;
  let gift: Organization;
  let operator: E2eUser;
  let sharedOpp: string;
  const reportIds: Record<string, string> = {};
  const studentEmails: Record<string, string> = {};

  const liveOpp = async (): Promise<string> => {
    const ngo = await h.makeUser(UserRole.NGO, { org: await h.makeOrg() });
    const res = await h.as(ngo).post('/opportunities').send(oppPayload());
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    await adminApprove(h, admin, id);
    await h.opps.update(id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
    } as DeepPartial<Opportunity>);
    return id;
  };

  const studentWithReport = async (
    key: string,
    profileUniversity: string,
    seatUniversity: string,
  ) => {
    const student = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: profileUniversity, institution: '' },
    });
    studentEmails[key] = student.email;
    const seats = h.ds.getRepository(Participation);
    await seats.save(
      seats.create({
        projectId: sharedOpp,
        studentId: student.id,
        email: student.email,
        mobile: '+923005550000',
        cnic: 'enc',
        cnicHash: `hash-${student.email}`,
        cnicLast4: '0000',
        universityId: 'roll-1',
        universityName: seatUniversity,
        academicProgram: 'BS CS',
        yearOfStudy: '3rd Year',
        department: 'Computer Science',
        fullName: key,
        status: 'approved',
        participationMode: 'team',
        teamId: `team-${key}`,
      } as DeepPartial<Participation>),
    );
    const reports = h.ds.getRepository(StudentReport);
    const report = await reports.save(
      reports.create({
        studentId: student.id,
        opportunityId: sharedOpp,
        project_id: sharedOpp,
        status: 'submitted',
        reportSubmittedAt: new Date(),
        submission_date: new Date(),
        section1: { team_lead: { name: key } },
      } as DeepPartial<StudentReport>),
    );
    reportIds[key] = report.id;
  };

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    gift = await h.makeOrg(GIFT, 'university');
    operator = await h.makeUser(UserRole.UNIVERSITY, { org: gift });
    sharedOpp = await liveOpp();
    await studentWithReport('own', GIFT, GIFT);
    await studentWithReport('blank-profile', '', GIFT);
    // Typed GIFT on the seat, but the profile is another listed university.
    await studentWithReport('other-school', 'Aga Khan University', GIFT);
  });

  afterAll(async () => {
    await h?.app.close();
  });

  it("lists its own students' reports on a shared listing, never another university's", async () => {
    const res = await h.as(operator).get('/partner/reports?limit=200');
    expect(res.status).toBe(200);
    const ids = (res.body as ListBody).data.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([reportIds['own'], reportIds['blank-profile']]),
    );
    expect(ids).not.toContain(reportIds['other-school']);

    const other = await h
      .as(operator)
      .get(`/partner/reports/${reportIds['other-school']}`);
    expect(other.status).toBe(403);
    const own = await h
      .as(operator)
      .get(`/partner/reports/${reportIds['own']}`);
    expect(own.status).toBe(200);
  });

  it('faculty registered at the university wait under "awaiting" and are authorised in one call', async () => {
    const faculty = await h.makeUser(UserRole.FACULTY, {
      overrides: { university: GIFT },
    });
    const awaiting = await h
      .as(operator)
      .get('/partners/community-service/faculty-representatives/awaiting');
    expect(awaiting.status).toBe(200);
    expect(
      (awaiting.body as { data: RepRow[] }).data.map((r) => r.faculty_user_id),
    ).toContain(faculty.id);

    const authorise = await h
      .as(operator)
      .post('/partners/community-service/faculty-representatives')
      .send({ faculty_email: faculty.email });
    expect(authorise.status).toBe(201);

    const after = await h
      .as(operator)
      .get('/partners/community-service/faculty-representatives/awaiting');
    expect(
      (after.body as { data: RepRow[] }).data.map((r) => r.faculty_user_id),
    ).not.toContain(faculty.id);

    // What that faculty publishes belongs to the university's dashboard.
    const published = await liveOpp();
    await h.opps.update(published, {
      creatorId: faculty.id,
    } as DeepPartial<Opportunity>);
    const list = await h.as(operator).get('/opportunities?partner_id=me');
    expect(list.status).toBe(200);
    expect((list.body as ListBody).data.map((o) => o.id)).toContain(published);
  });

  it('refuses a faculty registered at another listed university', async () => {
    const elsewhere = await h.makeUser(UserRole.FACULTY, {
      overrides: { university: 'Aga Khan University' },
    });
    const res = await h
      .as(operator)
      .post('/partners/community-service/faculty-representatives')
      .send({ faculty_email: elsewhere.email });
    expect(res.status).toBe(400);
  });

  it('a faculty delegated by CIEL PK admin sees the same students and reports as the university', async () => {
    const delegate = await h.makeUser(UserRole.FACULTY, {
      overrides: { university: GIFT },
    });
    // Before the assignment: nothing of this listing is theirs.
    const before = await h.as(delegate).get('/faculty/reports');
    expect(before.status).toBe(200);
    expect((before.body as ListBody).data.map((r) => r.id)).not.toContain(
      reportIds['own'],
    );

    const assign = await h
      .as(admin)
      .post('/admin/faculty-university-scope')
      .send({ facultyUserId: delegate.id, universityOrganizationId: gift.id });
    expect(assign.status).toBe(201);

    const dash = await h.as(delegate).get('/faculty/dashboard?view=university');
    expect(dash.status).toBe(200);
    expect(
      (
        dash.body as {
          data: { university_scope?: { organization_name?: string } };
        }
      ).data.university_scope?.organization_name,
    ).toBe(GIFT);

    const list = await h.as(delegate).get('/faculty/reports');
    expect(list.status).toBe(200);
    const ids = (list.body as ListBody).data.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([reportIds['own'], reportIds['blank-profile']]),
    );
    expect(ids).not.toContain(reportIds['other-school']);

    expect(
      (await h.as(delegate).get(`/faculty/reports/${reportIds['own']}`)).status,
    ).toBe(200);
    expect(
      (
        await h
          .as(delegate)
          .get(`/faculty/reports/${reportIds['other-school']}`)
      ).status,
    ).toBe(404);

    const tracking = await h
      .as(delegate)
      .get('/faculty/community-service/tracking');
    expect(tracking.status).toBe(200);
    const tracked = (
      tracking.body as { data: Array<{ student_email?: string | null }> }
    ).data.map((r) => String(r.student_email || ''));
    expect(tracked).toEqual(
      expect.arrayContaining([
        studentEmails['own'],
        studentEmails['blank-profile'],
      ]),
    );
    expect(tracked).not.toContain(studentEmails['other-school']);

    // Removing the delegation takes the access away again.
    await h.as(admin).del(`/admin/faculty-university-scope/${delegate.id}`);
    expect(
      (await h.as(delegate).get(`/faculty/reports/${reportIds['own']}`)).status,
    ).toBe(404);
  });

  it('an admin renames an off-list university to its listed name, never to free text', async () => {
    const uni = await h.makeOrg('uni', 'university');
    const staff = await h.makeUser(UserRole.UNIVERSITY, { org: uni });

    const freeText = await h
      .as(admin)
      .patch(`/admin/organizations/${uni.id}/name`)
      .send({ name: 'uni 2' });
    expect(freeText.status).toBe(400);

    const taken = await h
      .as(admin)
      .patch(`/admin/organizations/${uni.id}/name`)
      .send({ name: GIFT });
    expect(taken.status).toBe(409);

    const ok = await h
      .as(admin)
      .patch(`/admin/organizations/${uni.id}/name`)
      .send({ name: 'gomal university' });
    expect(ok.status).toBe(200);
    expect((await h.orgs.findOneOrFail({ where: { id: uni.id } })).name).toBe(
      'Gomal University',
    );
    expect(
      (await h.users.findOneOrFail({ where: { id: staff.id } })).orgName,
    ).toBe('Gomal University');
  });
});

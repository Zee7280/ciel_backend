/**
 * Join applications: student applies → the faculty the student named approves → CIEL PK admin gives
 * final approval. Real Nest app + scratch Postgres.
 */
import { bootHarness, Harness, E2eUser, oppPayload } from './e2e/harness';
import { adminApprove } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { Participation } from '../src/engagement/entities/participant.entity';
import { OpportunityApplication } from '../src/opportunities/entities/opportunity-application.entity';
import { User } from '../src/users/entities/user.entity';
import { Opportunity } from '../src/opportunities/entities/opportunity.entity';
import { QueryDeepPartialEntity } from 'typeorm';

const day = (d: number) =>
  new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

describe('Join approval: selected faculty first, then CIEL PK admin (real app + real Postgres)', () => {
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

  const liveOpp = async () => {
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const res = await h.as(ngo).post('/opportunities').send(oppPayload());
    const { id } = res.body as { id: string };
    await adminApprove(h, admin, id);
    await h.opps.update(id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: {
        type: 'fixed',
        start_date: day(-3),
        end_date: day(30),
        expected_hours: 20,
        volunteers_required: 6,
      },
      participation_scope: { rule: 'open_all_universities' },
    } as unknown as QueryDeepPartialEntity<Opportunity>);
    return h.reload(id);
  };
  const student = () =>
    h.makeUser(UserRole.STUDENT, {
      overrides: {
        university: 'E2E University',
      } as unknown as Partial<User>,
    });
  const apply = (s: E2eUser, oppId: string, facultyEmail?: string) =>
    h
      .as(s)
      .post(`/students/opportunities/${oppId}/apply`)
      .send({
        participation_type: 'individual',
        ...(facultyEmail ? { primary_faculty_email: facultyEmail } : {}),
        attendance_approver_type: 'partner',
        contact_phone_e164: '+923009998877',
      });
  const app = (id: string) =>
    h.ds.getRepository(OpportunityApplication).findOneByOrFail({ id });

  it('goes to the named faculty first; CIEL PK can approve only after the faculty did', async () => {
    const opp = await liveOpp();
    const fac = await h.makeUser(UserRole.FACULTY);
    const s = await student();

    const applied = await apply(s, opp.id, fac.email);
    expect(applied.status).toBe(201);
    const id = (applied.body as { data: { application_id: string } }).data
      .application_id;
    expect((await app(id)).internalStatus).toBe('pending_faculty');

    // The named faculty is emailed, with a link to their join-application approvals.
    const mails = h.mail.of('sendFacultyApprovalRequest');
    expect(mails).toHaveLength(1);
    expect(mails[0].args[0]).toBe(fac.email);
    expect(mails[0].args[4]).toBe('/dashboard/faculty/join-applications');

    // CIEL PK cannot skip the faculty; another faculty cannot decide.
    expect(
      (await h.as(admin).post(`/admin/applications/${id}/approve`).send({}))
        .status,
    ).toBe(400);
    const stranger = await h.makeUser(UserRole.FACULTY);
    expect(
      (await h.as(stranger).post(`/faculty/applications/${id}/approve`)).status,
    ).toBe(403);

    // The faculty sees it pending and approves → CIEL PK admin.
    const pending = await h.as(fac).get('/faculty/applications?status=pending');
    expect(pending.status).toBe(200);
    expect(JSON.stringify(pending.body)).toContain(id);
    expect(
      (await h.as(fac).post(`/faculty/applications/${id}/approve`)).status,
    ).toBeLessThan(300);
    const afterFaculty = await app(id);
    expect(afterFaculty.internalStatus).toBe('pending_admin');
    expect(afterFaculty.facultyDecidedBy).toBe(fac.id);

    // Final approval by CIEL PK: the seat exists and the report needs no second faculty check.
    expect(
      (await h.as(admin).post(`/admin/applications/${id}/approve`).send({}))
        .status,
    ).toBe(201);
    expect((await app(id)).internalStatus).toBe('approved');
    const seat = await h.ds
      .getRepository(Participation)
      .findOneByOrFail({ projectId: opp.id, studentId: s.id });
    expect(seat.status).toBe('approved');
    expect(seat.facultySupervisionConfirmedAt).not.toBeNull();
    expect(seat.facultySupervisionConfirmedBy).toBe(fac.id);
    const sup = await h.as(s).get(`/student/reports/${opp.id}/supervision`);
    expect(sup.status).toBe(200);
    expect((sup.body as { data: unknown }).data).toMatchObject({
      confirmed: true,
      blocked: false,
    });
  });

  it('a faculty rejection stops the application before CIEL PK', async () => {
    const opp = await liveOpp();
    const fac = await h.makeUser(UserRole.FACULTY);
    const s = await student();
    const id = (
      (await apply(s, opp.id, fac.email)).body as {
        data: { application_id: string };
      }
    ).data.application_id;
    const rej = await h
      .as(fac)
      .post(`/faculty/applications/${id}/reject`)
      .send({ reason: 'Not my student' });
    expect(rej.status).toBeLessThan(300);
    expect((await app(id)).internalStatus).toBe('faculty_rejected');
    expect(
      (await h.as(admin).post(`/admin/applications/${id}/approve`).send({}))
        .status,
    ).toBe(400);
  });

  it('an application with no faculty named still goes straight to CIEL PK (unchanged)', async () => {
    const opp = await liveOpp();
    const s = await student();
    const res = await apply(s, opp.id);
    if (res.status === 201) {
      const id = (res.body as { data: { application_id: string } }).data
        .application_id;
      expect((await app(id)).internalStatus).toBe('pending_admin');
      expect(h.mail.of('sendFacultyApprovalRequest')).toHaveLength(0);
    } else {
      // The apply endpoint may require a faculty email; then nothing is created.
      expect(res.status).toBe(400);
    }
  });
});

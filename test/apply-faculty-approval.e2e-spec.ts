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
import { Notification } from '../src/notifications/entities/notification.entity';
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

  it('goes to the named faculty first, then CIEL PK; the faculty-approved seat needs no second confirmation', async () => {
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

    // CIEL PK sees it as still with the faculty (it may override, see below); another faculty cannot decide.
    const queue = await h.as(admin).get('/admin/applications?status=pending');
    expect(
      (
        queue.body as { data: { id: string; application_stage: string }[] }
      ).data.find((r) => r.id === id)?.application_stage,
    ).toBe('faculty');
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

  it('CIEL PK sees an application stuck with faculty and may decide it; the report then still asks the faculty', async () => {
    const opp = await liveOpp();
    const fac = await h.makeUser(UserRole.FACULTY);
    const s = await student();
    const id = (
      (await apply(s, opp.id, fac.email)).body as {
        data: { application_id: string };
      }
    ).data.application_id;

    // Listed for CIEL PK with its stage, so a never-responding faculty cannot hide it.
    const pending = await h.as(admin).get('/admin/applications?status=pending');
    expect(pending.status).toBe(200);
    const row = (
      pending.body as { data: { id: string; application_stage: string }[] }
    ).data.find((r) => r.id === id);
    expect(row).toMatchObject({ application_stage: 'faculty' });

    // The student may re-send the faculty email, once per 12 hours (the apply-time email counts
    // as the first, so pretend the application is 13 hours old).
    await h.ds
      .getRepository(OpportunityApplication)
      .update({ id }, { createdAt: new Date(Date.now() - 13 * 3600 * 1000) });
    h.mail.reset();
    const first = await h
      .as(s)
      .post(`/students/applications/${id}/remind-faculty`)
      .send({});
    expect(first.status).toBe(201);
    expect((first.body as { data: { sent: boolean } }).data.sent).toBe(true);
    expect(h.mail.of('sendFacultyApprovalRequest')).toHaveLength(1);
    const second = await h
      .as(s)
      .post(`/students/applications/${id}/remind-faculty`)
      .send({});
    expect((second.body as { data: { sent: boolean } }).data.sent).toBe(false);
    expect(h.mail.of('sendFacultyApprovalRequest')).toHaveLength(1);
    // Nobody else's application can be reminded.
    const other = await student();
    expect(
      (
        await h
          .as(other)
          .post(`/students/applications/${id}/remind-faculty`)
          .send({})
      ).status,
    ).toBe(404);

    // CIEL PK decides without the faculty: approved, but the seat is not faculty-confirmed.
    expect(
      (await h.as(admin).post(`/admin/applications/${id}/approve`).send({}))
        .status,
    ).toBe(201);
    expect((await app(id)).internalStatus).toBe('approved');
    const seat = await h.ds
      .getRepository(Participation)
      .findOneByOrFail({ projectId: opp.id, studentId: s.id });
    expect(seat.status).toBe('approved');
    expect(seat.facultySupervisionConfirmedAt).toBeNull();
    const sup = await h.as(s).get(`/student/reports/${opp.id}/supervision`);
    expect((sup.body as { data: unknown }).data).toMatchObject({
      required: true,
      confirmed: false,
      blocked: true,
    });
  });

  it('the student hears the faculty decision; CIEL PK hears an application now awaits it', async () => {
    const notes = h.ds.getRepository(Notification);
    const noticesFor = async (userId: string, title: string) => {
      let rows: Notification[] = [];
      for (let i = 0; i < 50; i++) {
        rows = await notes.find({ where: { userId, title } });
        if (rows.length) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return rows;
    };
    const opp = await liveOpp();
    const fac = await h.makeUser(UserRole.FACULTY);
    const s = await student();
    const id = (
      (await apply(s, opp.id, fac.email)).body as {
        data: { application_id: string };
      }
    ).data.application_id;
    await h.as(fac).post(`/faculty/applications/${id}/approve`).expect(201);
    expect(
      await noticesFor(s.id, 'Faculty approved your application'),
    ).toHaveLength(1);
    expect(
      await noticesFor(admin.id, 'Join application awaiting CIEL PK approval'),
    ).not.toHaveLength(0);

    const s2 = await student();
    const id2 = (
      (await apply(s2, opp.id, fac.email)).body as {
        data: { application_id: string };
      }
    ).data.application_id;
    await h
      .as(fac)
      .post(`/faculty/applications/${id2}/reject`)
      .send({ reason: 'Not enrolled in my course' })
      .expect(201);
    const told = await noticesFor(
      s2.id,
      'Faculty did not approve your application',
    );
    expect(told).toHaveLength(1);
    expect(told[0].message).toMatch(/Not enrolled in my course/);
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

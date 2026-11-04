/**
 * Quick Community Impact teammates (real Nest app + scratch Postgres): the lead can submit without waiting
 * for teammates to confirm; they can confirm or decline until CIEL PK's final decision, and at that
 * decision only the lead and teammates who confirmed are credited hours and certificates.
 */
import { bootHarness, E2eUser, Harness } from './e2e/harness';
import { UserRole } from '../src/users/enums/user-role.enum';
import { S3Service } from '../src/common/s3.service';
import { Notification } from '../src/notifications/entities/notification.entity';
import { QuickWorkLog } from '../src/quick-work/entities/quick-work-log.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

type Body<T> = { data: T; message?: string | string[] };
type Part = {
  email: string;
  joinStatus: string;
  present: boolean;
  minutes: number;
  isLead: boolean;
  certificateCode?: string | null;
};
type LogView = {
  id: string;
  status: string;
  participants: Part[];
  certificate: { code: string } | null;
};
type Mine = { totals: { approvedMinutes: number } };

const pastDay = (d: number) =>
  new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const uniq = () => Math.random().toString(36).slice(2, 8);

describe('Quick Impact teammates need not confirm before submit (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  let evidenceUrl: (owner: E2eUser) => string;
  let notes: Repository<Notification>;
  let logs: Repository<QuickWorkLog>;

  beforeAll(async () => {
    h = await bootHarness({ bodyLimit: '50mb' });
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    const s3 = h.app.get<unknown, { bucket: string; region: string }>(
      S3Service,
    );
    evidenceUrl = (owner) =>
      `https://${s3.bucket}.s3.${s3.region}.amazonaws.com/quick-work/${owner.id}/photo.jpg`;
    notes = h.app.get<Repository<Notification>>(
      getRepositoryToken(Notification),
    );
    logs = h.app.get<Repository<QuickWorkLog>>(
      getRepositoryToken(QuickWorkLog),
    );
  });
  afterAll(async () => {
    await h.app.close();
  });

  const messages = (body: unknown) =>
    ([] as string[]).concat((body as Body<unknown>).message ?? []).join(' | ');

  const authorisedFaculty = async () => {
    const org = await h.makeOrg('E2E University', 'university');
    const faculty = await h.makeUser(UserRole.FACULTY);
    await h
      .as(admin)
      .post('/admin/faculty-university-scope')
      .send({ facultyUserId: faculty.id, universityOrganizationId: org.id })
      .expect(201);
    return faculty;
  };

  /** A team log (lead + the given teammates, all present 10:00-11:00) saved as a draft. */
  const teamDraft = async (
    lead: E2eUser,
    faculty: E2eUser,
    mates: E2eUser[],
    over: Record<string, unknown> = {},
  ) => {
    const res = await h
      .as(lead)
      .post('/quick-work/logs')
      .send({
        mode: 'team',
        leadStudentId: `SID-${lead.id.slice(0, 6)}`,
        university: 'E2E University',
        department: 'Computer Science',
        facultyName: 'Dr Reviewer',
        facultyEmail: faculty.email,
        title: `Team drive ${uniq()}`,
        activityType: 'Pinktober event',
        activityDate: pastDay(3),
        startTime: '10:00',
        endTime: '11:00',
        location: 'Campus courtyard, Lahore',
        teammates: mates.map((m, i) => ({
          email: m.email,
          studentId: `M-${i}-${uniq()}`,
          name: `Mate ${i}`,
        })),
        attendance: [lead, ...mates].map((u) => ({
          email: u.email,
          present: true,
          startTime: '10:00',
          endTime: '11:00',
          breakMinutes: 0,
        })),
        summary: 'We ran an awareness desk.',
        visibility: 'Faculty, University & CIEL PK only',
        evidence: [
          {
            url: evidenceUrl(lead),
            name: 'photo.jpg',
            type: 'image/jpeg',
            size: 1000,
            caption: 'Desk',
          },
        ],
        consent: true,
        honest: true,
        ...over,
      });
    expect(res.status).toBe(201);
    return (res.body as Body<LogView>).data;
  };

  const submit = (lead: E2eUser, id: string) =>
    h.as(lead).post(`/quick-work/logs/${id}/submit`);
  const facultyApprove = (faculty: E2eUser, id: string) =>
    h
      .as(faculty)
      .post(`/faculty/quick-work/${id}/review`)
      .send({ action: 'approve', verified: true });
  const finalApprove = (id: string) =>
    h
      .as(admin)
      .post(`/admin/quick-work/${id}/review`)
      .send({ action: 'approve', verified: true });
  const join = (mate: E2eUser, id: string, accept: boolean) =>
    h.as(mate).post(`/quick-work/logs/${id}/join`).send({ accept });
  const approved = async (u: E2eUser) =>
    ((await h.as(u).get('/quick-work/me')).body as Body<Mine>).data.totals
      .approvedMinutes;
  const adminView = async (id: string) =>
    ((await h.as(admin).get(`/admin/quick-work/${id}`)).body as Body<LogView>)
      .data;

  it('the lead submits with teammates who have not answered; a teammate may still confirm while it is with faculty and CIEL PK', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    const late = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const log = await teamDraft(lead, faculty, [mate, late]);

    const sub = await submit(lead, log.id);
    expect(sub.status).toBe(201);
    expect((sub.body as Body<LogView>).data.status).toBe('submitted');

    // Confirming still works after the submit (status: submitted), and again with CIEL PK (admin_review).
    expect((await join(mate, log.id, true)).status).toBe(201);
    expect((await facultyApprove(faculty, log.id)).status).toBe(201);
    expect((await adminView(log.id)).status).toBe('admin_review');
    expect((await join(late, log.id, true)).status).toBe(201);
    const joined = (await adminView(log.id)).participants.filter(
      (p) => p.joinStatus === 'joined',
    );
    expect(joined).toHaveLength(3);

    // Everyone confirmed before the final decision: everyone is credited.
    await finalApprove(log.id).expect(201);
    expect(await approved(lead)).toBe(60);
    expect(await approved(mate)).toBe(60);
    expect(await approved(late)).toBe(60);

    // After the final decision the answer is closed.
    const closed = await join(mate, log.id, false);
    expect(closed.status).toBe(400);
    expect(messages(closed.body)).toMatch(/already been approved/);
  });

  it('a teammate who never confirmed is not credited: no hours, no certificate, told why; the lead and confirmed teammates are', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const yes = await h.makeUser(UserRole.STUDENT);
    const silent = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const log = await teamDraft(lead, faculty, [yes, silent]);
    await submit(lead, log.id).expect(201);
    await join(yes, log.id, true).expect(201);
    await facultyApprove(faculty, log.id).expect(201);
    await finalApprove(log.id).expect(201);

    expect(await approved(lead)).toBe(60);
    expect(await approved(yes)).toBe(60);
    expect(await approved(silent)).toBe(0);

    const view = await adminView(log.id);
    const row = (u: E2eUser) =>
      view.participants.find((p) => p.email === u.email);
    expect(row(silent)).toMatchObject({ present: false, minutes: 0 });
    // Certificates: the lead and the confirmed teammate have one; the silent teammate does not.
    const cert = async (u: E2eUser) =>
      ((await h.as(u).get(`/quick-work/logs/${log.id}`)).body as Body<LogView>)
        .data.certificate?.code ?? null;
    expect(await cert(lead)).toBeTruthy();
    expect(await cert(yes)).toBeTruthy();
    expect(await cert(silent)).toBeNull();

    // The record says who was left out; the student is told.
    const stored = await logs.findOneOrFail({ where: { id: log.id } });
    const entry = (stored.history ?? []).find(
      (e) => e.action === 'not_credited',
    );
    expect(entry?.note).toContain('did not confirm');
    let told: Notification[] = [];
    for (let i = 0; i < 50 && !told.length; i++) {
      told = (
        await notes.find({
          where: {
            userId: silent.id,
            title: 'Quick Community Impact reviewed',
          },
        })
      ).filter((n) => /no hours were credited to you/.test(n.message));
      if (!told.length) await new Promise((r) => setTimeout(r, 20));
    }
    expect(told).toHaveLength(1);
    const yesNote = await notes.find({
      where: { userId: yes.id, title: 'Quick Community Impact reviewed' },
    });
    expect(
      yesNote.some((n) => /Your approved hours now appear/.test(n.message)),
    ).toBe(true);
  });

  it('a teammate who declines before submit must be removed first; one who declines after is simply not credited', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const no = await h.makeUser(UserRole.STUDENT);
    const later = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const log = await teamDraft(lead, faculty, [no, later]);
    await join(no, log.id, false).expect(201);
    const blocked = await submit(lead, log.id);
    expect(blocked.status).toBe(400);
    expect(messages(blocked.body)).toMatch(/declined to join\. Remove them/);

    // Removing the one who declined lets it through; the other can still decline afterwards.
    await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({
        teammates: [{ email: later.email, studentId: 'L-1', name: 'Later' }],
        attendance: [lead, later].map((u) => ({
          email: u.email,
          present: true,
          startTime: '10:00',
          endTime: '11:00',
          breakMinutes: 0,
        })),
      })
      .expect(200);
    await submit(lead, log.id).expect(201);
    await join(later, log.id, false).expect(201);
    await facultyApprove(faculty, log.id).expect(201);
    await finalApprove(log.id).expect(201);
    expect(await approved(lead)).toBe(60);
    expect(await approved(later)).toBe(0);
  });

  it('a teammate who has no CIEL account yet does not hold the submit back either, and is not credited', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const email = `nobody.${uniq()}@e2e.test`;
    h.mail.reset();
    const res = await h
      .as(lead)
      .post('/quick-work/logs')
      .send({
        mode: 'team',
        leadStudentId: `SID-${lead.id.slice(0, 6)}`,
        university: 'E2E University',
        department: 'Computer Science',
        facultyName: 'Dr Reviewer',
        facultyEmail: faculty.email,
        title: 'Waiting for a sign-up',
        activityType: 'Pinktober event',
        activityDate: pastDay(3),
        startTime: '10:00',
        endTime: '11:00',
        location: 'Lahore',
        teammates: [{ email, studentId: 'N-1', name: 'Newcomer' }],
        attendance: [
          {
            email: lead.email,
            present: true,
            startTime: '10:00',
            endTime: '11:00',
            breakMinutes: 0,
          },
        ],
        summary: 'We ran an awareness desk.',
        visibility: 'Faculty, University & CIEL PK only',
        evidence: [
          {
            url: evidenceUrl(lead),
            name: 'photo.jpg',
            type: 'image/jpeg',
            size: 1000,
            caption: 'Desk',
          },
        ],
        consent: true,
        honest: true,
      });
    expect(res.status).toBe(201);
    const id = (res.body as Body<LogView>).data.id;
    const sub = await submit(lead, id);
    expect(sub.status).toBe(201);
    await facultyApprove(faculty, id).expect(201);
    await finalApprove(id).expect(201);
    expect(await approved(lead)).toBe(60);
    expect((await adminView(id)).participants.map((p) => p.email)).toEqual([
      lead.email,
    ]);
  });

  it('an unconfirmed teammate’s other logs do not block the submit; once they confirm, the overlap is caught at the final approval', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    // The teammate already has their own submitted log for the same hour.
    const own = await teamDraft(mate, faculty, [], {
      mode: 'solo',
      teammates: [],
    });
    await submit(mate, own.id).expect(201);

    const log = await teamDraft(lead, faculty, [mate]);
    const sub = await submit(lead, log.id);
    expect(sub.status).toBe(201);

    await facultyApprove(faculty, log.id).expect(201);
    await join(mate, log.id, true).expect(201);
    // Not approved: the confirmed teammate's overlapping log is named.
    const res = await finalApprove(log.id);
    expect(res.status).toBe(400);
    expect(messages(res.body)).toMatch(/overlapping/i);
    expect((await adminView(log.id)).status).toBe('admin_review');
  });
});

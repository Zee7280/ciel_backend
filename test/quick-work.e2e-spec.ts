/**
 * Quick Community Work, end to end (real Nest app + scratch Postgres): a student drafts a short
 * activity log, teammates confirm, the lead submits, and only the named faculty member reviews.
 */
import { bootHarness, E2eUser, Harness, oppPayload } from './e2e/harness';
import { UserRole } from '../src/users/enums/user-role.enum';
import { S3Service } from '../src/common/s3.service';
import { Participation } from '../src/engagement/entities/participant.entity';
import { AttendanceLog } from '../src/engagement/entities/attendance-log.entity';
import { Organization } from '../src/organizations/entities/organization.entity';
import { widenColumnsBeforeSync } from '../src/database/widen-columns-before-sync';

type Participant = {
  userId: string;
  email: string;
  isLead: boolean;
  joinStatus: string;
  minutes: number;
};
type LogView = {
  id: string;
  status: string;
  reviewNote: string | null;
  participants: Participant[];
};
type Body<T> = { data: T; message?: string | string[] };

const pastDay = (d: number) =>
  new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

describe('Quick Community Work (real app + real Postgres)', () => {
  let h: Harness;
  let evidenceUrl: (owner: E2eUser) => string;
  let admin: E2eUser;
  let university: Organization;

  /** A faculty member authorised for the students' university, so they may approve hours. */
  const authorisedFaculty = async (org: Organization = university) => {
    const faculty = await h.makeUser(UserRole.FACULTY);
    await h
      .as(admin)
      .post('/admin/faculty-university-scope')
      .send({ facultyUserId: faculty.id, universityOrganizationId: org.id })
      .expect(201);
    return faculty;
  };

  beforeAll(async () => {
    // Same body limit as production: a 500-member team saves in one request.
    h = await bootHarness({ bodyLimit: '50mb' });
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    // Students made by the harness name "E2E University" on their profile.
    university = await h.makeOrg('E2E University', 'university');
    // Evidence must live in the lead's own presign folder: build such a URL for this bucket.
    const s3 = h.app.get<unknown, { bucket: string; region: string }>(
      S3Service,
    );
    evidenceUrl = (owner) =>
      `https://${s3.bucket}.s3.${s3.region}.amazonaws.com/quick-work/${owner.id}/photo.jpg`;
  });
  afterAll(async () => {
    await h.app.close();
  });

  const messages = (body: Body<unknown>) =>
    ([] as string[]).concat(body.message ?? []).join(' | ');

  /** Everything a complete solo log needs, on a past date. */
  const completeLog = (
    lead: E2eUser,
    faculty: { email: string },
    over: Record<string, unknown> = {},
  ) => ({
    mode: 'solo',
    leadStudentId: `SID-${lead.id.slice(0, 6)}`,
    university: 'E2E University',
    department: 'Computer Science',
    facultyName: 'Dr Reviewer',
    facultyEmail: faculty.email.toUpperCase(),
    title: 'Pinktober awareness circle',
    activityType: 'Pinktober event',
    activityDate: pastDay(3),
    startTime: '10:00',
    endTime: '11:00',
    location: 'Campus courtyard, Lahore',
    sdg: 3,
    attendance: [
      {
        email: lead.email,
        present: true,
        startTime: '10:00',
        endTime: '11:00',
        breakMinutes: 0,
      },
    ],
    summary: 'We ran an awareness desk and shared leaflets.',
    peopleReached: 30,
    visibility: 'Faculty, University & CIEL PK only',
    evidence: [
      {
        url: evidenceUrl(lead),
        name: 'photo.jpg',
        type: 'image/jpeg',
        size: 1000,
        caption: 'Awareness desk',
      },
    ],
    consent: true,
    honest: true,
    ...over,
  });

  const draft = async (lead: E2eUser, body: Record<string, unknown>) => {
    const res = await h.as(lead).post('/quick-work/logs').send(body);
    expect(res.status).toBe(201);
    return (res.body as Body<LogView>).data;
  };

  /** The token with one character in the middle changed. */
  /** CIEL PK final approval of a faculty-approved log: the step that credits the hours. */
  const finalApprove = (logId: string) =>
    h
      .as(admin)
      .post(`/admin/quick-work/${logId}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);

  const tampered = (token: string) => {
    const i = Math.floor(token.length / 2);
    return `${token.slice(0, i)}${token[i] === 'A' ? 'B' : 'A'}${token.slice(i + 1)}`;
  };

  /** Background emails (team invites) are sent after the response; wait until they are captured. */
  const mailsOf = async (method: string, count: number) => {
    for (let i = 0; i < 50 && h.mail.of(method).length < count; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return h.mail.of(method);
  };

  it('solo: submit, faculty approves, the hours land on the student dashboard', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const log = await draft(lead, completeLog(lead, faculty));
    expect(log.status).toBe('draft');
    expect(log.participants[0]).toMatchObject({ isLead: true, minutes: 60 });

    h.mail.reset();
    const sub = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(sub.status).toBe(201);
    expect((sub.body as Body<LogView>).data.status).toBe('submitted');
    expect(h.mail.of('sendQuickWorkSubmittedForReview')).toHaveLength(1);

    // Submitted logs are locked for the student.
    const edit = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ title: 'x' });
    expect(edit.status).toBe(400);

    const queue = await h.as(faculty).get('/faculty/quick-work');
    expect(queue.status).toBe(200);
    const pending = (queue.body as Body<{ pending: LogView[] }>).data.pending;
    expect(pending.map((l) => l.id)).toContain(log.id);

    const noCheck = await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve' });
    expect(noCheck.status).toBe(400);
    const ok = await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true });
    expect(ok.status).toBe(201);
    // Faculty approval hands the log to CIEL PK; the hours stay pending until its final approval.
    expect((ok.body as Body<LogView>).data.status).toBe('admin_review');

    const again = await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'reject', note: 'late' });
    expect(again.status).toBe(400);

    const pendingMe = await h.as(lead).get('/quick-work/me');
    expect(
      (pendingMe.body as Body<{ totals: Record<string, number> }>).data.totals,
    ).toEqual({
      approvedMinutes: 0,
      pendingMinutes: 60,
      approvedActivities: 0,
    });

    await finalApprove(log.id);
    const me = await h.as(lead).get('/quick-work/me');
    expect(me.status).toBe(200);
    expect(
      (me.body as Body<{ totals: Record<string, number> }>).data.totals,
    ).toEqual({
      approvedMinutes: 60,
      pendingMinutes: 0,
      approvedActivities: 1,
    });
  });

  it('CIEL PK final approval: after faculty approves, only CIEL PK approves, returns or rejects', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const facultyApprove = (id: string) =>
      h
        .as(faculty)
        .post(`/faculty/quick-work/${id}/review`)
        .send({ action: 'approve', verified: true });
    const adminDecide = (id: string, body: Record<string, unknown>) =>
      h.as(admin).post(`/admin/quick-work/${id}/review`).send(body);
    const statusOf = async (id: string) =>
      ((await h.as(admin).get(`/admin/quick-work/${id}`)).body as Body<LogView>)
        .data.status;

    const log = await draft(lead, completeLog(lead, faculty));
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    expect((await facultyApprove(log.id)).status).toBe(201);
    expect(await statusOf(log.id)).toBe('admin_review');

    // Faculty sees it as reviewed; it cannot be decided twice, edited, or handed to other faculty.
    const queue = (
      (await h.as(faculty).get('/faculty/quick-work')).body as Body<{
        pending: LogView[];
        reviewed: LogView[];
      }>
    ).data;
    expect(queue.pending.map((l) => l.id)).not.toContain(log.id);
    expect(queue.reviewed.find((l) => l.id === log.id)?.status).toBe(
      'admin_review',
    );
    expect((await facultyApprove(log.id)).status).toBe(400);
    expect(
      (
        await h
          .as(lead)
          .patch(`/quick-work/logs/${log.id}`)
          .send({ title: 'x' })
      ).status,
    ).toBe(400);
    expect(
      (
        await h
          .as(admin)
          .patch(`/admin/quick-work/${log.id}/faculty`)
          .send({ facultyName: 'Dr X', facultyEmail: 'dr.x@uni.edu.pk' })
      ).status,
    ).toBe(400);

    // The admin list counts and filters the CIEL PK queue.
    const list = (
      (await h.as(admin).get('/admin/quick-work?status=admin_review'))
        .body as Body<{
        rows: { id: string }[];
        counts: Record<string, number>;
      }>
    ).data;
    expect(list.rows.map((r) => r.id)).toContain(log.id);
    expect(list.counts.admin_review).toBeGreaterThanOrEqual(1);

    // CIEL PK returns it: the student revises and resubmits, and it goes back to faculty first.
    expect((await adminDecide(log.id, { action: 'changes' })).status).toBe(400);
    expect(
      (
        await adminDecide(log.id, {
          action: 'changes',
          note: 'Add the attendance sheet.',
        })
      ).status,
    ).toBe(201);
    expect(await statusOf(log.id)).toBe('changes');
    await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ summary: 'Updated with the attendance sheet.' })
      .expect(200);
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    expect(await statusOf(log.id)).toBe('submitted');
    expect((await facultyApprove(log.id)).status).toBe(201);

    // Final approval needs the review confirmation, then credits the hours once.
    expect((await adminDecide(log.id, { action: 'approve' })).status).toBe(400);
    await finalApprove(log.id);
    expect(await statusOf(log.id)).toBe('approved');
    expect(
      (await adminDecide(log.id, { action: 'reject', note: 'late' })).status,
    ).toBe(400);
    const history = (
      (await h.as(admin).get(`/admin/quick-work/${log.id}`)).body as Body<{
        history: { action: string }[];
      }>
    ).data.history.map((x) => x.action);
    expect(history).toEqual([
      'submitted',
      'approved',
      'admin_changes',
      'resubmitted',
      'approved',
      'admin_approved',
    ]);

    // CIEL PK can also reject a faculty-approved log.
    const second = await draft(
      lead,
      completeLog(lead, faculty, { activityDate: pastDay(5) }),
    );
    await h.as(lead).post(`/quick-work/logs/${second.id}/submit`).expect(201);
    expect((await facultyApprove(second.id)).status).toBe(201);
    expect(
      (
        await adminDecide(second.id, {
          action: 'reject',
          note: 'Duplicate of another record.',
        })
      ).status,
    ).toBe(201);
    expect(await statusOf(second.id)).toBe('rejected');
    const totals = (
      (await h.as(lead).get('/quick-work/me')).body as Body<{
        totals: Record<string, number>;
      }>
    ).data.totals;
    expect(totals).toEqual({
      approvedMinutes: 60,
      pendingMinutes: 0,
      approvedActivities: 1,
    });
  });

  it('sidebar badges: faculty and admin pending counts follow submit and review', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const other = await h.makeUser(UserRole.FACULTY);
    const admin = await h.makeUser(UserRole.SUPER_ADMIN);
    const facultyCount = async (u: typeof faculty) => {
      const res = await h.as(u).get('/faculty/quick-work/pending-count');
      expect(res.status).toBe(200);
      return (res.body as Body<{ pending: number }>).data.pending;
    };
    const adminCount = async () => {
      const res = await h.as(admin).get('/admin/pending-counts');
      expect(res.status).toBe(200);
      return (res.body as Body<{ quickWork: number }>).data.quickWork;
    };
    const adminBefore = await adminCount();

    const log = await draft(lead, completeLog(lead, faculty));
    expect(await facultyCount(faculty)).toBe(0);
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    expect(await facultyCount(faculty)).toBe(1);
    expect(await facultyCount(other)).toBe(0);
    // The admin badge counts logs awaiting CIEL PK final approval, not those still with faculty.
    expect(await adminCount()).toBe(adminBefore);
    expect(
      (await h.as(lead).get('/faculty/quick-work/pending-count')).status,
    ).toBe(403);

    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);
    expect(await facultyCount(faculty)).toBe(0);
    expect(await adminCount()).toBe(adminBefore + 1);

    await finalApprove(log.id);
    expect(await adminCount()).toBe(adminBefore);
  });

  it('only the named faculty member can see or review a log', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    const other = await h.makeUser(UserRole.FACULTY);
    const log = await draft(lead, completeLog(lead, faculty));
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);

    const queue = await h.as(other).get('/faculty/quick-work');
    expect(
      (queue.body as Body<{ pending: LogView[] }>).data.pending.map(
        (l) => l.id,
      ),
    ).not.toContain(log.id);
    const review = await h
      .as(other)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true });
    expect(review.status).toBe(404);

    // Another student cannot open it either; a faculty user cannot use the student endpoints.
    const stranger = await h.makeUser(UserRole.STUDENT);
    expect(
      (await h.as(stranger).get(`/quick-work/logs/${log.id}`)).status,
    ).toBe(404);
    expect((await h.as(faculty).get('/quick-work/me')).status).toBe(403);
    expect((await h.as(null).get('/quick-work/me')).status).toBe(401);
  });

  it('team: teammates must be CIEL students who confirm before the lead can submit', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();

    const notStudent = await h
      .as(lead)
      .post('/quick-work/logs')
      .send(
        completeLog(lead, faculty, {
          mode: 'team',
          teammates: [{ email: faculty.email, studentId: 'X1' }],
        }),
      );
    expect(notStudent.status).toBe(400);
    expect(messages(notStudent.body as Body<unknown>)).toMatch(
      /No CIEL student account/,
    );

    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        mode: 'team',
        teammates: [{ email: mate.email, studentId: 'MATE-1' }],
        attendance: [
          {
            email: lead.email,
            present: true,
            startTime: '10:00',
            endTime: '11:00',
            breakMinutes: 0,
          },
          {
            email: mate.email,
            present: true,
            startTime: '10:15',
            endTime: '11:00',
            breakMinutes: 0,
          },
        ],
      }),
    );
    const mateRow = log.participants.find((p) => p.email === mate.email);
    expect(mateRow).toMatchObject({ joinStatus: 'invited', minutes: 45 });

    const early = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(early.status).toBe(400);
    expect(messages(early.body as Body<unknown>)).toMatch(
      /not confirmed joining/,
    );

    // The teammate sees the invitation and confirms.
    const mine = await h.as(mate).get('/quick-work/me');
    expect(
      (mine.body as Body<{ logs: LogView[] }>).data.logs.map((l) => l.id),
    ).toContain(log.id);
    await h
      .as(mate)
      .post(`/quick-work/logs/${log.id}/join`)
      .send({ accept: true })
      .expect(201);

    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);
    await finalApprove(log.id);

    // Each member receives only their own approved time.
    const mateTotals = await h.as(mate).get('/quick-work/me');
    expect(
      (mateTotals.body as Body<{ totals: Record<string, number> }>).data.totals
        .approvedMinutes,
    ).toBe(45);
  });

  it('changes requested: the lead edits the same log and resubmits', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    const log = await draft(lead, completeLog(lead, faculty));
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);

    const noNote = await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'changes' });
    expect(noNote.status).toBe(400);
    const back = await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'changes', note: 'Add a clearer photo' });
    expect((back.body as Body<LogView>).data).toMatchObject({
      status: 'changes',
      reviewNote: 'Add a clearer photo',
    });

    await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ summary: 'Updated description with more detail.' })
      .expect(200);
    const re = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(re.status).toBe(201);
    expect((re.body as Body<LogView>).data).toMatchObject({
      status: 'submitted',
      reviewNote: null,
    });
  });

  it('refuses overlapping claims, future dates and evidence that is not your own upload', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    const first = await draft(lead, completeLog(lead, faculty));
    await h.as(lead).post(`/quick-work/logs/${first.id}/submit`).expect(201);

    const overlap = await draft(
      lead,
      completeLog(lead, faculty, { title: 'Second drive' }),
    );
    const clash = await h
      .as(lead)
      .post(`/quick-work/logs/${overlap.id}/submit`);
    expect(clash.status).toBe(400);
    expect(messages(clash.body as Body<unknown>)).toMatch(/overlapping/);

    const future = await draft(
      lead,
      completeLog(lead, faculty, {
        activityDate: new Date(Date.now() + 3 * 86400000)
          .toISOString()
          .slice(0, 10),
      }),
    );
    const fut = await h.as(lead).post(`/quick-work/logs/${future.id}/submit`);
    expect(fut.status).toBe(400);
    expect(messages(fut.body as Body<unknown>)).toMatch(
      /today or a past activity/,
    );

    const someoneElse = await h.makeUser(UserRole.STUDENT);
    const stolen = await h
      .as(lead)
      .post('/quick-work/logs')
      .send(
        completeLog(lead, faculty, {
          evidence: [
            {
              url: evidenceUrl(someoneElse),
              name: 'x.jpg',
              type: 'image/jpeg',
              size: 10,
              caption: 'x',
            },
          ],
        }),
      );
    expect(stolen.status).toBe(400);

    const badType = await h
      .as(lead)
      .post('/quick-work/logs')
      .send(
        completeLog(lead, faculty, {
          evidence: [
            {
              url: evidenceUrl(lead),
              name: 'x.html',
              type: 'text/html',
              size: 10,
              caption: 'x',
            },
          ],
        }),
      );
    expect(badType.status).toBe(400);
  });

  it('refuses time already logged as structured community service attendance', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const opp = await h.as(ngo).post('/opportunities').send(oppPayload());
    expect(opp.status).toBe(201);
    const projectId = (opp.body as { id: string }).id;
    const seat = await h.ds.getRepository(Participation).save(
      h.ds.getRepository(Participation).create({
        projectId,
        studentId: lead.id,
        fullName: 'Quick Lead',
        status: 'approved',
        email: lead.email,
        mobile: '+923005550000',
        cnic: 'enc',
        cnicHash: `hash-${lead.email}`,
        cnicLast4: '0000',
        universityId: 'e2e',
        universityName: 'E2E University',
        academicProgram: 'BS CS',
        yearOfStudy: '3rd Year',
        department: 'Computer Science',
        academicIntegrationType: 'Voluntary',
        emailVerified: true,
        mobileVerified: true,
        primaryFacultyEmail: faculty.email,
        attendanceApproverType: 'partner',
      }),
    );
    const date = pastDay(5);
    await h.ds.getRepository(AttendanceLog).save(
      h.ds.getRepository(AttendanceLog).create({
        participantId: seat.id,
        projectId,
        dateOfEngagement: date,
        startTime: '10:30',
        endTime: '12:00',
        sessionHours: 1.5,
        organizationName: 'E2E',
        activityType: 'Fieldwork',
        description: 'Structured session',
      }),
    );

    const log = await draft(
      lead,
      completeLog(lead, faculty, { activityDate: date }),
    );
    const res = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(res.status).toBe(400);
    expect(messages(res.body as Body<unknown>)).toMatch(
      /structured community service attendance/,
    );
  });

  it('“Other” activity needs a description; the venue map pin is kept', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        activityType: 'Other service activity',
        locationPin: '31.5204,74.3587',
      }),
    );
    const blocked = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(blocked.status).toBe(400);
    expect(messages(blocked.body as Body<unknown>)).toMatch(
      /Describe the activity type/,
    );

    const saved = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ activityTypeOther: '  Blood donation camp ' });
    expect(saved.status).toBe(200);
    expect((saved.body as Body<Record<string, unknown>>).data).toMatchObject({
      activityTypeOther: 'Blood donation camp',
      locationPin: '31.5204,74.3587',
    });
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
  });

  it('team of three with partners: faculty and admin see every member and partner', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mates = [
      await h.makeUser(UserRole.STUDENT),
      await h.makeUser(UserRole.STUDENT),
    ];
    const faculty = await authorisedFaculty();
    const slot = (email: string) => ({
      email,
      present: true,
      startTime: '10:00',
      endTime: '11:00',
      breakMinutes: 0,
    });
    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        mode: 'team',
        title: 'Three-person partner drive',
        teammates: mates.map((m, i) => ({
          email: m.email,
          studentId: `MATE-${i}`,
        })),
        attendance: [lead, ...mates].map((u) => slot(u.email)),
        partners: [' Edhi Foundation ', 'edhi foundation', 'WWF Pakistan'],
        location: 'Clifton beach, Karachi',
        peopleReached: 25,
      }),
    );
    expect(log.participants).toHaveLength(3);
    expect(log).toMatchObject({
      partners: ['Edhi Foundation', 'WWF Pakistan'],
    });

    for (const m of mates) {
      await h
        .as(m)
        .post(`/quick-work/logs/${log.id}/join`)
        .send({ accept: true })
        .expect(201);
    }
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);

    type Seen = LogView & { partners: string[] };
    const queue = await h.as(faculty).get('/faculty/quick-work');
    const pending = (queue.body as Body<{ pending: Seen[] }>).data.pending.find(
      (l) => l.id === log.id,
    );
    expect(pending?.partners).toEqual(['Edhi Foundation', 'WWF Pakistan']);
    expect(pending?.participants.map((p) => p.email).sort()).toEqual(
      [lead, ...mates].map((u) => u.email).sort(),
    );

    const detail = await h.as(admin).get(`/admin/quick-work/${log.id}`);
    expect(detail.status).toBe(200);
    const seen = (detail.body as Body<Seen>).data;
    expect(seen.partners).toEqual(['Edhi Foundation', 'WWF Pakistan']);
    expect(seen.participants).toHaveLength(3);

    const exported = await h
      .as(admin)
      .get('/admin/quick-work/export?search=Three-person');
    const rows = (
      exported.body as Body<{
        rows: { logId: string; partners: string; role: string }[];
      }>
    ).data.rows.filter((r) => r.logId === log.id);
    expect(rows.map((r) => r.role).sort()).toEqual([
      'lead',
      'teammate',
      'teammate',
    ]);
    expect(rows[0].partners).toBe('Edhi Foundation; WWF Pakistan');

    type Stats = {
      engagement_hours: number;
      verified_records: number;
      people_reached: number;
      community_dividend_pkr: number;
      verified_by_path: { community_service: number };
      cities: { id: string; verifiedHours: number }[];
      sdgs: {
        number: number;
        items: { title: string; path: string; city: string | null }[];
      }[];
    };
    const stats = async () =>
      ((await h.as(lead).get('/public/platform-stats')).body as Body<Stats>)
        .data;
    const before = await stats();

    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);
    // Faculty approval alone is not final: nothing reaches the public ledger yet.
    expect((await stats()).verified_records).toBe(before.verified_records);
    await finalApprove(log.id);

    // The public home-page ledger now counts the approved activity everywhere.
    const after = await stats();
    expect(after.engagement_hours - before.engagement_hours).toBe(3);
    expect(after.verified_records - before.verified_records).toBe(1);
    expect(after.people_reached - before.people_reached).toBe(25);
    expect(after.community_dividend_pkr).toBeGreaterThan(
      before.community_dividend_pkr,
    );
    expect(
      after.verified_by_path.community_service -
        before.verified_by_path.community_service,
    ).toBe(1);
    const karachi = (s: Stats) =>
      s.cities.find((c) => c.id === 'karachi')?.verifiedHours ?? 0;
    expect(karachi(after) - karachi(before)).toBe(3);
    expect(after.sdgs.find((g) => g.number === 3)?.items).toContainEqual({
      title: 'Three-person partner drive',
      path: 'Quick Community Work',
      city: 'Karachi',
      verifiedAt: expect.any(String) as unknown as string,
    });

    for (const m of mates) {
      const me = await h.as(m).get('/quick-work/me');
      expect(
        (me.body as Body<{ totals: Record<string, number> }>).data.totals
          .approvedMinutes,
      ).toBe(60);
    }
  });

  it('a team of 500: teammate name, ID and contact saved; submit and approval stay fast', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const mates: E2eUser[] = [];
    for (let i = 0; i < 499; i++)
      mates.push(await h.makeUser(UserRole.STUDENT));
    const teammates = mates.map((m, i) => ({
      email: m.email,
      studentId: `BIG-${i}`,
      name: `Typed Name ${i}`,
      contact: i % 2 ? `+92300000${String(i).padStart(4, '0')}` : null,
    }));
    const attendance = [lead, ...mates].map((u) => ({
      email: u.email,
      present: true,
      startTime: '10:00',
      endTime: '11:00',
      breakMinutes: 0,
    }));

    const tooMany = await h
      .as(lead)
      .post('/quick-work/logs')
      .send(
        completeLog(lead, faculty, {
          mode: 'team',
          teammates: [
            ...teammates,
            { email: 'one.more@e2e.test', studentId: 'X' },
          ],
        }),
      );
    expect(tooMany.status).toBe(400);

    let t = Date.now();
    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        mode: 'team',
        title: 'Five hundred strong',
        teammates,
        attendance,
      }),
    );
    const saveMs = Date.now() - t;
    expect(log.participants).toHaveLength(500);
    type Row = Participant & { studentId: string; contact: string | null };
    const rows = log.participants as Row[];
    const first = rows.find((p) => p.email === mates[1].email);
    // The teammate's CIEL account name wins over the typed one; ID and contact are kept.
    expect(first).toMatchObject({
      studentId: 'BIG-1',
      contact: '+923000000001',
    });
    expect(rows.find((p) => p.email === mates[0].email)?.contact).toBeNull();

    // Everyone confirms (straight in the database: 499 join requests are not the point here).
    await h.ds.query(
      `UPDATE quick_work_participants SET "joinStatus" = 'joined' WHERE "logId" = $1`,
      [log.id],
    );

    t = Date.now();
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    const submitMs = Date.now() - t;

    t = Date.now();
    const queue = await h.as(faculty).get('/faculty/quick-work');
    const queueMs = Date.now() - t;
    const pending = (
      queue.body as Body<{
        pending: (LogView & { approveBlockedReason: string | null })[];
      }>
    ).data.pending.find((l) => l.id === log.id);
    expect(pending?.participants).toHaveLength(500);
    expect(pending?.approveBlockedReason).toBeNull();

    t = Date.now();
    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);
    const approveMs = Date.now() - t;

    const exported = await h
      .as(admin)
      .get('/admin/quick-work/export?search=Five%20hundred');
    const exportRows = (
      exported.body as Body<{ rows: { logId: string; contact: string }[] }>
    ).data.rows.filter((r) => r.logId === log.id);
    expect(exportRows).toHaveLength(500);

    console.log(
      `500-member log: save ${saveMs} ms, submit ${submitMs} ms, faculty queue ${queueMs} ms, approve ${approveMs} ms`,
    );
    for (const ms of [saveMs, submitMs, queueMs, approveMs]) {
      expect(ms).toBeLessThan(15000);
    }
  }, 180000);

  it('evidence: photos, documents, video and audio up to 100 MB; nothing a browser would run', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const presign = (filename: string, contentType: string, size: number) =>
      h
        .as(lead)
        .post('/quick-work/evidence/presign')
        .send({ filename, contentType, size });
    const MB = 1024 * 1024;
    for (const [name, type, size] of [
      ['photo.jpeg', 'image/jpeg', 8 * MB],
      ['iphone.heic', 'image/heic', 12 * MB],
      [
        'plan.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        2 * MB,
      ],
      [
        'sheet.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        MB,
      ],
      [
        'slides.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        40 * MB,
      ],
      ['clip.mp4', 'video/mp4', 100 * MB],
      ['clip.mov', 'video/quicktime', 60 * MB],
      ['voice.m4a', 'audio/mp4', 5 * MB],
    ] as const) {
      const res = await presign(name, type, size);
      expect([name, res.status]).toEqual([name, 201]);
    }
    for (const [name, type, size] of [
      ['page.html', 'text/html', 1000],
      ['logo.svg', 'image/svg+xml', 1000],
      ['all.zip', 'application/zip', MB],
      ['run.exe', 'application/octet-stream', MB],
      ['huge.mp4', 'video/mp4', 100 * MB + 1],
    ] as const) {
      const res = await presign(name, type, size);
      expect([name, res.status]).toEqual([name, 400]);
    }

    // Ten files save on a draft; an eleventh is refused.
    const faculty = await h.makeUser(UserRole.FACULTY);
    const file = (i: number) => ({
      url: evidenceUrl(lead).replace('photo.jpg', `f${i}.mp4`),
      name: `f${i}.mp4`,
      type: 'video/mp4',
      size: 90 * MB,
      caption: `Clip ${i}`,
    });
    const ten = Array.from({ length: 10 }, (_, i) => file(i));
    const log = await draft(
      lead,
      completeLog(lead, faculty, { evidence: ten }),
    );
    expect((log as unknown as { evidence: unknown[] }).evidence).toHaveLength(
      10,
    );
    const eleven = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ evidence: [...ten, file(10)] });
    expect(eleven.status).toBe(400);
  });

  it('summary grows to 1000 characters without losing summaries already stored at 600', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    const kept = 'Stored before the upgrade. '.repeat(20).slice(0, 590);
    const log = await draft(
      lead,
      completeLog(lead, faculty, { summary: kept }),
    );

    // Put the column back the way production has it, then run what a boot runs: the
    // pre-sync widening, then TypeORM synchronize.
    await h.ds.query(
      'ALTER TABLE quick_work_logs ALTER COLUMN summary TYPE varchar(600)',
    );
    await widenColumnsBeforeSync({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    await h.ds.synchronize();

    const [col] = await h.ds.query<{ len: number }[]>(
      `SELECT character_maximum_length AS len FROM information_schema.columns
        WHERE table_name = 'quick_work_logs' AND column_name = 'summary'`,
    );
    expect(col.len).toBe(1000);
    const [row] = await h.ds.query<{ summary: string }[]>(
      'SELECT summary FROM quick_work_logs WHERE id = $1',
      [log.id],
    );
    expect(row.summary).toBe(kept);

    const long = 'x'.repeat(1000);
    await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ summary: long })
      .expect(200);
    expect(
      (
        await h
          .as(lead)
          .patch(`/quick-work/logs/${log.id}`)
          .send({ summary: `${long}x` })
      ).status,
    ).toBe(400);
  });

  it('naming the faculty sends nothing; each teammate is emailed a confirm link that works without signing in', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();

    h.mail.reset();
    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        mode: 'team',
        title: 'Teammates asked by email',
        teammates: [{ email: mate.email, studentId: 'M-77', name: 'Mate' }],
        attendance: [lead, mate].map((u) => ({
          email: u.email,
          present: true,
          startTime: '10:00',
          endTime: '11:00',
          breakMinutes: 0,
        })),
      }),
    );
    // Faculty hear about the log only when it is submitted.
    expect(h.mail.of('sendQuickWorkSubmittedForReview')).toHaveLength(0);
    const invites = await mailsOf('sendQuickWorkTeamInvite', 1);
    expect(invites).toHaveLength(1);
    expect(invites[0].args[0]).toMatchObject({ to: mate.email });

    // Saving again without changing the team sends nothing new.
    await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ title: 'Teammates asked by email' })
      .expect(200);
    expect(h.mail.of('sendQuickWorkTeamInvite')).toHaveLength(1);

    // The teammate answers from the emailed link; opening it records nothing.
    const mateToken = (invites[0].args[0] as { respondToken: string })
      .respondToken;
    const preview = await h
      .as(null)
      .get(`/quick-work/email-response?token=${encodeURIComponent(mateToken)}`);
    expect(preview.status).toBe(200);
    expect((preview.body as Body<Record<string, unknown>>).data).toMatchObject({
      kind: 'member',
      answer: 'pending',
      open: true,
    });
    expect(
      (
        await h
          .as(null)
          .post('/quick-work/email-response')
          .send({ token: tampered(mateToken), accept: true })
      ).status,
    ).toBe(404);
    const early = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(messages(early.body as Body<unknown>)).toMatch(
      /not confirmed joining/,
    );
    await h
      .as(null)
      .post('/quick-work/email-response')
      .send({ token: mateToken, accept: true })
      .expect(201);

    // No faculty step before submit; the faculty review queue gets it once submitted.
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    expect(h.mail.of('sendQuickWorkSubmittedForReview')).toHaveLength(1);
    const queue = await h.as(faculty).get('/faculty/quick-work');
    expect(
      (queue.body as Body<{ pending: LogView[] }>).data.pending.map(
        (l) => l.id,
      ),
    ).toContain(log.id);

    // Once submitted, the link no longer changes anything.
    expect(
      (
        await h
          .as(null)
          .post('/quick-work/email-response')
          .send({ token: mateToken, accept: false })
      ).status,
    ).toBe(400);
  });

  it('partners keep an optional email and contact; names-only saves keep them; never public', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    type Partner = {
      name: string;
      email: string | null;
      contact: string | null;
    };
    type View = LogView & { partners: string[]; partnerDetails: Partner[] };
    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        title: 'Partner contact drive',
        partnerDetails: [
          {
            name: 'Edhi Foundation',
            email: 'Info@Edhi.org',
            contact: '+923001234567',
          },
          { name: 'WWF Pakistan' },
        ],
      }),
    );
    expect((log as View).partners).toEqual(['Edhi Foundation', 'WWF Pakistan']);
    expect((log as View).partnerDetails).toEqual([
      {
        name: 'Edhi Foundation',
        email: 'info@edhi.org',
        contact: '+923001234567',
      },
      { name: 'WWF Pakistan', email: null, contact: null },
    ]);

    const bad = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({
        partnerDetails: [{ name: 'Edhi Foundation', email: 'not-an-email' }],
      });
    expect(bad.status).toBe(400);
    expect(messages(bad.body as Body<unknown>)).toMatch(
      /valid email for Edhi Foundation/,
    );

    // An older client sends names only: Edhi keeps its contact, WWF goes, Akhuwat is added.
    const legacy = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ partners: ['Edhi Foundation', 'Akhuwat'] });
    expect((legacy.body as Body<View>).data.partnerDetails).toEqual([
      {
        name: 'Edhi Foundation',
        email: 'info@edhi.org',
        contact: '+923001234567',
      },
      { name: 'Akhuwat', email: null, contact: null },
    ]);

    // Approved: the public ledger counts the partner by name only.
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    const exported = await h
      .as(admin)
      .get('/admin/quick-work/export?search=Partner%20contact');
    const row = (
      exported.body as Body<{ rows: { logId: string; partners: string }[] }>
    ).data.rows.find((r) => r.logId === log.id);
    expect(row?.partners).toBe(
      'Edhi Foundation (info@edhi.org, +923001234567); Akhuwat',
    );

    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);
    const stats = JSON.stringify(
      (await h.as(null).get('/public/platform-stats')).body,
    );
    expect(stats).not.toContain('info@edhi.org');
    expect(stats).not.toContain('3001234567');
  });

  it('the host organisation keeps an optional email and contact', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    type View = LogView & {
      hostEmail: string | null;
      hostContact: string | null;
    };
    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        host: 'Rotary Club Lahore',
        hostEmail: ' Contact@Rotary.pk ',
        hostContact: '+923001234567',
      }),
    );
    expect(log as View).toMatchObject({
      hostEmail: 'contact@rotary.pk',
      hostContact: '+923001234567',
    });
    const bad = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ hostEmail: 'nope' });
    expect(bad.status).toBe(400);
    const cleared = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ hostEmail: '', hostContact: null });
    expect((cleared.body as Body<View>).data).toMatchObject({
      hostEmail: null,
      hostContact: null,
    });
  });

  it('the faculty email carries the flashcard; its links review with the same rules as the dashboard', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    type Preview = {
      log: LogView & { status: string };
      open: boolean;
      registered: boolean;
      approveBlockedReason: string | null;
    };
    const review = (token: string, body: Record<string, unknown>) =>
      h
        .as(null)
        .post('/quick-work/faculty-review')
        .send({ token, ...body });

    // Faculty without a CIEL account: the link asks them to sign up first.
    const stray = await draft(
      lead,
      completeLog(
        lead,
        { email: 'not.registered@e2e.test' },
        {
          title: 'Flashcard stray',
          activityDate: pastDay(6),
        },
      ),
    );
    h.mail.reset();
    await h.as(lead).post(`/quick-work/logs/${stray.id}/submit`).expect(201);
    const strayToken = (
      h.mail.of('sendQuickWorkSubmittedForReview')[0].args[0] as {
        reviewToken: string;
      }
    ).reviewToken;
    const strayPreview = await h
      .as(null)
      .get(
        `/quick-work/faculty-review?token=${encodeURIComponent(strayToken)}`,
      );
    const strayData = (strayPreview.body as Body<Preview>).data;
    expect(strayData).toMatchObject({ open: true, registered: false });
    // The address was typed by a student: no teammates' details or evidence until a faculty account acts.
    expect(strayData.log.participants[0]).toMatchObject({
      email: '',
      studentId: '',
      userId: '',
    });
    expect(
      (strayData.log as unknown as { evidence: unknown[] }).evidence,
    ).toEqual([]);
    const strayTry = await review(strayToken, {
      action: 'approve',
      verified: true,
    });
    expect(strayTry.status).toBe(403);
    expect(messages(strayTry.body as Body<unknown>)).toMatch(
      /Sign up or log in/,
    );
    // CIEL PK names someone else: the old link stops working.
    await h
      .as(admin)
      .patch(`/admin/quick-work/${stray.id}/faculty`)
      .send({ facultyName: 'Dr Real', facultyEmail: faculty.email })
      .expect(200);
    expect(
      (
        await h
          .as(null)
          .get(
            `/quick-work/faculty-review?token=${encodeURIComponent(strayToken)}`,
          )
      ).status,
    ).toBe(404);

    // Registered faculty: the email has the flashcard and acts from the link.
    const log = await draft(
      lead,
      completeLog(lead, faculty, { title: 'Flashcard drive' }),
    );
    h.mail.reset();
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    const mail = h.mail.of('sendQuickWorkSubmittedForReview')[0].args[0] as {
      to: string;
      reviewToken: string;
      card: {
        activityType: string;
        teamMinutes: number;
        evidenceCount: number;
      };
    };
    expect(mail.to).toBe(faculty.email);
    expect(mail.card).toMatchObject({
      activityType: 'Pinktober event',
      teamMinutes: 60,
      evidenceCount: 1,
    });
    const preview = await h
      .as(null)
      .get(
        `/quick-work/faculty-review?token=${encodeURIComponent(mail.reviewToken)}`,
      );
    const full = (preview.body as Body<Preview>).data;
    expect(full).toMatchObject({
      open: true,
      registered: true,
      approveBlockedReason: null,
    });
    expect(full.log.participants[0]).toMatchObject({
      email: lead.email,
      userId: '',
    });
    expect(
      (full.log as unknown as { evidence: unknown[] }).evidence,
    ).toHaveLength(1);
    expect(
      (
        await review(tampered(mail.reviewToken), {
          action: 'approve',
          verified: true,
        })
      ).status,
    ).toBe(404);
    expect((await review(mail.reviewToken, { action: 'approve' })).status).toBe(
      400,
    );
    expect((await review(mail.reviewToken, { action: 'changes' })).status).toBe(
      400,
    );
    const approved = await review(mail.reviewToken, {
      action: 'approve',
      verified: true,
    });
    expect(approved.status).toBe(201);
    expect((approved.body as Body<Preview>).data).toMatchObject({
      open: false,
      log: { status: 'admin_review' },
    });
    // Same record as the dashboard: now with CIEL PK for final approval, and the link is spent.
    const mine = await h.as(lead).get('/quick-work/me');
    expect(
      (
        mine.body as Body<{ logs: (LogView & { status: string })[] }>
      ).data.logs.find((l) => l.id === log.id)?.status,
    ).toBe('admin_review');
    expect(
      (await review(mail.reviewToken, { action: 'reject', note: 'x' })).status,
    ).toBe(400);
    const audit = await h.as(admin).get(`/admin/quick-work/${log.id}`);
    expect(
      (audit.body as Body<{ history: { action: string }[] }>).data.history.map(
        (x) => x.action,
      ),
    ).toContain('email_approved');
  });

  it('a student’s submit emails to faculty are capped per day; later submits still reach the dashboard', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    h.mail.reset();
    for (let i = 0; i < 11; i++) {
      const log = await draft(
        lead,
        completeLog(
          lead,
          { email: `outside.${i}@e2e.test` },
          {
            title: `Capped ${i}`,
            activityDate: pastDay(30 + i),
          },
        ),
      );
      await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    }
    expect(h.mail.of('sendQuickWorkSubmittedForReview')).toHaveLength(10);
  });

  it('a draft can be deleted; malformed ids are a 400, never a 500', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    const log = await draft(lead, completeLog(lead, faculty));
    await h.as(lead).del(`/quick-work/logs/${log.id}`).expect(200);
    expect((await h.as(lead).get(`/quick-work/logs/${log.id}`)).status).toBe(
      404,
    );
    expect((await h.as(lead).get('/quick-work/logs/not-a-uuid')).status).toBe(
      400,
    );
  });

  it('a faculty account not authorised for the students’ university cannot approve', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    // E.g. a "faculty" account the student made with another email address.
    const unlinked = await h.makeUser(UserRole.FACULTY);
    const log = await draft(lead, completeLog(lead, unlinked));
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);

    const queue = await h.as(unlinked).get('/faculty/quick-work');
    const item = (
      queue.body as Body<{
        pending: (LogView & { approveBlockedReason: string | null })[];
      }>
    ).data.pending.find((l) => l.id === log.id);
    expect(item?.approveBlockedReason).toMatch(
      /not yet linked to a university/,
    );
    const res = await h
      .as(unlinked)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true });
    expect(res.status).toBe(403);

    // Faculty authorised for a different university cannot approve these students either.
    const otherUni = await h.makeOrg('Other E2E University', 'university');
    const elsewhere = await authorisedFaculty(otherUni);
    const log2 = await draft(
      lead,
      completeLog(lead, elsewhere, { activityDate: pastDay(8) }),
    );
    await h.as(lead).post(`/quick-work/logs/${log2.id}/submit`).expect(201);
    const res2 = await h
      .as(elsewhere)
      .post(`/faculty/quick-work/${log2.id}/review`)
      .send({ action: 'approve', verified: true });
    expect(res2.status).toBe(403);
    expect(messages(res2.body as Body<unknown>)).toMatch(
      /is not a student of Other E2E University/,
    );

    // Returning the log is still allowed, so it never gets stuck with them.
    await h
      .as(elsewhere)
      .post(`/faculty/quick-work/${log2.id}/review`)
      .send({ action: 'changes', note: 'Not my student' })
      .expect(201);
  });

  it('admin: lists and exports logs, reassigns a stuck log’s faculty, and can review it', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const log = await draft(
      lead,
      completeLog(
        lead,
        { email: 'nobody.here@e2e.test' },
        {
          title: 'Stuck tree drive',
          activityDate: pastDay(10),
        },
      ),
    );
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);

    // Only CIEL PK admins.
    expect((await h.as(lead).get('/admin/quick-work')).status).toBe(403);

    type AdminList = {
      rows: { id: string; facultyHasAccount: boolean; minutes: number }[];
      total: number;
      counts: Record<string, number>;
    };
    const list = await h
      .as(admin)
      .get('/admin/quick-work?status=submitted&search=Stuck%20tree');
    expect(list.status).toBe(200);
    const data = (list.body as Body<AdminList>).data;
    const row = data.rows.find((r) => r.id === log.id);
    expect(row).toMatchObject({ facultyHasAccount: false, minutes: 60 });
    expect(data.counts.submitted).toBeGreaterThanOrEqual(1);
    expect(
      (await h.as(admin).get('/admin/quick-work?from=yesterday')).status,
    ).toBe(400);

    const faculty = await authorisedFaculty();
    h.mail.reset();
    const moved = await h
      .as(admin)
      .patch(`/admin/quick-work/${log.id}/faculty`)
      .send({
        facultyName: 'Dr Real Reviewer',
        facultyEmail: faculty.email,
        note: 'Student typed a wrong email',
      });
    expect(moved.status).toBe(200);
    expect(h.mail.of('sendQuickWorkSubmittedForReview')).toHaveLength(1);
    const queue = await h.as(faculty).get('/faculty/quick-work');
    expect(
      (queue.body as Body<{ pending: LogView[] }>).data.pending.map(
        (l) => l.id,
      ),
    ).toContain(log.id);

    const exported = await h
      .as(admin)
      .get('/admin/quick-work/export?search=Stuck%20tree');
    expect(exported.status).toBe(200);
    expect(
      (
        exported.body as Body<{
          rows: { logId: string; studentEmail: string; minutes: number }[];
        }>
      ).data.rows.find((r) => r.logId === log.id),
    ).toMatchObject({ studentEmail: lead.email, minutes: 60 });

    const noReason = await h
      .as(admin)
      .post(`/admin/quick-work/${log.id}/review`)
      .send({ action: 'reject' });
    expect(noReason.status).toBe(400);
    const approved = await h
      .as(admin)
      .post(`/admin/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true });
    expect(approved.status).toBe(201);
    const detail = (
      approved.body as Body<{
        status: string;
        history: { action: string; byRole: string | null }[];
      }>
    ).data;
    expect(detail.status).toBe('approved');
    expect(detail.history.map((x) => x.action)).toEqual(
      expect.arrayContaining(['admin_faculty_changed', 'admin_approved']),
    );

    // Reviewed logs keep their reviewer.
    expect(
      (
        await h
          .as(admin)
          .patch(`/admin/quick-work/${log.id}/faculty`)
          .send({ facultyName: 'X', facultyEmail: 'x@e2e.test' })
      ).status,
    ).toBe(400);
  });
});

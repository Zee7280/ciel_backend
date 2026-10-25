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

  /** Creates a draft. Unless `askFaculty` is set, the named faculty is recorded as having accepted
   * coordinating, so tests about other rules need not walk through that step (its own test does). */
  const draft = async (
    lead: E2eUser,
    body: Record<string, unknown>,
    { askFaculty = false }: { askFaculty?: boolean } = {},
  ) => {
    const res = await h.as(lead).post('/quick-work/logs').send(body);
    expect(res.status).toBe(201);
    const log = (res.body as Body<LogView>).data;
    if (!askFaculty) {
      await h.ds.query(
        `UPDATE quick_work_logs SET "facultyConfirmation" = 'accepted' WHERE id = $1 AND "facultyConfirmation" IS NOT NULL`,
        [log.id],
      );
    }
    return log;
  };

  /** The token with one character in the middle changed. */
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
    expect((ok.body as Body<LogView>).data.status).toBe('approved');

    const again = await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'reject', note: 'late' });
    expect(again.status).toBe(400);

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

  it('starting a log asks the faculty to accept and emails each teammate; submit waits for both', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const otherFaculty = await authorisedFaculty();
    type Seen = LogView & { facultyConfirmation: string | null };

    h.mail.reset();
    const log = await draft(
      lead,
      completeLog(lead, faculty, {
        mode: 'team',
        title: 'Faculty asked first',
        teammates: [{ email: mate.email, studentId: 'M-77', name: 'Mate' }],
        attendance: [lead, mate].map((u) => ({
          email: u.email,
          present: true,
          startTime: '10:00',
          endTime: '11:00',
          breakMinutes: 0,
        })),
      }),
      { askFaculty: true },
    );
    expect((log as Seen).facultyConfirmation).toBe('pending');
    const asked = h.mail.of('sendQuickWorkFacultyRequest');
    expect(asked).toHaveLength(1);
    expect(asked[0].args[0]).toMatchObject({
      to: faculty.email,
      title: 'Faculty asked first',
    });
    const invites = await mailsOf('sendQuickWorkTeamInvite', 1);
    expect(invites).toHaveLength(1);
    expect(invites[0].args[0]).toMatchObject({ to: mate.email });

    // Saving again without changing the faculty or team sends nothing new.
    await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ title: 'Faculty asked first' })
      .expect(200);
    expect(h.mail.of('sendQuickWorkFacultyRequest')).toHaveLength(1);
    expect(h.mail.of('sendQuickWorkTeamInvite')).toHaveLength(1);

    // A re-send is limited to once an hour.
    const tooSoon = await h
      .as(lead)
      .post(`/quick-work/logs/${log.id}/faculty-request`);
    expect(tooSoon.status).toBe(400);
    expect(messages(tooSoon.body as Body<unknown>)).toMatch(/sent recently/);

    // The teammate answers from the emailed link, without signing in; opening it records nothing.
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
    await h
      .as(null)
      .post('/quick-work/email-response')
      .send({ token: mateToken, accept: true })
      .expect(201);
    const mateView = await h.as(mate).get(`/quick-work/logs/${log.id}`);
    expect(
      (mateView.body as Body<LogView>).data.participants.find(
        (p) => p.email === mate.email,
      )?.joinStatus,
    ).toBe('joined');
    const facultyToken = (asked[0].args[0] as { respondToken: string })
      .respondToken;
    const early = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(early.status).toBe(400);
    expect(messages(early.body as Body<unknown>)).toMatch(
      /has not accepted coordinating/,
    );

    // The faculty sees the request; nobody else can answer it.
    const queue = await h.as(faculty).get('/faculty/quick-work');
    expect(
      (queue.body as Body<{ requests: Seen[] }>).data.requests.find(
        (l) => l.id === log.id,
      )?.facultyConfirmation,
    ).toBe('pending');
    expect(
      (
        await h
          .as(otherFaculty)
          .post(`/faculty/quick-work/${log.id}/coordination`)
          .send({ accept: true })
      ).status,
    ).toBe(404);

    // Declined: submit names the reason; the lead names someone else, who is asked in turn.
    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/coordination`)
      .send({ accept: false })
      .expect(201);
    const declined = await h.as(lead).post(`/quick-work/logs/${log.id}/submit`);
    expect(messages(declined.body as Body<unknown>)).toMatch(
      /declined to coordinate/,
    );
    h.mail.reset();
    const moved = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ facultyName: 'Dr Other', facultyEmail: otherFaculty.email });
    expect((moved.body as Body<Seen>).data.facultyConfirmation).toBe('pending');
    const newRequest = h.mail.of('sendQuickWorkFacultyRequest')[0].args[0] as {
      to: string;
      respondToken: string;
    };
    expect(newRequest.to).toBe(otherFaculty.email);

    // The first faculty member's link stopped working when the lead named someone else.
    expect(
      (
        await h
          .as(null)
          .post('/quick-work/email-response')
          .send({ token: facultyToken, accept: true })
      ).status,
    ).toBe(404);

    // The new faculty member accepts from the email; the dashboard shows the same answer.
    const fromEmail = await h
      .as(null)
      .post('/quick-work/email-response')
      .send({ token: newRequest.respondToken, accept: true });
    expect(fromEmail.status).toBe(201);
    expect(
      (fromEmail.body as Body<Record<string, unknown>>).data,
    ).toMatchObject({ kind: 'faculty', answer: 'accepted' });
    const dash = await h.as(otherFaculty).get('/faculty/quick-work');
    expect(
      (dash.body as Body<{ requests: Seen[] }>).data.requests.find(
        (l) => l.id === log.id,
      )?.facultyConfirmation,
    ).toBe('accepted');
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    expect(h.mail.of('sendQuickWorkSubmittedForReview')).toHaveLength(1);

    // Once submitted, the coordination request is closed.
    expect(
      (
        await h
          .as(otherFaculty)
          .post(`/faculty/quick-work/${log.id}/coordination`)
          .send({ accept: false })
      ).status,
    ).toBe(400);
  });

  it('a log cannot be used to email faculty addresses over and over', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const log = await draft(
      lead,
      completeLog(lead, { email: 'first.faculty@e2e.test' }),
      { askFaculty: true },
    );
    h.mail.reset();
    // The first request was sent on create; four more different addresses are allowed today.
    for (let i = 2; i <= 5; i++) {
      await h
        .as(lead)
        .patch(`/quick-work/logs/${log.id}`)
        .send({ facultyEmail: `faculty.${i}@e2e.test` })
        .expect(200);
    }
    const sixth = await h
      .as(lead)
      .patch(`/quick-work/logs/${log.id}`)
      .send({ facultyEmail: 'faculty.6@e2e.test' });
    expect(sixth.status).toBe(400);
    expect(messages(sixth.body as Body<unknown>)).toMatch(
      /too many times today/,
    );
    expect(h.mail.of('sendQuickWorkFacultyRequest')).toHaveLength(4);
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

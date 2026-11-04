/**
 * Quick Community Impact, every field (real Nest app + scratch Postgres):
 *  - several SDGs (a main goal plus up to four) save, normalise and reach every reader;
 *  - each field's limits and formats are enforced on a draft save, and each submit rule on submit.
 */
import { bootHarness, E2eUser, Harness } from './e2e/harness';
import { UserRole } from '../src/users/enums/user-role.enum';
import { S3Service } from '../src/common/s3.service';

type Body<T> = { data: T; message?: string | string[] };
type LogView = {
  id: string;
  status: string;
  sdg: number | null;
  secondarySdgs: number[];
  certificate: { code: string } | null;
};

const pastDay = (d: number) =>
  new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const uniq = () => Math.random().toString(36).slice(2, 8);

describe('Quick Impact fields and SDGs (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  let evidenceUrl: (owner: E2eUser) => string;

  beforeAll(async () => {
    h = await bootHarness({ bodyLimit: '50mb' });
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    const s3 = h.app.get<unknown, { bucket: string; region: string }>(
      S3Service,
    );
    evidenceUrl = (owner) =>
      `https://${s3.bucket}.s3.${s3.region}.amazonaws.com/quick-work/${owner.id}/photo.jpg`;
  });
  afterAll(async () => {
    await h.app.close();
  });

  const messages = (body: unknown) =>
    ([] as string[]).concat((body as Body<unknown>).message ?? []).join(' | ');

  const university = () => h.makeOrg('E2E University', 'university');
  const authorisedFaculty = async () => {
    const org = await university();
    const faculty = await h.makeUser(UserRole.FACULTY);
    await h
      .as(admin)
      .post('/admin/faculty-university-scope')
      .send({ facultyUserId: faculty.id, universityOrganizationId: org.id })
      .expect(201);
    return faculty;
  };

  /** A complete solo log on a past day; `over` changes any field. */
  const complete = (
    lead: E2eUser,
    faculty: { email: string },
    over: Record<string, unknown> = {},
  ) => ({
    mode: 'solo',
    leadStudentId: `SID-${lead.id.slice(0, 6)}`,
    university: 'E2E University',
    department: 'Computer Science',
    facultyName: 'Dr Reviewer',
    facultyEmail: faculty.email,
    title: `Pinktober ${uniq()}`,
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

  /* ------------------------------------------------------------------ several SDGs */

  it('SDGs: a main goal plus others save in order, without repeats, and an older client cannot break them', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const log = await draft(
      lead,
      complete(lead, faculty, { sdg: 3, secondarySdgs: [13, 3, 13, 7] }),
    );
    expect([log.sdg, log.secondarySdgs]).toEqual([3, [13, 7]]);
    const patch = (body: Record<string, unknown>) =>
      h.as(lead).patch(`/quick-work/logs/${log.id}`).send(body);
    const read = async () =>
      (
        (await h.as(lead).get(`/quick-work/logs/${log.id}`))
          .body as Body<LogView>
      ).data;

    // Changing only the main goal keeps the others (minus a repeat of the new main).
    expect((await patch({ sdg: 13 })).status).toBe(200);
    expect([(await read()).sdg, (await read()).secondarySdgs]).toEqual([
      13,
      [7],
    ]);
    // The others alone: with no main goal, the first becomes the main one.
    expect((await patch({ sdg: null, secondarySdgs: [15, 11] })).status).toBe(
      200,
    );
    expect([(await read()).sdg, (await read()).secondarySdgs]).toEqual([
      15,
      [11],
    ]);
    // An older client that only knows the main goal and clears it means "no SDG at all".
    expect((await patch({ sdg: null })).status).toBe(200);
    expect([(await read()).sdg, (await read()).secondarySdgs]).toEqual([
      null,
      [],
    ]);
    // Not sending either leaves them alone.
    await patch({ sdg: 4, secondarySdgs: [5] });
    expect((await patch({ title: 'Renamed' })).status).toBe(200);
    expect([(await read()).sdg, (await read()).secondarySdgs]).toEqual([
      4,
      [5],
    ]);
  });

  it('SDGs: out-of-range goals and more than five are refused', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const log = await draft(lead, { mode: 'solo' });
    const patch = (body: Record<string, unknown>) =>
      h.as(lead).patch(`/quick-work/logs/${log.id}`).send(body);
    expect((await patch({ sdg: 0 })).status).toBe(400);
    expect((await patch({ sdg: 18 })).status).toBe(400);
    expect((await patch({ secondarySdgs: [0] })).status).toBe(400);
    expect((await patch({ secondarySdgs: [18] })).status).toBe(400);
    expect((await patch({ secondarySdgs: [2.5] })).status).toBe(400);
    expect((await patch({ secondarySdgs: ['x'] })).status).toBe(400);
    expect((await patch({ secondarySdgs: [1, 2, 3, 4, 5] })).status).toBe(400); // 1 main + 5 = 6
    expect((await patch({ sdg: 1, secondarySdgs: [2, 3, 4, 5] })).status).toBe(
      200,
    ); // exactly five
  });

  it('SDGs reach every reader: the student, the review email, the certificate check and the partner wall', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const faculty = await authorisedFaculty();
    const hostEmail = `host.${uniq()}@ngo.test`;
    const ngo = await h.makeUser(UserRole.NGO, {
      email: hostEmail,
      org: await h.makeOrg('Host NGO', 'NGO'),
    });
    const log = await draft(
      lead,
      complete(lead, faculty, {
        sdg: 3,
        secondarySdgs: [13, 7],
        host: 'Host NGO',
        hostEmail,
      }),
    );
    h.mail.reset();
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    const review = h.mail.of('sendQuickWorkSubmittedForReview');
    expect(review).toHaveLength(1);
    expect(
      (review[0].args[0] as { card: { sdg: number; secondarySdgs: number[] } })
        .card,
    ).toMatchObject({ sdg: 3, secondarySdgs: [13, 7] });

    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);
    await h
      .as(admin)
      .post(`/admin/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);

    const mine = (
      (await h.as(lead).get(`/quick-work/logs/${log.id}`)).body as Body<LogView>
    ).data;
    expect([mine.sdg, mine.secondarySdgs]).toEqual([3, [13, 7]]);
    expect(mine.certificate?.code).toBeTruthy();

    const verify = await h
      .as(null)
      .get(`/quick-work/certificates/${mine.certificate?.code}`);
    expect(verify.status).toBe(200);
    expect(
      (verify.body as Body<{ sdg: number; secondarySdgs: number[] }>).data,
    ).toMatchObject({ sdg: 3, secondarySdgs: [13, 7] });

    const wall = await h.as(ngo).get('/partner/quick-impact');
    const rows = (
      wall.body as Body<
        { id: string; sdgs: { n: number; main: boolean }[]; sdg: number }[]
      >
    ).data;
    const row = rows.find((r) => r.id === log.id);
    expect(row?.sdg).toBe(3);
    expect(row?.sdgs.map((g) => [g.n, g.main])).toEqual([
      [3, true],
      [13, false],
      [7, false],
    ]);
    // The partner's flashcard email was produced for the same log.
    expect(
      h.mail
        .of('sendQuickImpactPartnerFlashcard')
        .map((c) => (c.args[0] as { to: string }).to),
    ).toContain(hostEmail);
  });

  /* ------------------------------------------------------------------ draft save: formats and limits */

  it('a draft refuses badly formatted values and values over a limit, and says which', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const log = await draft(lead, { mode: 'solo' });
    const patch = (body: Record<string, unknown>) =>
      h.as(lead).patch(`/quick-work/logs/${log.id}`).send(body);
    const long = (n: number) => 'x'.repeat(n);
    const refused: [string, Record<string, unknown>, RegExp | null][] = [
      ['date not a date', { activityDate: '2026-13-40' }, /YYYY-MM-DD/],
      ['date wrong shape', { activityDate: '3/11/2026' }, /YYYY-MM-DD|shorter/],
      ['start time 25:00', { startTime: '25:00' }, /HH:MM/],
      ['end time 9:5', { endTime: '9:5' }, /HH:MM/],
      ['pin text', { locationPin: 'near the gate' }, /latitude and longitude/],
      ['pin out of range', { locationPin: '95,10' }, /latitude and longitude/],
      ['host email', { hostEmail: 'not-an-email' }, /valid email/],
      [
        'host contact',
        { hostContact: 'call me' },
        /Contact numbers can only have/,
      ],
      [
        'partner email',
        { partnerDetails: [{ name: 'Org', email: 'nope', contact: null }] },
        /valid email/,
      ],
      [
        'partner contact',
        { partnerDetails: [{ name: 'Org', email: null, contact: 'abc' }] },
        /Contact numbers can only have/,
      ],
      [
        'teammate contact',
        {
          mode: 'team',
          title: 'T',
          teammates: [{ email: 'x@y.pk', studentId: 'S1', contact: 'abc' }],
        },
        /Contact numbers can only have/,
      ],
      ['mode', { mode: 'group' }, null],
      ['visibility', { visibility: 'Everyone' }, null],
      ['title 121 chars', { title: long(121) }, null],
      ['activity type other 61 chars', { activityTypeOther: long(61) }, null],
      ['location 181 chars', { location: long(181) }, null],
      ['host 121 chars', { host: long(121) }, null],
      ['faculty name 101 chars', { facultyName: long(101) }, null],
      ['faculty email 121 chars', { facultyEmail: long(121) }, null],
      ['student id 61 chars', { leadStudentId: long(61) }, null],
      ['summary 1001 chars', { summary: long(1001) }, null],
      ['people reached negative', { peopleReached: -1 }, null],
      ['people reached over 10M', { peopleReached: 10_000_001 }, null],
      ['people reached decimal', { peopleReached: 2.5 }, null],
      ['people target 0', { peopleTarget: 0 }, null],
      ['people target over 10M', { peopleTarget: 10_000_001 }, null],
      [
        'break over 24 h',
        {
          attendance: [
            {
              email: lead.email,
              present: true,
              startTime: '10:00',
              endTime: '11:00',
              breakMinutes: 1441,
            },
          ],
        },
        null,
      ],
      [
        'caption 161 chars',
        {
          evidence: [
            {
              url: evidenceUrl(lead),
              name: 'p.jpg',
              type: 'image/jpeg',
              size: 10,
              caption: long(161),
            },
          ],
        },
        null,
      ],
      [
        'evidence type not allowed',
        {
          evidence: [
            {
              url: evidenceUrl(lead),
              name: 'p.exe',
              type: 'application/x-msdownload',
              size: 10,
              caption: 'x',
            },
          ],
        },
        null,
      ],
      [
        'evidence from someone else’s folder',
        {
          evidence: [
            {
              url: `https://example-bucket.s3.eu-west-1.amazonaws.com/quick-work/${uniq()}/p.jpg`,
              name: 'p.jpg',
              type: 'image/jpeg',
              size: 10,
              caption: 'x',
            },
          ],
        },
        /again from this form|bucket/i,
      ],
    ];
    for (const [label, body, message] of refused) {
      const res = await patch(body);
      expect({ label, status: res.status }).toEqual({ label, status: 400 });
      if (message) {
        expect({ label, text: messages(res.body) }).toEqual({
          label,
          text: expect.stringMatching(message) as unknown,
        });
      }
    }
    // Nothing from the refused requests was kept.
    const kept = (
      (await h.as(lead).get(`/quick-work/logs/${log.id}`)).body as Body<
        Record<string, unknown>
      >
    ).data;
    expect(kept).toMatchObject({
      activityDate: null,
      startTime: null,
      locationPin: null,
      hostEmail: null,
      hostContact: null,
      peopleReached: null,
      peopleTarget: null,
    });

    // A number still being typed is saved by the draft (autosave runs on every keystroke).
    expect((await patch({ hostContact: '+9230' })).status).toBe(200);
    await patch({ hostContact: null });

    // The same fields with good values are accepted.
    const good = await patch({
      activityDate: pastDay(2),
      startTime: '09:00',
      endTime: '10:30',
      locationPin: '31.36497, 74.21606129999999',
      hostEmail: 'Host@NGO.test',
      hostContact: '+92 300 1234567',
      peopleReached: 10_000_000,
      peopleTarget: 1,
      partnerDetails: [
        { name: 'Org', email: 'info@org.pk', contact: '+923215550000' },
      ],
    });
    expect(good.status).toBe(200);
    expect((good.body as Body<{ hostEmail: string }>).data.hostEmail).toBe(
      'host@ngo.test',
    );
  });

  /* ------------------------------------------------------------------ submit rules */

  it('submit names each missing or invalid field, and a complete log goes through', async () => {
    const faculty = await authorisedFaculty();
    const mate = await h.makeUser(UserRole.STUDENT);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const cases: [
      string,
      (lead: E2eUser) => Record<string, unknown>,
      RegExp,
    ][] = [
      [
        'no title',
        () => ({ title: '' }),
        /activity title, type, date and venue/,
      ],
      [
        'no activity type',
        () => ({ activityType: '' }),
        /activity title, type, date and venue/,
      ],
      [
        'no venue',
        () => ({ location: '  ' }),
        /activity title, type, date and venue/,
      ],
      [
        'no date',
        () => ({ activityDate: null }),
        /activity title, type, date and venue/,
      ],
      [
        'type not in the list',
        () => ({ activityType: 'Bake sale' }),
        /Choose an activity type from the list/,
      ],
      [
        '“Other” without a description',
        () => ({
          activityType: 'Other service activity',
          activityTypeOther: ' ',
        }),
        /Describe the activity type for “Other”/,
      ],
      [
        'future date',
        () => ({ activityDate: tomorrow }),
        /today or a past activity/,
      ],
      [
        'no times',
        () => ({ startTime: null, endTime: null }),
        /end time after the start time/,
      ],
      [
        'end before start',
        () => ({ startTime: '11:00', endTime: '10:00' }),
        /end time after the start time/,
      ],
      [
        'end equals start',
        () => ({ startTime: '10:00', endTime: '10:00' }),
        /end time after the start time/,
      ],
      [
        'no faculty name',
        () => ({ facultyName: '' }),
        /coordinating faculty name and valid email/,
      ],
      [
        'no faculty email',
        () => ({ facultyEmail: '' }),
        /coordinating faculty name and valid email/,
      ],
      [
        'bad faculty email',
        () => ({ facultyEmail: 'dr.at.uni' }),
        /coordinating faculty name and valid email/,
      ],
      [
        'no university',
        () => ({ university: '' }),
        /university and department/,
      ],
      [
        'no department',
        () => ({ department: '' }),
        /university and department/,
      ],
      [
        'no student id',
        () => ({ leadStudentId: '' }),
        /full name and student ID/,
      ],
      [
        'faculty is a participant',
        (lead) => ({ facultyEmail: lead.email }),
        /faculty email cannot be a participant/,
      ],
      [
        'team with no teammate',
        () => ({ mode: 'team' }),
        /Add a teammate or select “Just me”/,
      ],
      [
        'teammate reuses a student id',
        (lead) => ({
          mode: 'team',
          teammates: [
            {
              email: mate.email,
              studentId: `SID-${lead.id.slice(0, 6)}`,
              name: 'Mate',
            },
          ],
        }),
        /unique student ID/,
      ],
      [
        'nobody present',
        (lead) => ({
          attendance: [
            {
              email: lead.email,
              present: false,
              startTime: null,
              endTime: null,
              breakMinutes: 0,
            },
          ],
        }),
        /at least one participant as present/,
      ],
      [
        'no arrival / departure',
        (lead) => ({
          attendance: [
            {
              email: lead.email,
              present: true,
              startTime: null,
              endTime: null,
              breakMinutes: 0,
            },
          ],
        }),
        /Check the arrival, departure and break/,
      ],
      [
        'break swallows the whole stay',
        (lead) => ({
          attendance: [
            {
              email: lead.email,
              present: true,
              startTime: '10:00',
              endTime: '11:00',
              breakMinutes: 60,
            },
          ],
        }),
        /Check the arrival, departure and break/,
      ],
      [
        'attendance outside the event window',
        (lead) => ({
          attendance: [
            {
              email: lead.email,
              present: true,
              startTime: '09:30',
              endTime: '11:00',
              breakMinutes: 0,
            },
          ],
        }),
        /inside the event time window/,
      ],
      [
        'more than 9 hours in a day',
        (lead) => ({
          startTime: '06:00',
          endTime: '17:00',
          attendance: [
            {
              email: lead.email,
              present: true,
              startTime: '06:00',
              endTime: '17:00',
              breakMinutes: 0,
            },
          ],
        }),
        /9-hour daily service limit/,
      ],
      [
        'host contact started but not finished',
        () => ({ host: 'Host NGO', hostContact: '+9230' }),
        /complete contact number for the host organisation/,
      ],
      [
        'no description',
        () => ({ summary: '   ' }),
        /Briefly describe the activity/,
      ],
      [
        'no evidence',
        () => ({ evidence: [] }),
        /Attach at least one photo or PDF/,
      ],
      [
        'evidence without a caption',
        (lead) => ({
          evidence: [
            {
              url: evidenceUrl(lead),
              name: 'p.jpg',
              type: 'image/jpeg',
              size: 10,
              caption: '  ',
            },
          ],
        }),
        /short caption to each evidence file/,
      ],
      [
        'no consent',
        () => ({ consent: false }),
        /evidence consent and the attendance declaration/,
      ],
      [
        'no honesty declaration',
        () => ({ honest: false }),
        /evidence consent and the attendance declaration/,
      ],
    ];
    for (const [label, over, message] of cases) {
      const lead = await h.makeUser(UserRole.STUDENT);
      const res = await h
        .as(lead)
        .post('/quick-work/logs')
        .send(complete(lead, faculty, over(lead)));
      expect({ label, created: res.status }).toEqual({ label, created: 201 });
      const id = (res.body as Body<LogView>).data.id;
      const sub = await h.as(lead).post(`/quick-work/logs/${id}/submit`);
      expect({ label, status: sub.status }).toEqual({ label, status: 400 });
      expect({ label, text: messages(sub.body) }).toEqual({
        label,
        text: expect.stringMatching(message) as unknown,
      });
    }

    // Every optional field left out: a complete log still goes through.
    const lead = await h.makeUser(UserRole.STUDENT);
    const minimal = complete(lead, faculty, {
      sdg: null,
      host: null,
      hostEmail: null,
      peopleReached: null,
      locationPin: null,
    });
    const created = await draft(lead, minimal);
    const sub = await h.as(lead).post(`/quick-work/logs/${created.id}/submit`);
    expect(sub.status).toBe(201);
    expect((sub.body as Body<LogView>).data.status).toBe('submitted');
  });
});

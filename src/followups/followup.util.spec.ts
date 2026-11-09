import { createHmac } from 'crypto';
import {
  addDaysIso,
  addMonthsIso,
  buildProjectReference,
  csvCell,
  decideDispatch,
  followUpSubject,
  generateFollowUpQuestions,
  hashFollowUpToken,
  isMailWebhookAuthorized,
  karachiToday,
  newFollowUpToken,
  normalizeMailWebhookEvents,
  resolveFollowUpDueDate,
  resolveProjectEndDate,
  summarizeOutcomes,
  tokenLooksValid,
} from './followup.util';

describe('follow-up dates (Asia/Karachi)', () => {
  it('karachiToday rolls over at 19:00 UTC', () => {
    expect(karachiToday(new Date('2026-11-30T18:59:00Z'))).toBe('2026-11-30');
    expect(karachiToday(new Date('2026-11-30T19:00:00Z'))).toBe('2026-12-01');
  });

  it('month arithmetic clamps to the shorter month', () => {
    expect(addMonthsIso('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addDaysIso('2027-02-28', 7)).toBe('2027-03-07');
  });

  it('due date: stored value wins, then custom date, then end + interval', () => {
    const end = resolveProjectEndDate({ timeline: { end_date: '2026-11-30' } });
    expect(end).toBe('2026-11-30');
    expect(
      resolveFollowUpDueDate({ followup_due_date: '2027-02-28' }, end),
    ).toBe('2027-02-28');
    expect(
      resolveFollowUpDueDate(
        { followup_interval: 'custom', followup_custom_date: '2027-05-01' },
        end,
      ),
    ).toBe('2027-05-01');
    expect(resolveFollowUpDueDate({ followup_interval: '6' }, end)).toBe(
      '2027-05-30',
    );
    expect(resolveFollowUpDueDate({ followup_interval: '3' }, '')).toBe('');
  });
});

describe('dispatch decisions', () => {
  const base = {
    dueDate: '2027-02-28',
    reminder1Days: 7,
    reminder2Days: 14,
  };
  it('sends the initial mail on or after the due date, never before', () => {
    expect(
      decideDispatch({ ...base, today: '2027-02-27', sent: new Set() }),
    ).toBeNull();
    expect(
      decideDispatch({ ...base, today: '2027-02-28', sent: new Set() }),
    ).toBe('initial');
    expect(
      decideDispatch({ ...base, today: '2027-03-20', sent: new Set() }),
    ).toBe('initial');
  });

  it('reminders follow the initial mail at +7 and +14 days and never repeat', () => {
    const initial = new Set(['initial'] as const);
    expect(
      decideDispatch({ ...base, today: '2027-03-06', sent: initial }),
    ).toBeNull();
    expect(
      decideDispatch({ ...base, today: '2027-03-07', sent: initial }),
    ).toBe('reminder1');
    const r1 = new Set(['initial', 'reminder1'] as const);
    expect(
      decideDispatch({ ...base, today: '2027-03-13', sent: r1 }),
    ).toBeNull();
    expect(decideDispatch({ ...base, today: '2027-03-14', sent: r1 })).toBe(
      'reminder2',
    );
    const all = new Set(['initial', 'reminder1', 'reminder2'] as const);
    expect(
      decideDispatch({ ...base, today: '2027-06-01', sent: all }),
    ).toBeNull();
  });

  it('reminders count from the day the initial mail really went out, not from the due date', () => {
    const initial = new Set(['initial'] as const);
    // sent early by an admin on 2027-02-01: reminder 1 is due 02-08 (not the due date + 7 = 03-07)
    expect(
      decideDispatch({
        ...base,
        today: '2027-02-07',
        sent: initial,
        initialSentOn: '2027-02-01',
      }),
    ).toBeNull();
    expect(
      decideDispatch({
        ...base,
        today: '2027-02-08',
        sent: initial,
        initialSentOn: '2027-02-01',
      }),
    ).toBe('reminder1');
    const r1Done = new Set(['initial', 'reminder1'] as const);
    expect(
      decideDispatch({
        ...base,
        today: '2027-02-14',
        sent: r1Done,
        initialSentOn: '2027-02-01',
      }),
    ).toBeNull();
    expect(
      decideDispatch({
        ...base,
        today: '2027-02-15',
        sent: r1Done,
        initialSentOn: '2027-02-01',
      }),
    ).toBe('reminder2');
    // sent late (catch-up on 03-20): first reminder 03-27, not the next night
    expect(
      decideDispatch({
        ...base,
        today: '2027-03-21',
        sent: initial,
        initialSentOn: '2027-03-20',
      }),
    ).toBeNull();
    expect(
      decideDispatch({
        ...base,
        today: '2027-03-27',
        sent: initial,
        initialSentOn: '2027-03-20',
      }),
    ).toBe('reminder1');
  });

  it('a late catch-up never skips straight to a reminder', () => {
    expect(
      decideDispatch({ ...base, today: '2027-04-01', sent: new Set() }),
    ).toBe('initial');
  });
});

describe('tokens', () => {
  it('are random, url-safe and only ever stored hashed', () => {
    const a = newFollowUpToken();
    const b = newFollowUpToken();
    expect(a).not.toBe(b);
    expect(tokenLooksValid(a)).toBe(true);
    expect(tokenLooksValid('short')).toBe(false);
    expect(tokenLooksValid('a'.repeat(40) + '/')).toBe(false);
    expect(hashFollowUpToken(a)).toHaveLength(64);
    expect(hashFollowUpToken(a)).toBe(hashFollowUpToken(a));
    expect(hashFollowUpToken(a)).not.toContain(a.slice(0, 8));
  });
});

describe('question generation (rules)', () => {
  const report = {
    section4: {
      activity_blocks: [
        {
          id: 'act1',
          title: 'Classroom painting and LED retrofit',
          status: 'Completed',
          primary_category:
            '🏗️ Built Environment, Infrastructure & Engineering',
          outputs: [
            {
              title: 'Rooms rewired',
              quantity: '6',
              unit: 'Rooms / Classrooms',
            },
          ],
        },
        {
          id: 'act2',
          title: 'Tree plantation along the boundary wall',
          status: 'Completed',
          outputs: [{ type: 'Trees Planted', quantity: '120', unit: 'Trees' }],
        },
        {
          id: 'act3',
          title: 'Teacher training on visual learning',
          status: 'Ongoing',
          outputs: [{ title: 'Trainings Delivered', quantity: '2' }],
        },
        { id: 'act4', title: 'Ration distribution', status: 'Completed' },
        { id: 'act5', title: 'Solar panel installation', status: 'Planned' },
        {
          id: 'act6',
          title: 'Classroom painting and LED retrofit',
          status: 'Completed',
        },
      ],
    },
    section5: {
      measurable_outcomes: [
        {
          activity_id: 'act1',
          metric: 'Attendance rate (%)',
          baseline: '70',
          endline: '90',
        },
      ],
    },
    section10: {
      followup_check: 'Whether the reported benefits are still continuing',
      followup_check_notes: 'Count how many planted trees are still healthy',
    },
  };

  it('asks one distinct question per delivered activity, skips planned / relief / duplicates, caps at 5', () => {
    const qs = generateFollowUpQuestions(report);
    expect(qs.map((q) => q.activityId)).toEqual(['act1', 'act2', 'act3', null]);
    expect(qs[0].questionText).toMatch(/still in use and in working condition/);
    expect(qs[0].countLabel).toBe('Rooms rewired still in use (of 6)');
    expect(qs[0].sourceFieldIds).toEqual([
      'section4.activity_blocks[0]',
      'section5.measurable_outcomes[0]',
    ]);
    expect(qs[0].reason).toBe('Reported change: Attendance rate (%) 70 → 90');
    expect(qs[1].questionText).toMatch(/still alive and being looked after/);
    expect(qs[1].countLabel).toBe('Trees Planted still surviving (of 120)');
    expect(qs[2].questionText).toMatch(/still using what they learned/);
    // The student's own 9.5 note closes the list as the overall question.
    expect(qs[3].questionText).toBe(
      'Please confirm: Count how many planted trees are still healthy.',
    );
    expect(qs[3].sourceFieldIds).toEqual([
      'section10.followup_check',
      'section10.followup_check_notes',
    ]);
    expect(qs.length).toBeLessThanOrEqual(5);
  });

  it('a report with no activities still gets the overall question', () => {
    const qs = generateFollowUpQuestions({ section10: {} });
    expect(qs).toHaveLength(1);
    expect(qs[0].activityId).toBeNull();
    expect(qs[0].questionText).toMatch(
      /benefits reported by the student team still continuing/,
    );
  });

  it('one-time relief alone is still asked about (nothing else to verify)', () => {
    const qs = generateFollowUpQuestions({
      section4: {
        activity_blocks: [
          { id: 'r', title: 'Ration distribution', status: 'Completed' },
        ],
      },
    });
    expect(qs[0].activityId).toBe('r');
  });
});

describe('outcome analytics', () => {
  it('rolls per-question answers into one bucket; no answers is "no response", never "stopped"', () => {
    expect(summarizeOutcomes([]).bucket).toBe('no_response');
    expect(summarizeOutcomes(['yes', 'yes']).bucket).toBe('continuing');
    expect(summarizeOutcomes(['yes', 'partially']).bucket).toBe(
      'partially_continuing',
    );
    expect(summarizeOutcomes(['partially']).bucket).toBe(
      'partially_continuing',
    );
    expect(summarizeOutcomes(['no', 'no']).bucket).toBe('stopped');
    expect(summarizeOutcomes(['yes', 'no']).bucket).toBe('mixed');
    expect(summarizeOutcomes(['unable_to_verify']).bucket).toBe(
      'unable_to_verify',
    );
    expect(summarizeOutcomes(['yes', 'unable_to_verify'])).toEqual({
      bucket: 'continuing',
      yes: 1,
      partially: 0,
      no: 0,
      unable: 1,
      answered: 2,
    });
  });
});

describe('mail provider webhook', () => {
  const secret = 'e2e-mail-webhook-secret-123456';

  it('normalises the generic, Resend and SES shapes and drops unknown events', () => {
    const generic = normalizeMailWebhookEvents({
      events: [
        {
          messageId: 'm1',
          type: 'bounced',
          email: 'A@Partner.test',
          detail: '550 no such user',
        },
        { messageId: 'm2', type: 'delivered' },
        { messageId: 'm3', type: 'opened' },
      ],
    });
    expect(generic.map((e) => [e.messageId, e.type, e.email])).toEqual([
      ['m1', 'bounced', 'a@partner.test'],
      ['m2', 'delivered', ''],
    ]);
    expect(generic[0].detail).toBe('550 no such user');

    const resend = normalizeMailWebhookEvents({
      type: 'email.complained',
      created_at: '2027-03-01T10:00:00Z',
      data: { email_id: 'r-9', to: ['x@partner.test'] },
    });
    expect(resend).toEqual([
      {
        messageId: 'r-9',
        email: 'x@partner.test',
        type: 'complained',
        detail: 'email.complained',
        at: '2027-03-01T10:00:00Z',
      },
    ]);

    const ses = normalizeMailWebhookEvents({
      notificationType: 'Bounce',
      mail: { messageId: 'ses-1', destination: ['y@partner.test'] },
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [
          { emailAddress: 'y@partner.test', diagnosticCode: '550 5.1.1' },
        ],
      },
    });
    expect(ses[0]).toMatchObject({
      messageId: 'ses-1',
      email: 'y@partner.test',
      type: 'bounced',
      detail: '550 5.1.1',
    });

    expect(normalizeMailWebhookEvents(null)).toEqual([]);
    expect(normalizeMailWebhookEvents({ type: 'bounced' })).toEqual([]);
  });

  it('soft bounces read as deferred, delays never as delivered, and SNS-wrapped SES is unwrapped', () => {
    expect(
      normalizeMailWebhookEvents({
        events: [
          {
            messageId: 'm1',
            type: 'bounced',
            email: 'a@x.test',
            detail: 'Mailbox full',
          },
          {
            messageId: 'm2',
            type: 'email.delivery_delayed',
            email: 'b@x.test',
          },
          { messageId: 'm3', type: 'DeliveryDelay', email: 'c@x.test' },
          {
            messageId: 'm4',
            type: 'bounced',
            email: 'd@x.test',
            detail: '550 5.1.1 user unknown',
          },
        ],
      }).map((e) => e.type),
    ).toEqual(['deferred', 'deferred', 'deferred', 'bounced']);
    const sesTransient = normalizeMailWebhookEvents({
      notificationType: 'Bounce',
      mail: { messageId: 'ses-2' },
      bounce: {
        bounceType: 'Transient',
        bounceSubType: 'MailboxFull',
        bouncedRecipients: [{ emailAddress: 'e@x.test' }],
      },
    });
    expect(sesTransient[0].type).toBe('deferred');
    const wrapped = normalizeMailWebhookEvents({
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Complaint',
        mail: { messageId: 'ses-3' },
        complaint: { complainedRecipients: [{ emailAddress: 'f@x.test' }] },
      }),
    });
    expect(wrapped[0]).toMatchObject({
      messageId: 'ses-3',
      email: 'f@x.test',
      type: 'complained',
    });
    expect(
      normalizeMailWebhookEvents({
        Type: 'Notification',
        Message: '{not json',
      }),
    ).toEqual([]);
  });

  it('authorises by bearer secret or raw-body HMAC and fails closed', () => {
    const rawBody = Buffer.from('{"events":[]}');
    const hmac = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(
      isMailWebhookAuthorized({ secret, authorization: `Bearer ${secret}` }),
    ).toBe(true);
    expect(
      isMailWebhookAuthorized({ secret, authorization: 'Bearer nope' }),
    ).toBe(false);
    expect(
      isMailWebhookAuthorized({ secret, signature: `sha256=${hmac}`, rawBody }),
    ).toBe(true);
    expect(isMailWebhookAuthorized({ secret, signature: hmac, rawBody })).toBe(
      true,
    );
    expect(
      isMailWebhookAuthorized({
        secret,
        signature: `sha256=${hmac}`,
        rawBody: Buffer.from('tampered'),
      }),
    ).toBe(false);
    expect(
      isMailWebhookAuthorized({ secret, signature: `sha256=${hmac}` }),
    ).toBe(false);
    expect(
      isMailWebhookAuthorized({
        secret: 'short',
        authorization: 'Bearer short',
      }),
    ).toBe(false);
    expect(
      isMailWebhookAuthorized({ secret: undefined, authorization: 'Bearer x' }),
    ).toBe(false);
  });

  it('csv cells are quoted and formula-safe', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(csvCell(null)).toBe('""');
  });
});

describe('project reference and subject', () => {
  it('reads the opportunity and report fields the email shows', () => {
    const ref = buildProjectReference(
      {
        id: 'rep-uuid',
        publicId: 'CIEL-BNU-2026-0421',
        section1: {
          team_lead: { fullName: 'Ayesha Khan', universityName: 'BNU' },
          team_members: [{ name: 'Bilal Ahmed' }],
        },
        section2: {
          affected_group: 'primary school children',
          affected_count: '120',
        },
        section4: { project_summary: { distinct_total_beneficiaries: 120 } },
      },
      {
        id: 'opp-uuid',
        title: 'Classroom lighting retrofit',
        organization: { name: 'SOS Children’s Villages' },
        location: { venue: 'SOS Village', city: 'Lahore' },
        timeline: { start_date: '2026-10-01', end_date: '2026-11-30' },
        objectives: {
          description: 'Improve the classroom learning environment.',
        },
      },
    );
    expect(ref).toEqual({
      title: 'Classroom lighting retrofit',
      projectId: 'opp-uuid',
      reportId: 'CIEL-BNU-2026-0421',
      host: 'SOS Children’s Villages',
      university: 'BNU',
      location: 'SOS Village, Lahore',
      periodStart: '2026-10-01',
      periodEnd: '2026-11-30',
      objective: 'Improve the classroom learning environment.',
      beneficiaries: '120 primary school children',
      studentTeam: 'Ayesha Khan, Bilal Ahmed',
    });
    expect(followUpSubject('reminder1', 'opp-uuid', ref.title)).toBe(
      'CIEL PK | Reminder: impact follow-up | opp-uuid | Classroom lighting retrofit',
    );
  });
});

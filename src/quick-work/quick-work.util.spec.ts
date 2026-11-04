import {
  attendanceMinutes,
  cleanPartners,
  hasPhoneCharsOnly,
  isClockTime,
  isPlausiblePhone,
  isValidMapPin,
  normalizeSdgs,
  isCreditedParticipant,
  normalizeCertificateCode,
  partnerLabel,
  partnerList,
  minutesOfDay,
  pktNow,
  quickWorkCertificateCode,
  quickWorkSubmitErrors,
  QuickWorkSubmitInput,
  timesOverlap,
} from './quick-work.util';

const lead = {
  name: 'Ayesha',
  email: 'a@x.pk',
  studentId: 'S1',
  isLead: true,
  joinStatus: 'joined',
  present: true,
  startTime: '10:00',
  endTime: '11:00',
  breakMinutes: 0,
};

const complete = (
  over: Partial<QuickWorkSubmitInput> = {},
): QuickWorkSubmitInput => ({
  mode: 'solo',
  university: 'BNU',
  department: 'SMS',
  facultyName: 'Dr F',
  facultyEmail: 'f@x.pk',
  title: 'Pinktober',
  activityType: 'Pinktober event',
  activityDate: '2026-10-20',
  startTime: '10:00',
  endTime: '11:00',
  location: 'Lahore',
  peopleReached: null,
  summary: 'We ran a desk.',
  visibility: 'Faculty, University & CIEL PK only',
  consent: true,
  honest: true,
  evidence: [{ caption: 'Desk' }],
  participants: [lead],
  ...over,
});

// 2026-10-24 12:00 PKT
const NOW = new Date('2026-10-24T07:00:00Z');

describe('quick-work rules', () => {
  it('counts minutes in PKT clock time, minus the break', () => {
    expect(minutesOfDay('10:30')).toBe(630);
    expect(minutesOfDay('10:30:00')).toBe(630);
    expect(minutesOfDay('25:00')).toBeNaN();
    expect(attendanceMinutes({ ...lead, breakMinutes: 15 })).toBe(45);
    expect(attendanceMinutes({ ...lead, present: false })).toBe(0);
    expect(pktNow(NOW)).toEqual({ date: '2026-10-24', time: '12:00' });
  });

  it('overlap is half-open: back-to-back sessions do not clash', () => {
    expect(timesOverlap('10:00', '11:00', '11:00', '12:00')).toBe(false);
    expect(timesOverlap('10:00', '11:00', '10:59', '12:00')).toBe(true);
  });

  it('partners are trimmed, de-duplicated by name and capped; old name-only rows still read', () => {
    expect(
      cleanPartners([
        ' Edhi ',
        '',
        { name: 'edhi', email: 'x@y.pk' },
        {
          name: 'WWF Pakistan',
          email: ' Info@WWF.org.pk ',
          contact: '+923001234567',
        },
      ]),
    ).toEqual([
      { name: 'Edhi', email: null, contact: null },
      {
        name: 'WWF Pakistan',
        email: 'info@wwf.org.pk',
        contact: '+923001234567',
      },
    ]);
    const many = Array.from({ length: 15 }, (_, i) => `Org ${i}`);
    expect(cleanPartners(many)).toHaveLength(10);
    expect(partnerList(['Edhi', { name: '' }, null, 7])).toEqual([
      { name: 'Edhi', email: null, contact: null },
    ]);
    expect(
      partnerLabel({ name: 'WWF', email: 'a@b.pk', contact: '+923001234567' }),
    ).toBe('WWF (a@b.pk, +923001234567)');
    expect(partnerLabel({ name: 'WWF', email: null, contact: null })).toBe(
      'WWF',
    );
  });

  it('a complete one-hour log passes', () => {
    expect(quickWorkSubmitErrors(complete(), NOW)).toEqual([]);
  });

  it('“Other” needs the student’s own activity description', () => {
    const other = { activityType: 'Other service activity' };
    expect(quickWorkSubmitErrors(complete(other), NOW)).toContain(
      'Describe the activity type for “Other”.',
    );
    expect(
      quickWorkSubmitErrors(
        complete({ ...other, activityTypeOther: 'Blood donation camp' }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('today is fine once the activity has ended; not before; never the future', () => {
    expect(
      quickWorkSubmitErrors(
        complete({
          activityDate: '2026-10-24',
          startTime: '10:00',
          endTime: '11:00',
        }),
        NOW,
      ),
    ).toEqual([]);
    expect(
      quickWorkSubmitErrors(
        complete({
          activityDate: '2026-10-24',
          endTime: '13:00',
          participants: [{ ...lead, endTime: '13:00' }],
        }),
        NOW,
      ),
    ).toContain('Submit after the activity has finished (PKT).');
    expect(
      quickWorkSubmitErrors(complete({ activityDate: '2026-10-25' }), NOW),
    ).toContain(
      'Attendance can only be submitted for today or a past activity.',
    );
  });

  it('attendance must sit inside the event window and within 9 hours', () => {
    const errs = quickWorkSubmitErrors(
      complete({ participants: [{ ...lead, startTime: '09:30' }] }),
      NOW,
    );
    expect(errs).toContain(
      'Ayesha’s attendance must be inside the event time window.',
    );
    const long = quickWorkSubmitErrors(
      complete({
        startTime: '08:00',
        endTime: '18:00',
        participants: [{ ...lead, startTime: '08:00', endTime: '18:00' }],
      }),
      NOW,
    );
    expect(long).toContain('Ayesha exceeds the 9-hour daily service limit.');
  });

  it('team logs need teammates with their own student IDs; an unanswered invite does not hold the log back, a declined one does', () => {
    const mate = {
      ...lead,
      name: 'Ali',
      email: 'ali@x.pk',
      isLead: false,
      studentId: 'S1',
      joinStatus: 'invited',
    };
    const errs = quickWorkSubmitErrors(
      complete({ mode: 'team', participants: [lead, mate] }),
      NOW,
    );
    expect(errs).toContain('Each participant must have a unique student ID.');
    // Invited but not answered yet: not a reason to hold the log back.
    expect(errs.join(' | ')).not.toMatch(/confirmed joining/);
    expect(
      quickWorkSubmitErrors(
        complete({
          mode: 'team',
          participants: [lead, { ...mate, studentId: 'S2' }],
        }),
        NOW,
      ),
    ).toEqual([]);
    // Declined: the lead must remove them first.
    expect(
      quickWorkSubmitErrors(
        complete({
          mode: 'team',
          participants: [
            lead,
            { ...mate, studentId: 'S2', joinStatus: 'declined' },
          ],
        }),
        NOW,
      ),
    ).toContain('Ali declined to join. Remove them before submitting.');
    expect(quickWorkSubmitErrors(complete({ mode: 'team' }), NOW)).toContain(
      'Add a teammate or select “Just me”.',
    );
  });

  it('a team of the lead plus a teammate still to sign up counts as a team', () => {
    const team = complete({ mode: 'team' });
    expect(quickWorkSubmitErrors(team, NOW)).toContain(
      'Add a teammate or select “Just me”.',
    );
    expect(
      quickWorkSubmitErrors({ ...team, pendingTeammates: 1 }, NOW),
    ).toEqual([]);
  });

  it('evidence, captions and both declarations are required', () => {
    const errs = quickWorkSubmitErrors(
      complete({ evidence: [{ caption: ' ' }], consent: false }),
      NOW,
    );
    expect(errs).toContain('Add a short caption to each evidence file.');
    expect(errs).toContain(
      'Confirm evidence consent and the attendance declaration.',
    );
    expect(quickWorkSubmitErrors(complete({ evidence: [] }), NOW)).toContain(
      'Attach at least one photo or PDF.',
    );
  });

  it('a people target is optional but must be a whole number of 1 or more', () => {
    const msg = 'People target must be a whole number of 1 or more.';
    expect(quickWorkSubmitErrors(complete({ peopleTarget: 40 }), NOW)).toEqual(
      [],
    );
    expect(
      quickWorkSubmitErrors(complete({ peopleTarget: null }), NOW),
    ).toEqual([]);
    expect(quickWorkSubmitErrors(complete({ peopleTarget: 0 }), NOW)).toContain(
      msg,
    );
    expect(
      quickWorkSubmitErrors(complete({ peopleTarget: 2.5 }), NOW),
    ).toContain(msg);
  });

  it('the faculty reviewer cannot be one of the participants', () => {
    expect(
      quickWorkSubmitErrors(complete({ facultyEmail: 'A@x.pk' }), NOW),
    ).toContain(
      'The coordinating faculty email cannot be a participant’s email.',
    );
  });
});

describe('quick-work certificate IDs', () => {
  it('builds CIEL-QCI-YYYY-XXXX-XXXX from the year and 8 random bytes, without I, L, O or U', () => {
    const code = quickWorkCertificateCode(
      '2026',
      Uint8Array.from([0, 1, 18, 21, 24, 27, 31, 255]),
    );
    expect(code).toBe('CIEL-QCI-2026-01JN-RVZZ');
    expect(code.slice(14)).not.toMatch(/[ILOU]/);
    expect(normalizeCertificateCode(code)).toBe(code);
  });

  it('refuses a bad year or too few bytes', () => {
    expect(() => quickWorkCertificateCode('26', new Uint8Array(8))).toThrow();
    expect(() => quickWorkCertificateCode('2026', new Uint8Array(7))).toThrow();
  });

  it('accepts a typed ID in any case and rejects anything else', () => {
    expect(normalizeCertificateCode(' ciel-qci-2026-7k3m-q9td ')).toBe(
      'CIEL-QCI-2026-7K3M-Q9TD',
    );
    for (const bad of [
      '',
      'CIEL-QCI-2026-7K3M',
      'CIEL-QCI-2026-7K3M-Q9TO', // O is not in the alphabet
      'CIEL-CS-2026-7K3M-Q9TD',
      "CIEL-QCI-2026-7K3M-Q9TD' OR 1=1",
      null,
      42,
      { code: 'CIEL-QCI-2026-7K3M-Q9TD' },
    ]) {
      expect(normalizeCertificateCode(bad)).toBeNull();
    }
  });

  it('credits only a present participant with time', () => {
    const slot = { startTime: '10:00', endTime: '11:00', breakMinutes: 0 };
    expect(isCreditedParticipant({ present: true, ...slot })).toBe(true);
    expect(isCreditedParticipant({ present: false, ...slot })).toBe(false);
    expect(
      isCreditedParticipant({ present: true, ...slot, breakMinutes: 60 }),
    ).toBe(false);
  });
});

describe('quick-work SDGs and field formats', () => {
  it('main goal first, then the others: valid goals only, no repeats, at most five', () => {
    expect(normalizeSdgs(3, [13, 3, 13, 7])).toEqual({
      sdg: 3,
      secondarySdgs: [13, 7],
    });
    expect(normalizeSdgs(null, [])).toEqual({ sdg: null, secondarySdgs: [] });
    expect(normalizeSdgs(undefined, undefined)).toEqual({
      sdg: null,
      secondarySdgs: [],
    });
    // 0, 18, decimals, text and blanks are dropped.
    expect(normalizeSdgs(0, [18, 2.5, 'x', '', null, 4])).toEqual({
      sdg: 4,
      secondarySdgs: [],
    });
    expect(normalizeSdgs(1, [2, 3, 4, 5, 6, 7])).toEqual({
      sdg: 1,
      secondarySdgs: [2, 3, 4, 5],
    });
  });

  it('with no main goal the first other goal becomes the main one', () => {
    expect(normalizeSdgs(null, [13, 7])).toEqual({
      sdg: 13,
      secondarySdgs: [7],
    });
    expect(normalizeSdgs('', ['15'])).toEqual({ sdg: 15, secondarySdgs: [] });
  });

  it('times are HH:MM, 24-hour', () => {
    for (const ok of ['00:00', '09:05', '23:59'])
      expect(isClockTime(ok)).toBe(true);
    for (const bad of ['24:00', '9:05', '10:60', '10:30:00', '', 'ab:cd', null])
      expect(isClockTime(bad)).toBe(false);
  });

  it('a map pin is latitude,longitude within range', () => {
    expect(isValidMapPin('31.5204,74.3587')).toBe(true);
    expect(isValidMapPin('31.36497, 74.21606129999999')).toBe(true);
    expect(isValidMapPin('-33.86,151.2')).toBe(true);
    for (const bad of [
      '',
      'abc',
      '91,10',
      '10,181',
      '31.5204',
      '31.5,74.3,5',
      null,
    ])
      expect(isValidMapPin(bad)).toBe(false);
  });

  it('a number still being typed passes the draft check; only a complete one passes submit', () => {
    for (const partial of ['+9230', '03', '+92 300', '']) {
      expect(hasPhoneCharsOnly(partial)).toBe(true);
    }
    for (const bad of ['call me', '+92-abc', '+92#300', '12a']) {
      expect(hasPhoneCharsOnly(bad)).toBe(false);
    }
    expect(isPlausiblePhone('+9230')).toBe(false);
    expect(isPlausiblePhone('+923001234567')).toBe(true);
  });

  it('submit asks for a complete contact number when one was started', () => {
    const base = complete();
    expect(quickWorkSubmitErrors(base, NOW)).toEqual([]);
    expect(
      quickWorkSubmitErrors({ ...base, hostContact: '+923001234567' }, NOW),
    ).toEqual([]);
    expect(
      quickWorkSubmitErrors({ ...base, hostContact: '+9230' }, NOW),
    ).toEqual([
      'Enter a complete contact number for the host organisation, or clear it.',
    ]);
    expect(
      quickWorkSubmitErrors(
        { ...base, partners: [{ name: 'Edhi', email: null, contact: '12' }] },
        NOW,
      ),
    ).toEqual(['Enter a complete contact number for Edhi, or clear it.']);
  });

  it('a contact number is digits with + ( ) - space, 6 to 17 digits', () => {
    for (const ok of [
      '+923001234567',
      '+92 300 1234567',
      '03001234567',
      '+1 (415) 555-0100',
    ])
      expect(isPlausiblePhone(ok)).toBe(true);
    for (const bad of ['', '12345', 'call me', '+92-abc', '1'.repeat(18), null])
      expect(isPlausiblePhone(bad)).toBe(false);
  });
});

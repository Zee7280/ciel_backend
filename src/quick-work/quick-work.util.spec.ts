import {
  attendanceMinutes,
  cleanPartnerNames,
  minutesOfDay,
  pktNow,
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
  facultyConfirmation: 'accepted',
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

  it('partner names are trimmed, de-duplicated and capped', () => {
    expect(cleanPartnerNames([' Edhi ', '', 'edhi', 'WWF Pakistan'])).toEqual([
      'Edhi',
      'WWF Pakistan',
    ]);
    const many = Array.from({ length: 15 }, (_, i) => `Org ${i}`);
    expect(cleanPartnerNames(many)).toHaveLength(10);
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

  it('team logs need confirmed teammates with their own student IDs', () => {
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
    expect(errs).toContain('Ali has not confirmed joining yet.');
    expect(quickWorkSubmitErrors(complete({ mode: 'team' }), NOW)).toContain(
      'Add a teammate or select “Just me”.',
    );
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

  it('the named faculty must accept coordinating first; logs submitted before that rule are exempt', () => {
    const errs = (over: Partial<QuickWorkSubmitInput>) =>
      quickWorkSubmitErrors(complete(over), NOW).join(' ');
    expect(errs({ facultyConfirmation: 'pending' })).toMatch(
      /has not accepted coordinating/,
    );
    expect(errs({ facultyConfirmation: null })).toMatch(
      /has not accepted coordinating/,
    );
    expect(errs({ facultyConfirmation: 'declined' })).toMatch(
      /declined to coordinate/,
    );
    expect(
      quickWorkSubmitErrors(
        complete({ facultyConfirmation: null, submittedAt: new Date() }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('the faculty reviewer cannot be one of the participants', () => {
    expect(
      quickWorkSubmitErrors(complete({ facultyEmail: 'A@x.pk' }), NOW),
    ).toContain(
      'The coordinating faculty email cannot be a participant’s email.',
    );
  });
});

import {
  daysBetweenDateOnly,
  describeReportDeadline,
  dueReminderKind,
} from './report-reminder.util';

describe('describeReportDeadline', () => {
  const timeline = { start_date: '2026-10-01', end_date: '2026-10-31' };

  it('names the phase against the Karachi day and counts days to the reporting close', () => {
    expect(describeReportDeadline(timeline, '2026-09-20').phase).toBe(
      'before_start',
    );
    expect(describeReportDeadline(timeline, '2026-10-15').phase).toBe(
      'in_progress',
    );
    const window = describeReportDeadline(timeline, '2026-11-05');
    expect(window.phase).toBe('reporting_window');
    expect(window.reporting_close_date).toBe('2026-12-30');
    expect(window.days_left_to_report).toBe(55);
    expect(window.days_since_end).toBe(5);
    expect(describeReportDeadline(timeline, '2026-12-31').phase).toBe('closed');
    expect(describeReportDeadline({}, '2026-10-15').phase).toBe('no_dates');
  });

  it('honours an admin-reopened reporting window', () => {
    const d = describeReportDeadline(
      { ...timeline, reporting_window_reopened_until: '2027-01-15' },
      '2027-01-10',
    );
    expect(d.phase).toBe('reporting_window');
    expect(d.days_left_to_report).toBe(5);
  });

  it('daysBetweenDateOnly is signed and whole', () => {
    expect(daysBetweenDateOnly('2026-10-01', '2026-10-08')).toBe(7);
    expect(daysBetweenDateOnly('2026-10-08', '2026-10-01')).toBe(-7);
  });
});

describe('dueReminderKind', () => {
  const timeline = { start_date: '2026-10-01', end_date: '2026-10-31' };
  const at = (today: string) => describeReportDeadline(timeline, today);

  it('after the end date: day 1, then one key every 3 days until the window closes', () => {
    expect(dueReminderKind(at('2026-11-01'), '2026-11-01', true)).toBe(
      'after_end_d0',
    );
    expect(dueReminderKind(at('2026-11-03'), '2026-11-03', true)).toBe(
      'after_end_d0',
    );
    expect(dueReminderKind(at('2026-11-04'), '2026-11-04', false)).toBe(
      'after_end_d1',
    );
    expect(dueReminderKind(at('2026-11-10'), '2026-11-10', false)).toBe(
      'after_end_d3',
    );
    // Close is 2026-12-30: the last key is still a 3-day step, nothing after the close.
    expect(dueReminderKind(at('2026-12-30'), '2026-12-30', true)).toBe(
      'after_end_d19',
    );
    expect(dueReminderKind(at('2026-12-31'), '2026-12-31', true)).toBeNull();
  });

  it('during the project: one nudge two weeks in, only when nobody started the report', () => {
    expect(dueReminderKind(at('2026-10-10'), '2026-10-10', false)).toBeNull();
    expect(dueReminderKind(at('2026-10-15'), '2026-10-15', false)).toBe(
      'not_started_14d',
    );
    expect(dueReminderKind(at('2026-10-15'), '2026-10-15', true)).toBeNull();
  });

  it('nothing before the start, after the window closes, or without dates', () => {
    expect(dueReminderKind(at('2026-09-01'), '2026-09-01', false)).toBeNull();
    expect(dueReminderKind(at('2027-01-05'), '2027-01-05', false)).toBeNull();
    expect(
      dueReminderKind(
        describeReportDeadline({}, '2026-10-15'),
        '2026-10-15',
        false,
      ),
    ).toBeNull();
  });
});

import {
  compareDateOnly,
  getProjectEndDate,
  getProjectStartDate,
  getReportingCloseDate,
} from '../opportunities/opportunity-timeline.util';

export type ReportDeadlinePhase =
  | 'no_dates'
  | 'before_start'
  | 'in_progress'
  | 'reporting_window'
  | 'closed';

export type ReportDeadline = {
  phase: ReportDeadlinePhase;
  start_date: string | null;
  end_date: string | null;
  reporting_close_date: string | null;
  /** Whole days from today to the reporting close (inclusive of today); null without an end date. */
  days_left_to_report: number | null;
  /** Whole days since the project end date; 0 on the end date, null before it or without one. */
  days_since_end: number | null;
};

/** Whole calendar days from `a` to `b` (both YYYY-MM-DD); negative when `b` is earlier. */
export function daysBetweenDateOnly(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Where the project sits against its dates on the Karachi calendar day `today`. */
export function describeReportDeadline(
  timeline: unknown,
  today: string,
): ReportDeadline {
  const start = getProjectStartDate(timeline);
  const end = getProjectEndDate(timeline);
  const close = getReportingCloseDate(timeline);
  const base: ReportDeadline = {
    phase: 'no_dates',
    start_date: start,
    end_date: end,
    reporting_close_date: close,
    days_left_to_report: null,
    days_since_end: null,
  };
  if (!end) return base;
  const daysLeft = close ? daysBetweenDateOnly(today, close) : null;
  if (close && compareDateOnly(today, close) > 0) {
    return { ...base, phase: 'closed', days_left_to_report: daysLeft };
  }
  if (compareDateOnly(today, end) > 0) {
    return {
      ...base,
      phase: 'reporting_window',
      days_left_to_report: daysLeft,
      days_since_end: daysBetweenDateOnly(end, today),
    };
  }
  if (start && compareDateOnly(today, start) < 0) {
    return { ...base, phase: 'before_start', days_left_to_report: daysLeft };
  }
  return { ...base, phase: 'in_progress', days_left_to_report: daysLeft };
}

/** Days into the project before a student who never started the report gets the first nudge. */
export const NOT_STARTED_NUDGE_AFTER_DAYS = 14;
/** After the project end date a reminder goes every this many days until the window closes. */
export const AFTER_END_EVERY_DAYS = 3;

/**
 * Which automatic reminder (if any) is due today for one student on one project. Returns the
 * exactly-once `kind` key, or null. `reportStarted` = a draft with any progress exists.
 *
 * - After the project end date: day 1, then every 3 days (`after_end_d0`, `after_end_d1`, …)
 *   until the reporting window closes.
 * - During the project: one `not_started_14d` nudge when nobody started the report two weeks in.
 * - Before the start, after the window closes, or without dates: nothing.
 */
export function dueReminderKind(
  deadline: ReportDeadline,
  today: string,
  reportStarted: boolean,
): string | null {
  if (deadline.phase === 'reporting_window') {
    const since = deadline.days_since_end ?? 0;
    return `after_end_d${Math.floor(Math.max(0, since - 1) / AFTER_END_EVERY_DAYS)}`;
  }
  if (
    deadline.phase === 'in_progress' &&
    !reportStarted &&
    deadline.start_date
  ) {
    return daysBetweenDateOnly(deadline.start_date, today) >=
      NOT_STARTED_NUDGE_AFTER_DAYS
      ? 'not_started_14d'
      : null;
  }
  return null;
}

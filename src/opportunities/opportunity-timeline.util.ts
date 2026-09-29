/**
 * Opportunity date lifecycle (CIEL PK Community Service).
 *
 * Rules:
 * - Project start/end are the only mandatory dates.
 * - Applications join until project end, unless early close is set.
 * - Service dates must fall within [start, end].
 * - Reporting window = end + 60 days (extendable via reporting_window_reopened_until).
 */

export const REPORTING_WINDOW_DAYS = 60;

export type TimelineLike = {
  start_date?: unknown;
  end_date?: unknown;
  application_deadline?: unknown;
  close_applications_early?: unknown;
  reporting_window_reopened_until?: unknown;
  type?: unknown;
};

export type OpportunityLifecyclePhase =
  | 'no_dates'
  | 'join_open'
  | 'applications_closed_service_active'
  | 'service_ended_reporting_open'
  | 'reporting_closed';

/** YYYY-MM-DD only; rejects datetime noise by slicing. */
export function toDateOnlyString(input: unknown): string | null {
  if (input == null) return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return input.toISOString().slice(0, 10);
  }
  const s = String(input).trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

export function todayDateOnlyUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Lexicographic compare for YYYY-MM-DD (ascending). */
export function compareDateOnly(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function addDaysToDateOnly(iso: string, days: number): string | null {
  const d = toDateOnlyString(iso);
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function asTimeline(raw: unknown): TimelineLike {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as TimelineLike;
  }
  return {};
}

export function getProjectStartDate(timeline: unknown): string | null {
  return toDateOnlyString(asTimeline(timeline).start_date);
}

export function getProjectEndDate(timeline: unknown): string | null {
  return toDateOnlyString(asTimeline(timeline).end_date);
}

/**
 * True when creator opted into an early applications close date.
 * Legacy rows that stored application_deadline before end_date are treated as early close.
 */
export function isCloseApplicationsEarly(timeline: unknown): boolean {
  const t = asTimeline(timeline);
  if (t.close_applications_early === true) return true;
  if (t.close_applications_early === false) return false;
  const deadline = toDateOnlyString(t.application_deadline);
  const end = toDateOnlyString(t.end_date);
  if (deadline && end && compareDateOnly(deadline, end) < 0) return true;
  return false;
}

/** Last day students may Join / Apply (inclusive). Defaults to project end. */
export function getApplicationsCloseDate(timeline: unknown): string | null {
  const t = asTimeline(timeline);
  const end = toDateOnlyString(t.end_date);
  if (isCloseApplicationsEarly(t)) {
    const deadline = toDateOnlyString(t.application_deadline);
    if (deadline) return deadline;
  }
  return end;
}

/** Last day of the reporting window (inclusive). */
export function getReportingCloseDate(timeline: unknown): string | null {
  const t = asTimeline(timeline);
  const end = toDateOnlyString(t.end_date);
  if (!end) return null;
  const base = addDaysToDateOnly(end, REPORTING_WINDOW_DAYS);
  const reopen = toDateOnlyString(t.reporting_window_reopened_until);
  if (!base) return reopen;
  if (!reopen) return base;
  return compareDateOnly(reopen, base) > 0 ? reopen : base;
}

export function resolveLifecyclePhase(
  timeline: unknown,
  today: string = todayDateOnlyUtc(),
): OpportunityLifecyclePhase {
  const start = getProjectStartDate(timeline);
  const end = getProjectEndDate(timeline);
  if (!start || !end) return 'no_dates';

  const appsClose = getApplicationsCloseDate(timeline) || end;
  const reportingClose = getReportingCloseDate(timeline);

  if (compareDateOnly(today, appsClose) <= 0) {
    return 'join_open';
  }
  if (compareDateOnly(today, end) <= 0) {
    return 'applications_closed_service_active';
  }
  if (reportingClose && compareDateOnly(today, reportingClose) <= 0) {
    return 'service_ended_reporting_open';
  }
  return 'reporting_closed';
}

export function canJoinOrApply(
  timeline: unknown,
  today: string = todayDateOnlyUtc(),
): boolean {
  const phase = resolveLifecyclePhase(timeline, today);
  // Legacy listings without start/end must not suddenly block apply.
  if (phase === 'no_dates') return true;
  return phase === 'join_open';
}

export function canRecordCompletedService(
  timeline: unknown,
  today: string = todayDateOnlyUtc(),
): boolean {
  return resolveLifecyclePhase(timeline, today) === 'service_ended_reporting_open';
}

export function canEditOrSubmitReport(
  timeline: unknown,
  today: string = todayDateOnlyUtc(),
): boolean {
  const phase = resolveLifecyclePhase(timeline, today);
  if (phase === 'no_dates') return true;
  return (
    phase === 'join_open' ||
    phase === 'applications_closed_service_active' ||
    phase === 'service_ended_reporting_open'
  );
}

export function isServiceDateAllowed(
  serviceDate: unknown,
  timeline: unknown,
): boolean {
  const day = toDateOnlyString(serviceDate);
  const start = getProjectStartDate(timeline);
  const end = getProjectEndDate(timeline);
  if (!day || !start || !end) return false;
  return compareDateOnly(day, start) >= 0 && compareDateOnly(day, end) <= 0;
}

export function lifecycleStatusLabel(
  timeline: unknown,
  today: string = todayDateOnlyUtc(),
): string | null {
  switch (resolveLifecyclePhase(timeline, today)) {
    case 'join_open':
      return null;
    case 'applications_closed_service_active':
      return 'Applications Closed';
    case 'service_ended_reporting_open':
      return 'Completed / Service Period Ended';
    case 'reporting_closed':
      return 'Reporting Window Closed';
    default:
      return null;
  }
}

export const REPORTING_WINDOW_CLOSED_MESSAGE =
  'Reporting period has closed. Please contact your Faculty or CIEL PK Administration if an extension is required.';

/**
 * Validate timeline on create/update. Returns error message or null if OK.
 * emptyAllowed: draft saves may omit dates.
 */
export function validateTimelineForPersist(
  timeline: unknown,
  opts?: { requireDates?: boolean },
): string | null {
  const requireDates = opts?.requireDates !== false;
  const t = asTimeline(timeline);
  const start = toDateOnlyString(t.start_date);
  const end = toDateOnlyString(t.end_date);
  const deadline = toDateOnlyString(t.application_deadline);
  const closeEarly = t.close_applications_early === true;

  if (!start && !end && !deadline && !closeEarly) {
    return requireDates
      ? 'Please set both a project start date and a project end date.'
      : null;
  }
  if (!start || !end) {
    return 'Please set both a project start date and a project end date.';
  }
  if (compareDateOnly(start, end) > 0) {
    return 'Project end date must be on or after the project start date.';
  }
  if (closeEarly) {
    if (!deadline) {
      return 'Please set an application closing date, or turn off early application close.';
    }
    if (compareDateOnly(deadline, end) >= 0) {
      return 'Application closing date must be before the project end date.';
    }
  }
  return null;
}

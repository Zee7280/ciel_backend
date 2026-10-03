/** Keep in sync with `ciel_frontend/src/utils/attendanceDescriptionLimits.ts`. */
export const ATTENDANCE_DESCRIPTION_MAX_CHARS = 2000;
export const ATTENDANCE_DESCRIPTION_MAX_WORDS = 40;

/** Per-student daily attendance cap (single session and same-day total). */
export const MAX_DAILY_ATTENDANCE_HOURS = 9;

/** Each attendance entry (one day's service session) must be at least this long. */
export const MIN_ATTENDANCE_SESSION_HOURS = 2;

export function minAttendanceSessionMessage(
  minHours = MIN_ATTENDANCE_SESSION_HOURS,
): string {
  return `Each attendance entry must be at least ${minHours} hours`;
}

export function dailyAttendanceCapMessage(
  maxHours = MAX_DAILY_ATTENDANCE_HOURS,
): string {
  return `Daily attendance cannot exceed ${maxHours} hours`;
}

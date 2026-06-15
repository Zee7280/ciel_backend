/** Keep in sync with `ciel_frontend/src/utils/attendanceDescriptionLimits.ts`. */
export const ATTENDANCE_DESCRIPTION_MAX_CHARS = 2000;
export const ATTENDANCE_DESCRIPTION_MAX_WORDS = 40;

/** Per-student daily attendance cap (single session and same-day total). */
export const MAX_DAILY_ATTENDANCE_HOURS = 9;

export function dailyAttendanceCapMessage(maxHours = MAX_DAILY_ATTENDANCE_HOURS): string {
    return `Daily attendance cannot exceed ${maxHours} hours`;
}

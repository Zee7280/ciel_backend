/**
 * Quick Community Work: a short activity log (tree drive, awareness desk, clean-up …) that a
 * student submits after the activity, with each participant's actual attendance and evidence, for
 * one final review by the named faculty member. Separate from Structured Community Service: it
 * never counts towards the 16-hour requirement, CII scores or rankings.
 *
 * Pure rules shared by the service (and mirrored by the frontend form) so they can be unit tested.
 */

export const QUICK_WORK_STATUSES = [
  'draft',
  'submitted',
  'changes',
  'approved',
  'rejected',
] as const;
export type QuickWorkStatus = (typeof QUICK_WORK_STATUSES)[number];

/** The lead can edit (and submit) only in these states. */
export const QUICK_WORK_EDITABLE: readonly QuickWorkStatus[] = [
  'draft',
  'changes',
];

/** States whose attendance blocks the same student claiming an overlapping period elsewhere. */
export const QUICK_WORK_CLAIMING: readonly QuickWorkStatus[] = [
  'submitted',
  'approved',
];

export const QUICK_WORK_ACTIVITY_TYPES = [
  'Tree plantation drive',
  'Awareness campaign',
  'Pinktober event',
  'Community clean-up',
  'Donation drive',
  'Community outreach',
  'Other service activity',
] as const;

export const QUICK_WORK_VISIBILITY = [
  'Faculty, University & CIEL PK only',
  'Public with consent',
] as const;

export const QUICK_WORK_MAX_PARTICIPANTS = 20;
/** Per student per day, across every quick-work log. */
export const QUICK_WORK_MAX_DAILY_MINUTES = 9 * 60;
export const QUICK_WORK_MAX_EVIDENCE = 5;
export const QUICK_WORK_MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const QUICK_WORK_EVIDENCE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export const QUICK_WORK_SUMMARY_MAX = 600;
export const QUICK_WORK_REVIEW_NOTE_MAX = 300;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM" (or Postgres "HH:MM:SS") → minutes after midnight; NaN when malformed. */
export function minutesOfDay(value: string | null | undefined): number {
  const hhmm = String(value ?? '').slice(0, 5);
  if (!HHMM.test(hhmm)) return NaN;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
}

export type QuickWorkAttendance = {
  present: boolean;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number;
};

/** Credited minutes for one participant: departure − arrival − break, never negative. */
export function attendanceMinutes(a: QuickWorkAttendance): number {
  if (!a.present) return 0;
  const start = minutesOfDay(a.startTime);
  const end = minutesOfDay(a.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start - (Number(a.breakMinutes) || 0));
}

/** Half-open intervals [start, end) overlap. */
export function timesOverlap(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
): boolean {
  const [as, ae, bs, be] = [aStart, aEnd, bStart, bEnd].map(minutesOfDay);
  if (![as, ae, bs, be].every(Number.isFinite)) return false;
  return as < be && ae > bs;
}

/** Today's date and current "HH:MM" in Pakistan Standard Time (all quick-work times are PKT). */
export function pktNow(now: Date = new Date()): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return { date, time };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): boolean {
  if (!value || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** A participant as the submit rules see it. */
export type QuickWorkSubmitParticipant = QuickWorkAttendance & {
  name: string;
  email: string;
  studentId: string;
  isLead: boolean;
  joinStatus: string;
};

/** A log as the submit rules see it. */
export type QuickWorkSubmitInput = {
  mode: string;
  university: string;
  department: string;
  facultyName: string;
  facultyEmail: string;
  title: string;
  activityType: string;
  activityDate: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string;
  peopleReached: number | null;
  summary: string;
  visibility: string;
  consent: boolean;
  honest: boolean;
  evidence: { caption?: string | null }[];
  participants: QuickWorkSubmitParticipant[];
};

/**
 * Every rule a complete log must meet before it goes to faculty (the design's four step checks),
 * except cross-record overlap and the daily cap, which need the database. Returns readable messages.
 */
export function quickWorkSubmitErrors(
  log: QuickWorkSubmitInput,
  now: Date = new Date(),
): string[] {
  const e: string[] = [];
  const people = log.participants;
  const lead = people.find((p) => p.isLead);

  // Step 1 — team & faculty
  if (!lead || !lead.name.trim() || !lead.studentId.trim()) {
    e.push('Enter your full name and student ID.');
  }
  if (!log.university.trim() || !log.department.trim()) {
    e.push('Enter your university and department / programme.');
  }
  if (!log.facultyName.trim() || !EMAIL_RE.test(log.facultyEmail)) {
    e.push('Enter a coordinating faculty name and valid email.');
  }
  if (
    people.some(
      (p) => normalizeEmail(p.email) === normalizeEmail(log.facultyEmail),
    )
  ) {
    e.push('The coordinating faculty email cannot be a participant’s email.');
  }
  if (people.length > QUICK_WORK_MAX_PARTICIPANTS) {
    e.push(`Maximum ${QUICK_WORK_MAX_PARTICIPANTS} participants per log.`);
  }
  if (log.mode === 'team' && people.length < 2) {
    e.push('Add a teammate or select “Just me”.');
  }
  for (const p of people) {
    if (!p.isLead && !p.studentId.trim()) {
      e.push(`Enter a student ID for ${p.name || p.email}.`);
    }
  }
  const ids = people
    .map((p) => p.studentId.trim().toLowerCase())
    .filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    e.push('Each participant must have a unique student ID.');
  }
  for (const p of people) {
    if (p.isLead) continue;
    if (p.joinStatus === 'declined') {
      e.push(
        `${p.name || p.email} declined to join. Remove them before submitting.`,
      );
    } else if (p.joinStatus !== 'joined') {
      e.push(`${p.name || p.email} has not confirmed joining yet.`);
    }
  }

  // Step 2 — activity
  if (
    !log.title.trim() ||
    !log.activityType ||
    !log.location.trim() ||
    !isIsoDate(log.activityDate)
  ) {
    e.push('Enter the activity title, type, date and venue.');
  }
  if (
    log.activityType &&
    !(QUICK_WORK_ACTIVITY_TYPES as readonly string[]).includes(log.activityType)
  ) {
    e.push('Choose an activity type from the list.');
  }
  const eventStart = minutesOfDay(log.startTime);
  const eventEnd = minutesOfDay(log.endTime);
  const windowOk =
    Number.isFinite(eventStart) &&
    Number.isFinite(eventEnd) &&
    eventEnd > eventStart;
  if (!windowOk) {
    e.push('Choose an end time after the start time on the same day.');
  }

  // Step 3 — attendance
  const { date: today, time: nowTime } = pktNow(now);
  if (isIsoDate(log.activityDate)) {
    if ((log.activityDate as string) > today) {
      e.push('Attendance can only be submitted for today or a past activity.');
    } else if (
      log.activityDate === today &&
      windowOk &&
      eventEnd > minutesOfDay(nowTime)
    ) {
      e.push('Submit after the activity has finished (PKT).');
    }
  }
  if (!people.some((p) => p.present)) {
    e.push('Mark at least one participant as present.');
  }
  for (const p of people) {
    if (!p.present) continue;
    const who = p.name || p.email;
    const start = minutesOfDay(p.startTime);
    const end = minutesOfDay(p.endTime);
    const mins = attendanceMinutes(p);
    if (!Number.isFinite(start) || !Number.isFinite(end) || mins <= 0) {
      e.push(`Check the arrival, departure and break for ${who}.`);
      continue;
    }
    if (
      !Number.isInteger(Number(p.breakMinutes)) ||
      Number(p.breakMinutes) < 0
    ) {
      e.push(`Break minutes must be a non-negative whole number for ${who}.`);
    }
    if (windowOk && (start < eventStart || end > eventEnd)) {
      e.push(`${who}’s attendance must be inside the event time window.`);
    }
    if (mins > QUICK_WORK_MAX_DAILY_MINUTES) {
      e.push(`${who} exceeds the 9-hour daily service limit.`);
    }
  }

  // Step 4 — evidence
  if (!log.summary.trim()) e.push('Briefly describe the activity conducted.');
  if (log.summary.length > QUICK_WORK_SUMMARY_MAX) {
    e.push(`Keep the description within ${QUICK_WORK_SUMMARY_MAX} characters.`);
  }
  if (!log.evidence.length) e.push('Attach at least one photo or PDF.');
  if (log.evidence.length > QUICK_WORK_MAX_EVIDENCE) {
    e.push(`Use up to ${QUICK_WORK_MAX_EVIDENCE} evidence files per activity.`);
  }
  if (log.evidence.some((x) => !String(x.caption ?? '').trim())) {
    e.push('Add a short caption to each evidence file.');
  }
  if (!(QUICK_WORK_VISIBILITY as readonly string[]).includes(log.visibility)) {
    e.push('Choose who can see the evidence.');
  }
  if (!log.consent || !log.honest) {
    e.push('Confirm evidence consent and the attendance declaration.');
  }
  if (
    log.peopleReached != null &&
    (!Number.isInteger(log.peopleReached) || log.peopleReached < 0)
  ) {
    e.push('People reached must be a non-negative whole number.');
  }

  return Array.from(new Set(e));
}

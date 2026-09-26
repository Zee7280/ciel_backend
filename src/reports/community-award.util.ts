/** Deterministic community-service award model — same 5 criteria for every stakeholder. */

export const COMMUNITY_AWARD_CRITERIA = [
  { key: 'cii', max: 40, title: 'Composite Impact Index (CII v8.2)' },
  { key: 'quality', max: 20, title: 'Quality & depth of execution' },
  { key: 'evidence', max: 15, title: 'Evidence integrity' },
  { key: 'outcome', max: 15, title: 'Measured community outcome' },
  { key: 'sustain', max: 10, title: 'Sustainability & partnership' },
] as const;

export type CommunityAwardKind = 'fac' | 'par' | 'uni' | 'ciel';

export type CommunityAwardInputs = {
  cii: number | null;
  hours: number;
  sessions: number;
  evidenceCount: number;
  hasBaseline: boolean;
  hasEndline: boolean;
  hasMeasuredChange: boolean;
  continuation: 'yes' | 'partially' | 'no' | '';
  partnerCount: number;
};

export function clampScore(n: number, max: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

export function readCii(
  section11: Record<string, unknown> | null | undefined,
): number | null {
  if (!section11) return null;
  const read = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value))
      return Math.min(100, Math.max(0, Math.round(value)));
    if (typeof value === 'string') {
      const match = value.trim().match(/\d+(?:\.\d+)?/);
      if (!match) return null;
      const parsed = Number(match[0]);
      return Number.isFinite(parsed)
        ? Math.min(100, Math.max(0, Math.round(parsed)))
        : null;
    }
    return null;
  };
  const cii = section11.cii_index as Record<string, unknown> | undefined;
  return (
    read(cii?.totalScore) ??
    read(cii?.total_score) ??
    read(cii?.score) ??
    read(section11.ai_generated_impact_score) ??
    read(section11.cii_score)
  );
}

export function countMedia(
  sections: Array<{ media_urls?: unknown } | null | undefined>,
): number {
  let n = 0;
  for (const s of sections) {
    if (Array.isArray(s?.media_urls)) n += s.media_urls.filter(Boolean).length;
  }
  return n;
}

/** Keep in lockstep with ciel_frontend `chromeAgg` in ReportFormChrome.tsx. */
function pickFlashNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function logCountsTowardHours(log: Record<string, unknown>): boolean {
  const status = String(
    log.approval_status ?? log.approvalStatus ?? '',
  )
    .trim()
    .toLowerCase();
  return status !== 'rejected';
}

function clockToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function effectiveHoursFromLog(log: Record<string, unknown>): number {
  const direct = pickFlashNumber(log.hours ?? log.sessionHours);
  if (direct > 0) return direct;
  const start = clockToMinutes(log.start_time ?? log.startTime);
  const end = clockToMinutes(log.end_time ?? log.endTime);
  if (start == null || end == null) return 0;
  let diffMin = end - start;
  if (diffMin < 0) diffMin += 24 * 60;
  return Math.round((diffMin / 60) * 10) / 10;
}

function logHasEvidence(log: Record<string, unknown>): boolean {
  if (log.evidence_file) return true;
  if (typeof log.evidence_url === 'string' && log.evidence_url.trim()) return true;
  return Array.isArray(log.evidence_urls) && log.evidence_urls.length > 0;
}

export type ReportFlashSource = {
  section1?: {
    metrics?: {
      total_verified_hours?: unknown;
      total_active_days?: unknown;
      individual_metrics?: Array<{ individual_hours?: unknown }>;
    };
    attendance_logs?: Array<Record<string, unknown>>;
    team_lead?: { hours?: unknown };
    team_members?: Array<{ hours?: unknown }>;
    media_urls?: unknown;
  } | null;
  section2?: { media_urls?: unknown } | null;
  section3?: { media_urls?: unknown } | null;
  section4?: Record<string, unknown> | null;
  section5?: {
    media_urls?: unknown;
    baseline?: unknown;
    endline?: unknown;
    observed_change?: unknown;
    story_now?: unknown;
    measurable_outcomes?: Array<{
      baseline?: unknown;
      endline?: unknown;
      metric?: unknown;
      outcome_area?: unknown;
    }>;
  } | null;
  section6?: { media_urls?: unknown } | null;
  section7?: { media_urls?: unknown } | null;
  section8?: { evidence_files?: unknown; media_urls?: unknown } | null;
  section9?: { media_urls?: unknown } | null;
  section10?: { media_urls?: unknown } | null;
  section11?: Record<string, unknown> | null;
  ciiV2?: { final?: unknown } | null;
  ciiV2Lock?: { locked?: unknown } | null;
  evidence_urls?: unknown;
};

/**
 * Same cascade as the V23 flashcard: metrics → session logs → individual metrics → roster,
 * then optional live attendance hours when the stored blob is still empty.
 */
export function resolveReportFlashHours(
  section1: ReportFlashSource['section1'],
  liveHours = 0,
): number {
  const metricHours = pickFlashNumber(section1?.metrics?.total_verified_hours);
  const logs = Array.isArray(section1?.attendance_logs)
    ? section1.attendance_logs
    : [];
  const logHours = logs
    .filter((log) => log && typeof log === 'object' && logCountsTowardHours(log))
    .reduce((sum, log) => sum + effectiveHoursFromLog(log), 0);
  const rosterHours =
    pickFlashNumber(section1?.team_lead?.hours) +
    (Array.isArray(section1?.team_members)
      ? section1.team_members.reduce(
          (sum, member) => sum + pickFlashNumber(member?.hours),
          0,
        )
      : 0);
  const individualHours = Array.isArray(section1?.metrics?.individual_metrics)
    ? section1.metrics.individual_metrics.reduce(
        (sum, row) => sum + pickFlashNumber(row?.individual_hours),
        0,
      )
    : 0;
  const blob =
    metricHours > 0
      ? metricHours
      : logHours > 0
        ? logHours
        : individualHours > 0
          ? individualHours
          : rosterHours;
  return blob > 0 ? blob : pickFlashNumber(liveHours);
}

function finiteCii(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** JSON lock flags sometimes arrive as the string `"true"` (same as faculty list). */
export function isCiiFacultyLocked(
  lock: { locked?: unknown } | null | undefined,
): boolean {
  return lock?.locked === true || lock?.locked === 'true';
}

/** CII chip on walls/flashcards: locked v2 final, else legacy section11 only when no lock row exists. */
export function resolveDisplayCii(report: ReportFlashSource): number | null {
  const lock = report.ciiV2Lock;
  const hasLockRecord = lock != null && typeof lock === 'object';
  const locked = isCiiFacultyLocked(lock);
  const final = finiteCii(report.ciiV2?.final);
  if (locked && final != null) {
    return Math.round(final);
  }
  if (!hasLockRecord) {
    return readCii(report.section11);
  }
  return null;
}

/** Ranking still uses a numeric CII; prefer locked final, else section11. */
export function resolveScoringCii(report: ReportFlashSource): number | null {
  const lock = report.ciiV2Lock;
  const locked = isCiiFacultyLocked(lock);
  const final = finiteCii(report.ciiV2?.final);
  if (locked && final != null) {
    return Math.round(final);
  }
  return readCii(report.section11);
}

/** Same sources the exhibition flashcard uses for baseline → endline / observed change. */
export function resolveReportFlashOutcomes(section5: ReportFlashSource['section5']): {
  baseline: string;
  endline: string;
  change: string;
} {
  const rows = Array.isArray(section5?.measurable_outcomes)
    ? section5.measurable_outcomes
    : [];
  const firstComplete = rows.find((row) => {
    const baseline = String(row?.baseline ?? '').trim();
    const endline = String(row?.endline ?? '').trim();
    return Boolean(baseline && endline);
  });
  const firstAny = rows.find(
    (row) =>
      String(row?.baseline ?? '').trim() || String(row?.endline ?? '').trim(),
  );
  const baseline =
    String(section5?.baseline ?? '').trim() ||
    String(firstComplete?.baseline ?? firstAny?.baseline ?? '').trim();
  const endline =
    String(section5?.endline ?? '').trim() ||
    String(firstComplete?.endline ?? firstAny?.endline ?? '').trim();
  const change =
    String(section5?.observed_change ?? '').trim() ||
    String(section5?.story_now ?? '').trim() ||
    (firstComplete
      ? `${String(firstComplete.metric || firstComplete.outcome_area || 'Outcome').trim()}: ${String(firstComplete.baseline).trim()} → ${String(firstComplete.endline).trim()}`
      : '');
  return { baseline, endline, change };
}

export function resolveReportFlashSessions(
  section1: ReportFlashSource['section1'],
  section4?: Record<string, unknown> | null,
): number {
  const logs = Array.isArray(section1?.attendance_logs)
    ? section1.attendance_logs.filter(
        (log) => log && typeof log === 'object' && logCountsTowardHours(log),
      )
    : [];
  if (logs.length > 0) return logs.length;
  return (
    pickFlashNumber(
      section4?.total_sessions ??
        section4?.my_sessions ??
        section1?.metrics?.total_active_days,
    ) || 0
  );
}

export function resolveReportFlashEvidence(report: ReportFlashSource): number {
  const files = Array.isArray(report.section8?.evidence_files)
    ? report.section8.evidence_files.length
    : 0;
  const urls = Array.isArray(report.evidence_urls) ? report.evidence_urls.length : 0;
  const logs = Array.isArray(report.section1?.attendance_logs)
    ? report.section1.attendance_logs
    : [];
  const logEvidence = logs.filter(
    (log) => log && typeof log === 'object' && logHasEvidence(log),
  ).length;
  const media = countMedia([
    report.section1,
    report.section2,
    report.section3,
    report.section4 as { media_urls?: unknown } | null,
    report.section5,
    report.section6,
    report.section7,
    report.section8,
    report.section9,
    report.section10,
  ]);
  return Math.max(files + urls, logEvidence, media);
}

export function communityAwardInputsFromReport(
  report: ReportFlashSource & {
    section7?: { partners?: unknown; media_urls?: unknown } | null;
    section10?: { continuation_status?: unknown; media_urls?: unknown } | null;
  },
  liveHours = 0,
): CommunityAwardInputs {
  const s1 = report.section1;
  const s4 = report.section4;
  const s5 = report.section5;
  const s7 = report.section7;
  const s10 = report.section10;
  const hours = resolveReportFlashHours(s1, liveHours);
  const sessions = resolveReportFlashSessions(s1, s4);
  const { baseline, endline, change } = resolveReportFlashOutcomes(s5);
  return {
    cii: resolveScoringCii(report),
    hours,
    sessions,
    evidenceCount: resolveReportFlashEvidence(report),
    hasBaseline: !!baseline,
    hasEndline: !!endline,
    hasMeasuredChange: !!change || (!!baseline && !!endline),
    continuation:
      (s10?.continuation_status as 'yes' | 'partially' | 'no' | '') || '',
    partnerCount: Array.isArray(s7?.partners) ? s7.partners.length : 0,
  };
}

export function scoreCommunityAward(input: CommunityAwardInputs): {
  pts: number[];
  total: number;
} {
  const cii = input.cii ?? 0;
  const pts = [
    clampScore((cii / 100) * 40, 40),
    clampScore(
      (input.hours >= 40
        ? 12
        : input.hours >= 20
          ? 9
          : input.hours >= 8
            ? 6
            : 3) + (input.sessions >= 8 ? 8 : input.sessions >= 4 ? 5 : 2),
      20,
    ),
    clampScore(
      input.evidenceCount >= 6
        ? 15
        : input.evidenceCount >= 4
          ? 12
          : input.evidenceCount >= 2
            ? 9
            : input.evidenceCount >= 1
              ? 6
              : 2,
      15,
    ),
    clampScore(
      (input.hasBaseline ? 5 : 0) +
        (input.hasEndline ? 5 : 0) +
        (input.hasMeasuredChange ? 5 : 0),
      15,
    ),
    clampScore(
      (input.continuation === 'yes'
        ? 6
        : input.continuation === 'partially'
          ? 4
          : 1) + (input.partnerCount >= 1 ? 4 : 0),
      10,
    ),
  ];
  return { pts, total: pts.reduce((a, b) => a + b, 0) };
}

export type CommunityServiceLevel =
  | 'Transformative'
  | 'Distinguished'
  | 'Strong'
  | 'Developing';

/** A standing score-band grade shown on every approved report regardless of ranking — distinct
 * from awardBadgeLabel above, which only fires when a report is explicitly picked as a top-N
 * award winner. "Developing & Below" is a display-only wrapper for the 'Developing' value. */
export function communityServiceLevel(total: number): CommunityServiceLevel {
  if (total >= 85) return 'Transformative';
  if (total >= 70) return 'Distinguished';
  if (total >= 50) return 'Strong';
  return 'Developing';
}

export function awardBadgeLabel(kind: CommunityAwardKind, scope: string) {
  if (kind === 'fac') return `Faculty Choice — ${scope}`;
  if (kind === 'par') return `Partner’s Best Project — ${scope}`;
  if (kind === 'uni') return `${scope} Community Honour`;
  return 'CIEL PK National Community Medal';
}

export function awardTopN(kind: CommunityAwardKind) {
  return kind === 'par' || kind === 'fac' ? 1 : 3;
}

const LIVE_STATUS = new Set(['approved', 'verified']);
const BLOCKED_STATUS = new Set(['draft', 'rejected', 'declined']);

/**
 * Live deck = faculty or admin actually signed off.
 * Hours and “paid” (reporting fee) must not skip the waiting inbox —
 * a submitted report with attendance still needs approval.
 */
export function isCommunityAwardLiveReport(input: {
  status?: string | null;
  faculty_status?: string | null;
  hours?: number | null;
}): boolean {
  const overall = String(input.status || '')
    .trim()
    .toLowerCase();
  const faculty = String(input.faculty_status || '')
    .trim()
    .toLowerCase();
  if (BLOCKED_STATUS.has(overall) || BLOCKED_STATUS.has(faculty)) return false;
  return LIVE_STATUS.has(faculty) || LIVE_STATUS.has(overall);
}

/** Medal / approved-opportunities vault — both faculty and admin must have signed off. */
export function isCommunityAwardMedalReport(input: {
  status?: string | null;
  faculty_status?: string | null;
  admin_status?: string | null;
}): boolean {
  const overall = String(input.status || '')
    .trim()
    .toLowerCase();
  const faculty = String(input.faculty_status || '')
    .trim()
    .toLowerCase();
  const admin = String(input.admin_status || '')
    .trim()
    .toLowerCase();
  if (
    BLOCKED_STATUS.has(overall) ||
    BLOCKED_STATUS.has(faculty) ||
    BLOCKED_STATUS.has(admin)
  )
    return false;
  return (
    LIVE_STATUS.has(faculty) &&
    (LIVE_STATUS.has(admin) || LIVE_STATUS.has(overall))
  );
}

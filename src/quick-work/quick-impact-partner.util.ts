import { normalizeSdgs, partnerList } from './quick-work.util';

/**
 * Pure helpers for telling the host / partner organisations of an APPROVED Quick Community Impact
 * log about it. Nothing here touches the database or the mail provider.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SDG_NAMES = [
  'No Poverty',
  'Zero Hunger',
  'Good Health and Well-being',
  'Quality Education',
  'Gender Equality',
  'Clean Water and Sanitation',
  'Affordable and Clean Energy',
  'Decent Work and Economic Growth',
  'Industry, Innovation and Infrastructure',
  'Reduced Inequalities',
  'Sustainable Cities and Communities',
  'Responsible Consumption and Production',
  'Climate Action',
  'Life Below Water',
  'Life on Land',
  'Peace, Justice and Strong Institutions',
  'Partnerships for the Goals',
] as const;

export const SDG_COLORS = [
  '#e5243b',
  '#dda63a',
  '#4c9f38',
  '#c5192d',
  '#ff3a21',
  '#26bde2',
  '#fcc30b',
  '#a21942',
  '#fd6925',
  '#dd1367',
  '#fd9d24',
  '#bf8b2e',
  '#3f7e44',
  '#0a97d9',
  '#56c02b',
  '#00689d',
  '#19486a',
] as const;

/** The slice of a log these helpers read. */
export type PartnerImpactLog = {
  id: string;
  /** Public record id (CIEL-BNU-2026-0421), when one has been issued. */
  publicId?: string | null;
  title: string;
  activityType: string;
  activityTypeOther?: string | null;
  activityDate: string | null;
  location: string;
  summary: string;
  sdg: number | null;
  secondarySdgs?: number[] | null;
  peopleReached: number | null;
  peopleTarget?: number | null;
  host: string | null;
  hostEmail: string | null;
  partners: unknown;
  facultyEmail: string;
  evidence: unknown[] | null;
  participants: {
    email: string;
    present: boolean;
    minutes: number;
    userId?: string | null;
    joinStatus?: string;
  }[];
};

export type PartnerRecipient = { email: string; name: string };

const lower = (v: unknown) =>
  typeof v === 'string' ? v.trim().toLowerCase() : '';

/**
 * Who hears about the log: the host organisation and every partner organisation that has an email.
 * Anyone who is also a participant or the coordinating faculty is skipped (a student typing their
 * own address as "partner" must not be mailed a partner message), and each address appears once.
 */
export function partnerRecipients(log: PartnerImpactLog): PartnerRecipient[] {
  const excluded = new Set<string>(
    [log.facultyEmail, ...(log.participants ?? []).map((p) => p.email)]
      .map(lower)
      .filter(Boolean),
  );
  const out: PartnerRecipient[] = [];
  const seen = new Set<string>();
  const add = (email: unknown, name: unknown) => {
    const e = lower(email);
    if (!e || !EMAIL_RE.test(e) || e.length > 254) return;
    if (excluded.has(e) || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, name: typeof name === 'string' ? name.trim() : '' });
  };
  add(log.hostEmail, log.host);
  for (const p of partnerList(log.partners)) add(p.email, p.name);
  return out;
}

/** True when this address is the host's or one of the partners' on the log. */
export function isPartnerEmailOnLog(
  log: Pick<PartnerImpactLog, 'hostEmail' | 'partners'>,
  email: string,
): boolean {
  const e = lower(email);
  if (!e) return false;
  if (lower(log.hostEmail) === e) return true;
  return partnerList(log.partners).some((p) => lower(p.email) === e);
}

/** "3 Nov 2026" from a YYYY-MM-DD activity date; the raw text when it is not one. */
export function formatActivityDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return String(value ?? '').trim() || 'Date not recorded';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : m[0];
}

/** What a partner may see about an approved log: counts and the activity itself, never students' names or contacts. */
export function partnerImpactFacts(log: PartnerImpactLog) {
  // Same rule as the student's own flashcard: present, with recorded time.
  const credited = (log.participants ?? []).filter(
    (p) => p.present && (p.minutes || 0) > 0,
  );
  const minutes = credited.reduce((a, p) => a + (p.minutes || 0), 0);
  const goals = normalizeSdgs(log.sdg, log.secondarySdgs);
  const sdgs = [goals.sdg, ...goals.secondarySdgs]
    .filter((n): n is number => n !== null)
    .map((n, i) => ({
      n,
      name: SDG_NAMES[n - 1],
      color: SDG_COLORS[n - 1],
      main: i === 0,
    }));
  const sdg = goals.sdg;
  const other = (log.activityTypeOther ?? '').trim();
  return {
    id: log.id,
    publicId: log.publicId ?? null,
    title: (log.title || 'Community activity').trim(),
    activityType:
      log.activityType === 'Other service activity' && other
        ? `Other: ${other}`
        : log.activityType || 'Community activity',
    date: formatActivityDate(log.activityDate),
    activityDate: log.activityDate,
    venue: (log.location || '').trim() || 'Venue not recorded',
    summary: (log.summary || '').trim(),
    hours: Number((minutes / 60).toFixed(2)),
    students: credited.length,
    peopleReached: log.peopleReached ?? null,
    peopleTarget: log.peopleTarget ?? null,
    evidenceCount: Array.isArray(log.evidence) ? log.evidence.length : 0,
    // The main goal (older readers) and the full list, main first.
    sdg,
    sdgName: sdg ? SDG_NAMES[sdg - 1] : null,
    sdgColor: sdg ? SDG_COLORS[sdg - 1] : null,
    sdgs,
    host: (log.host ?? '').trim() || null,
    partners: partnerList(log.partners).map((p) => p.name),
  };
}

export type PartnerImpactFacts = ReturnType<typeof partnerImpactFacts>;

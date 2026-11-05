/** Pure helpers for public record ids: CIEL-{UNI}-{ACADEMIC YEAR}-{SEQ}, e.g. CIEL-BNU-2026-0421. */

export type RecordKind =
  | 'community_engagement'
  | 'quick_impact'
  | 'coursework'
  | 'fyp'
  | 'startup';

export const RECORD_KINDS: RecordKind[] = [
  'community_engagement',
  'quick_impact',
  'coursework',
  'fyp',
  'startup',
];

/** The Pakistani academic year starts in August: 1 Aug 2026 – 31 Jul 2027 is "2026". */
export const ACADEMIC_YEAR_START_MONTH_INDEX = 7;

export function academicYearOf(date: Date): number {
  const d = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = d.getUTCFullYear();
  return d.getUTCMonth() >= ACADEMIC_YEAR_START_MONTH_INDEX ? year : year - 1;
}

export function formatPublicId(
  code: string,
  academicYear: number,
  seq: number,
): string {
  return `CIEL-${code}-${academicYear}-${String(seq).padStart(4, '0')}`;
}

const PUBLIC_ID_RE = /^CIEL-([A-Z0-9]{2,10})-(\d{4})-(\d{4,})$/;

export function parsePublicId(
  value: unknown,
): { code: string; academicYear: number; seq: number } | null {
  if (typeof value !== 'string') return null;
  const m = PUBLIC_ID_RE.exec(value.trim().toUpperCase());
  if (!m) return null;
  return { code: m[1], academicYear: Number(m[2]), seq: Number(m[3]) };
}

export function isPublicId(value: unknown): boolean {
  return parsePublicId(value) !== null;
}

export function normalizeUniversityCode(value: unknown): string {
  return typeof value === 'string'
    ? value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';
}

const FILLER_WORDS = new Set(['of', 'the', 'and', 'for', 'in', 'at']);

/**
 * A code for a university that is not in the listed set: the initials of its words (parenthesised
 * abbreviation wins), made unique against `taken` with a numeric suffix. Admins can review it.
 */
export function deriveUniversityCode(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const paren = /\(([^()]{2,10})\)\s*$/.exec(name);
  let base = paren ? normalizeUniversityCode(paren[1]) : '';
  if (base.length < 2) {
    base = name
      .split(/[^A-Za-z0-9]+/)
      .filter((w) => w && !FILLER_WORDS.has(w.toLowerCase()))
      .map((w) => w[0].toUpperCase())
      .join('');
  }
  if (base.length < 2) base = normalizeUniversityCode(name).slice(0, 4);
  if (base.length < 2) base = 'UNI';
  base = base.slice(0, 8);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}${i}`.slice(0, 10);
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not derive a unique university code for "${name}"`);
}

/** "Beaconhouse National University (BNU)" is often typed without its abbreviation — keep that spelling as an alias. */
export function aliasesFor(name: string): string[] {
  const base = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return base && base !== name ? [base] : [];
}

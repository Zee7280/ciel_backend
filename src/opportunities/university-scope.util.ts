import { academicDepartmentsMatch } from '../common/academic-department.util';

/**
 * University scope of an opportunity, shared by apply (students.service) and seat registration
 * (engagement.service) so a member can never be seated at a university the listing excludes.
 * Mirrors the frontend's collectUniversityParticipationAllowlist / canonicalUniversityAllowlist.
 */

export function foldUniversityName(name: unknown): string {
  return (typeof name === 'string' ? name : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The "(BNU)" part of "Beaconhouse National University (BNU)", folded; '' when there is none. */
function parenthesisedAbbreviation(name: unknown): string {
  if (typeof name !== 'string') return '';
  const m = name.match(/\(([^()]{2,12})\)\s*$/);
  return m ? foldUniversityName(m[1]) : '';
}

/**
 * Same institution despite spelling / punctuation, or the listed abbreviation of a full name
 * ("BNU" ↔ "Beaconhouse National University (BNU)"). Free-text prefixes such as "UET" vs
 * "UET Taxila" deliberately do NOT match — they are different campuses.
 */
export function universityNamesMatch(a: unknown, b: unknown): boolean {
  const fa = foldUniversityName(a);
  const fb = foldUniversityName(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const abbrA = parenthesisedAbbreviation(a);
  const abbrB = parenthesisedAbbreviation(b);
  return (!!abbrA && abbrA === fb) || (!!abbrB && abbrB === fa);
}

/** Postgres twin of {@link foldUniversityName}. */
function foldUniversityNameSql(expr: string): string {
  return `TRIM(REGEXP_REPLACE(LOWER(COALESCE(${expr}, '')), '[^a-z0-9]+', ' ', 'g'))`;
}

/**
 * SQL condition that is true exactly when {@link universityNamesMatch}(column value, `name`) is —
 * for filtering rows in the database by the same rule apply eligibility uses. `paramPrefix` keeps
 * the bound parameter names unique when several of these share one query.
 */
export function universityNameMatchSql(
  columnExpr: string,
  name: unknown,
  paramPrefix: string,
): { sql: string; params: Record<string, string | string[]> } {
  const full = foldUniversityName(name);
  if (!full) return { sql: 'FALSE', params: {} };
  const keys = [...new Set([full, parenthesisedAbbreviation(name)])].filter(
    Boolean,
  );
  const abbr = foldUniversityNameSql(
    `SUBSTRING(COALESCE(${columnExpr}, '') FROM '\\(([^()]{2,12})\\)\\s*$')`,
  );
  return {
    sql: `(${foldUniversityNameSql(columnExpr)} IN (:...${paramPrefix}Keys) OR (${abbr} <> '' AND ${abbr} = :${paramPrefix}Full))`,
    params: { [`${paramPrefix}Keys`]: keys, [`${paramPrefix}Full`]: full },
  };
}

type ScopeLike =
  | {
      restricted_universities?: unknown;
      participation_scope?: unknown;
      visibility_and_academic_linkage?: unknown;
    }
  | null
  | undefined;

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
}

/** Universities the listing is open to, deduped; empty = any university. */
export function collectOpportunityUniversityAllowlist(
  opp: ScopeLike,
): string[] {
  if (!opp) return [];
  const names: string[] = [...stringList(opp.restricted_universities)];

  const scope =
    opp.participation_scope && typeof opp.participation_scope === 'object'
      ? (opp.participation_scope as Record<string, unknown>)
      : null;
  const rule = typeof scope?.rule === 'string' ? scope.rule.toLowerCase() : '';
  const openAll = rule === 'open_all_universities';

  if (scope && !openAll) {
    if (
      rule === 'restricted_specific_universities' ||
      rule === 'departments_across_universities'
    ) {
      names.push(...stringList(scope.university_names));
    }
    if (
      rule === 'own_university_only' ||
      rule === 'own_university_departments'
    ) {
      const creator = scope.creator_university_name;
      if (typeof creator === 'string' && creator.trim())
        names.push(creator.trim());
    }
  }

  if (!openAll) {
    const linkage =
      opp.visibility_and_academic_linkage &&
      typeof opp.visibility_and_academic_linkage === 'object'
        ? (opp.visibility_and_academic_linkage as Record<string, unknown>)
        : null;
    names.push(...stringList(linkage?.restricted_university_names));
  }

  const out: string[] = [];
  for (const n of names) {
    if (!out.some((seen) => universityNamesMatch(seen, n))) out.push(n);
  }
  return out;
}

/**
 * null when `university` may take a seat on this listing; otherwise a message naming who is
 * blocked and which universities are allowed.
 */
export function universityScopeError(
  university: unknown,
  opp: ScopeLike,
  who = 'This student',
): string | null {
  const allow = collectOpportunityUniversityAllowlist(opp);
  if (allow.length === 0) return null;
  const name = typeof university === 'string' ? university.trim() : '';
  const allowed = allow.join(', ');
  if (!name) {
    return `${who} has no university set — this opportunity is open to ${allowed} students only.`;
  }
  if (allow.some((a) => universityNamesMatch(a, name))) return null;
  return `${who} is at ${name}, but this opportunity is open to ${allowed} students only.`;
}

/** Departments / programmes the listing is limited to, in listing spelling; empty = any department. */
export function collectOpportunityDepartmentAllowlist(
  opp: ScopeLike,
): string[] {
  const scope =
    opp?.participation_scope && typeof opp.participation_scope === 'object'
      ? (opp.participation_scope as Record<string, unknown>)
      : null;
  if (!scope) return [];
  const rule = typeof scope.rule === 'string' ? scope.rule.toLowerCase() : '';
  const restriction =
    scope.department_restriction &&
    typeof scope.department_restriction === 'object'
      ? (scope.department_restriction as Record<string, unknown>)
      : null;
  const departments = stringList(restriction?.departments);
  const specific =
    String(
      (restriction?.scope as string | undefined) ?? 'all',
    ).toLowerCase() === 'specific' ||
    rule === 'departments_across_universities' ||
    rule === 'own_university_departments';
  return specific ? departments : [];
}

/**
 * null when `person` may take a seat on this listing; otherwise a message naming who is blocked
 * and what the listing is open to. University first (same words as universityScopeError), then
 * the department / programme list, compared through academicDepartmentsMatch so a profile
 * programme ("BS Computer Science") satisfies a listing department ("Computer Science").
 */
export function participationScopeError(
  person: { university?: unknown; department?: unknown },
  opp: ScopeLike,
  who = 'This student',
  options: {
    /** false: a blank department is not judged here (a later account-based check decides). */
    requireDepartment?: boolean;
  } = {},
): string | null {
  const uniErr = universityScopeError(person.university, opp, who);
  if (uniErr) return uniErr;
  const departments = collectOpportunityDepartmentAllowlist(opp);
  if (departments.length === 0) return null;
  const dept =
    typeof person.department === 'string' ? person.department.trim() : '';
  const allowed = departments.join(', ');
  if (!dept) {
    if (options.requireDepartment === false) return null;
    return `${who} has no department / programme set — this opportunity is open to ${allowed} students only.`;
  }
  if (departments.some((d) => academicDepartmentsMatch(d, dept))) return null;
  return `${who} is in ${dept}, but this opportunity is open to ${allowed} students only.`;
}

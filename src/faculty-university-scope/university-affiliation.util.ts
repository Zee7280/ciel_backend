import { PAKISTANI_UNIVERSITIES } from '../auth/constants/pakistani-universities';
import {
  foldUniversityName,
  universityNamesMatch,
} from '../opportunities/university-scope.util';

/**
 * The single rule for "does this person belong to that university organization?". Every
 * university-facing view (dashboard, reports, Impact Wall, analytics, coursework / FYP / venture,
 * delegated faculty) decides membership here, so they can never disagree about who counts.
 */

const LISTED_UNIVERSITY_KEYS = new Set(
  PAKISTANI_UNIVERSITIES.map((name) => foldUniversityName(name)),
);

/** True for a name from the approved Pakistani university list (the signup dropdown). */
export function isListedUniversityName(name: unknown): boolean {
  const key = foldUniversityName(name);
  return !!key && LISTED_UNIVERSITY_KEYS.has(key);
}

export type UniversityOrgRef = { id: string; name: string };

export type AffiliationInput = {
  /** The account's own organization link (university staff / legacy linked students). */
  organizationId?: string | null;
  /** Profile fields the student picked at signup. */
  university?: string | null;
  institution?: string | null;
  /** University names typed elsewhere: a project seat, a coursework / FYP / venture entry. */
  claims?: Array<string | null | undefined>;
  /** Organization ids recorded on a project seat (`universityId`). */
  claimedOrganizationIds?: Array<string | null | undefined>;
};

/**
 * Membership, in order of authority:
 *  1. the account is linked to the organization;
 *  2. the profile university / institution names it;
 *  3. a profile naming another *listed* university is authoritative — a seat or entry that types a
 *     different university must not move the student (or let them land on another wall);
 *  4. otherwise (blank or legacy free-text profile) a seat / entry naming it counts.
 */
export function isAffiliatedWithUniversity(
  input: AffiliationInput,
  org: UniversityOrgRef,
): boolean {
  if (!org?.id) return false;
  if (input.organizationId && input.organizationId === org.id) return true;
  const profile = [input.university, input.institution]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (profile.some((name) => universityNamesMatch(name, org.name))) return true;
  if (profile.some((name) => isListedUniversityName(name))) return false;
  if ((input.claimedOrganizationIds ?? []).some((id) => id === org.id)) {
    return true;
  }
  return (input.claims ?? []).some((name) =>
    universityNamesMatch(name, org.name),
  );
}

/**
 * A faculty account may represent a university unless its own profile names a different listed
 * university (a blank or free-text profile cannot be judged and is left to the university).
 */
export function facultyMayRepresentUniversity(
  faculty: { university?: string | null; institution?: string | null },
  org: UniversityOrgRef,
): boolean {
  const profile = [faculty.university, faculty.institution]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (profile.some((name) => universityNamesMatch(name, org.name))) return true;
  return !profile.some((name) => isListedUniversityName(name));
}

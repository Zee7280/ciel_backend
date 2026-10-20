/**
 * Student subscription fee: a one-time fee charged at signup to students whose university is NOT a
 * CIEL member university (an approved Organization of university type). Mirrors the partner
 * membership-fee flow: the account starts in `pending_subscription_payment`, the student uploads a
 * bank-transfer proof, and an admin approves it to activate the account.
 */

/** Admin → Settings: require the subscription fee for non-member-university students (default on). */
export const STUDENT_SUBSCRIPTION_REQUIRED_KEY =
  'STUDENT_SUBSCRIPTION_REQUIRED';

/** Admin → Settings: the fee amount in whole PKR (default 300). */
export const STUDENT_SUBSCRIPTION_FEE_PKR_KEY = 'STUDENT_SUBSCRIPTION_FEE_PKR';

export const STUDENT_SUBSCRIPTION_DEFAULT_FEE_PKR = 300;

/** User.status while the subscription fee is unpaid / unverified. Login is allowed; student tools are not. */
export const PENDING_SUBSCRIPTION_STATUS = 'pending_subscription_payment';

export function parseStudentSubscriptionRequiredSettingValue(
  value: string | null | undefined,
  defaultEnabled = true,
): boolean {
  if (value == null || String(value).trim() === '') return defaultEnabled;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized))
    return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  return defaultEnabled;
}

export function parseStudentSubscriptionFeePkr(
  value: string | null | undefined,
  fallback = STUDENT_SUBSCRIPTION_DEFAULT_FEE_PKR,
): number {
  const n = parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Case/whitespace-insensitive university name key used to match a student's university to an Organization. */
export function normalizeUniversityName(
  name: string | null | undefined,
): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Acronym inside trailing parentheses, e.g. "beaconhouse national university (bnu)" → "bnu". */
function parenthesisedAcronym(name: string): string {
  const m = /\(([^()]+)\)\s*$/.exec(name);
  return m ? m[1].trim() : '';
}

/**
 * Tolerant equality for university names (both already normalized via normalizeUniversityName):
 * exact match, acronym match, or containment of a name at least 3 characters long.
 */
export function universityNamesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aa = parenthesisedAcronym(a);
  const ab = parenthesisedAcronym(b);
  if (aa && (aa === b || aa === ab)) return true;
  if (ab && ab === a) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  return shorter.length >= 3 && longer.includes(shorter);
}

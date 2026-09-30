/**
 * Emailed magic-link tokens are credentials: possession of `faculty_verification_token` /
 * `partnerToken` / `liaisonToken` approves that gate anonymously via POST /verifications/verify.
 * Any API response that returns an Opportunity row to a browser session (the creator included —
 * a student or partner must never be able to approve their own gate) must therefore not carry the
 * raw value. The dashboards only use these fields as "is a gate configured" flags, so a non-empty
 * placeholder keeps those checks working without exposing the credential.
 */
export const OPPORTUNITY_SECRET_KEYS = [
  'faculty_verification_token',
  'partnerToken',
  'liaisonToken',
  'execution_verification_token',
] as const;

export const REDACTED_TOKEN_PLACEHOLDER = '[redacted]';

const MAX_DEPTH = 12;

export function redactOpportunitySecrets<T>(value: T, depth = 0): T {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactOpportunitySecrets(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      (OPPORTUNITY_SECRET_KEYS as readonly string[]).includes(k) &&
      typeof v === 'string' &&
      v.length > 0
    ) {
      out[k] = REDACTED_TOKEN_PLACEHOLDER;
    } else {
      out[k] = redactOpportunitySecrets(v, depth + 1);
    }
  }
  return out as T;
}

const CONTACT_KEY_RE =
  /^(email|official_email|officialEmail|partner_email|external_partner_email|contact_email|contactEmail|contact_phone|contactPhone|whatsapp|whatsapp_e164|phone|mobile|student_contact|creator_email)$/i;

/**
 * Third-party contact details (faculty supervisor, partner / executing-organization contacts,
 * WhatsApp numbers, the creator's email) belong to the opportunity's owner, its designated
 * reviewers and CIEL PK admin. Anyone else who can open a *live* opportunity (any signed-in
 * user, or an anonymous visitor of the public directory) gets the record without them.
 * `supervision.contact` is the faculty supervisor's email, so it is handled by position.
 */
export function redactOpportunityContactDetails<T>(
  value: T,
  parentKey = '',
  depth = 0,
): T {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    return value.map((v) =>
      redactOpportunityContactDetails(v, parentKey, depth + 1),
    ) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (CONTACT_KEY_RE.test(k)) continue;
    if (k === 'contact' && parentKey === 'supervision') continue;
    if (k === 'approvalHistory' && Array.isArray(v)) {
      // Actor names of emailed-link approvals are the reviewer's email address.
      out[k] = v.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const { actorId: _id, actorName: _name, ...rest } = entry as Record<string, unknown>;
        return rest;
      });
      continue;
    }
    out[k] = redactOpportunityContactDetails(v, k, depth + 1);
  }
  return out as T;
}

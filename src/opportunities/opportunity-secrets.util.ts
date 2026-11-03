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
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH)
    return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) =>
      redactOpportunitySecrets(v, depth + 1),
    ) as unknown as T;
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
  /^(email|official_email|officialEmail|partner_email|external_partner_email|contact_email|contactEmail|contact_phone|contactPhone|whatsapp|whatsapp_e164|phone|mobile|student_contact|creator_email|(?:[a-z_]*_)?(?:whatsapp|phone|mobile)(?:_[a-z0-9]+)?)$/i;

/** Rebuilds the authorised block from its display fields only (never forwards extra keys). */
function keepPartnerContactBlock(value: unknown): {
  organization_name: string | null;
  email: string | null;
  whatsapp: string | null;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) =>
    typeof x === 'string' && x.trim() ? x.trim() : null;
  const block = {
    organization_name: str(v.organization_name),
    email: str(v.email),
    whatsapp: str(v.whatsapp),
  };
  return block.email || block.whatsapp ? block : null;
}

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
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH)
    return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) =>
      redactOpportunityContactDetails(v, parentKey, depth + 1),
    ) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // `partner_contact` is attached by the service AFTER it decided this viewer may see the
    // creating organisation's contact (signed-in + partner-created). Only that one response
    // position survives, and only its three display fields; anything else named like a contact
    // is still dropped below.
    if (k === 'partner_contact' && parentKey === 'data' && depth === 1) {
      out[k] = keepPartnerContactBlock(v);
      continue;
    }
    if (CONTACT_KEY_RE.test(k)) continue;
    if (k === 'contact' && parentKey === 'supervision') continue;
    if (k === 'approvalHistory' && Array.isArray(v)) {
      // Actor names of emailed-link approvals are the reviewer's email address.
      out[k] = (v as unknown[]).map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const rest: Record<string, unknown> = {
          ...(entry as Record<string, unknown>),
        };
        delete rest.actorId;
        delete rest.actorName;
        return rest;
      });
      continue;
    }
    out[k] = redactOpportunityContactDetails(v, k, depth + 1);
  }
  return out as T;
}

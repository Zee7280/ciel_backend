import { classifyBrowseCreator } from './student-browse-listing.util';

/** The organisation contact shown on a partner-created opportunity's card. */
export interface PartnerContactBlock {
  organization_name: string | null;
  email: string | null;
  /** E.164 (`+92…`) or whatever the partner typed; the card strips it to digits for wa.me. */
  whatsapp: string | null;
}

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const email = (v: unknown): string => {
  const s = text(v).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
};

/**
 * Whether a partner / NGO organisation created the opportunity (same rule the Browse "posted by"
 * filter uses): the creator's role says so, else it is organisation-owned and not a student or
 * faculty listing.
 */
export function isPartnerCreatedOpportunity(
  opportunity: {
    isStudentCreated?: unknown;
    facultyId?: unknown;
    organizationId?: unknown;
  },
  creatorRole?: string | null,
): boolean {
  return (
    classifyBrowseCreator({
      isStudentCreated: opportunity.isStudentCreated,
      facultyId: opportunity.facultyId,
      organizationId: opportunity.organizationId,
      created_by_role: creatorRole ?? undefined,
    }) === 'partner'
  );
}

/**
 * The contact a student may use to reach the organisation that created the opportunity.
 *
 * Email: the executing organisation's official email typed on the request form, else the
 * organisation profile's contact email, else the creator's account email.
 * WhatsApp: the number typed on the request form, else the organisation profile's contact phone,
 * else the creator's account phone.
 *
 * Returns null for anything that is not partner-created, or when no email and no WhatsApp exists.
 * The caller decides WHO may receive it (signed-in viewers only) — this only decides WHAT it is.
 */
export function resolvePartnerContact(
  opportunity: {
    isStudentCreated?: unknown;
    facultyId?: unknown;
    organizationId?: unknown;
    supervision?: unknown;
    executing_organization?: unknown;
    organization?: {
      name?: unknown;
      contactEmail?: unknown;
      contactPhone?: unknown;
    } | null;
  },
  creator: {
    role?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null,
): PartnerContactBlock | null {
  if (!isPartnerCreatedOpportunity(opportunity, creator?.role)) return null;

  const exec = rec(opportunity.executing_organization);
  const sup = rec(opportunity.supervision);
  const org = rec(opportunity.organization);

  const contactEmail =
    email(exec.official_email) ||
    email(exec.officialEmail) ||
    email(sup.contact) ||
    email(org.contactEmail) ||
    email(creator?.email);
  const whatsapp =
    text(sup.whatsapp_e164) || text(org.contactPhone) || text(creator?.phone);
  if (!contactEmail && !whatsapp) return null;

  return {
    organization_name:
      text(exec.name) || text(exec.organization_name) || text(org.name) || null,
    email: contactEmail || null,
    whatsapp: whatsapp || null,
  };
}

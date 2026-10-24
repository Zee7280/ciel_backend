/** When true, new NGO/partner registrations require membership fee before full portal access. */
export const PARTNER_MEMBERSHIP_REQUIRED_KEY = 'PARTNER_MEMBERSHIP_REQUIRED';

export const MEMBERSHIP_FEE_PARTNER_PKR_KEY = 'MEMBERSHIP_FEE_PARTNER_PKR';

export function parsePartnerMembershipRequiredSettingValue(
  value: string | null | undefined,
  defaultEnabled = false,
): boolean {
  if (value == null || String(value).trim() === '') return defaultEnabled;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized))
    return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  return defaultEnabled;
}

/** When true, new university accounts pay the membership fee before portal access (default off). */
export const UNIVERSITY_MEMBERSHIP_REQUIRED_KEY =
  'UNIVERSITY_MEMBERSHIP_REQUIRED';

/** When true, new corporate accounts pay the membership fee before portal access (default off). */
export const CORPORATE_MEMBERSHIP_REQUIRED_KEY =
  'CORPORATE_MEMBERSHIP_REQUIRED';

/**
 * User.status of a university / corporate account created while its membership fee is off. The fee
 * used to be the only CIEL check on these accounts, so without it they wait for an admin to approve
 * their organization; login activates them once it is APPROVED.
 */
export const PENDING_ORG_VERIFICATION_STATUS = 'pending_org_verification';

/** The admin switch that decides whether this role pays a membership fee, or null when it never does. */
export function membershipRequiredSettingKey(role: string): string | null {
  switch (role) {
    case 'ngo':
      return PARTNER_MEMBERSHIP_REQUIRED_KEY;
    case 'university':
      return UNIVERSITY_MEMBERSHIP_REQUIRED_KEY;
    case 'corporate':
      return CORPORATE_MEMBERSHIP_REQUIRED_KEY;
    default:
      return null;
  }
}

/** Inverse of {@link membershipRequiredSettingKey}: the role a membership switch controls. */
export function membershipRoleForSettingKey(key: string): string | null {
  return (
    (['ngo', 'university', 'corporate'] as const).find(
      (role) => membershipRequiredSettingKey(role) === key,
    ) ?? null
  );
}

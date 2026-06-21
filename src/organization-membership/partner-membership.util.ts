/** When true, new NGO/partner registrations require membership fee before full portal access. */
export const PARTNER_MEMBERSHIP_REQUIRED_KEY = 'PARTNER_MEMBERSHIP_REQUIRED';

export const MEMBERSHIP_FEE_PARTNER_PKR_KEY = 'MEMBERSHIP_FEE_PARTNER_PKR';

export function parsePartnerMembershipRequiredSettingValue(
    value: string | null | undefined,
    defaultEnabled = false,
): boolean {
    if (value == null || String(value).trim() === '') return defaultEnabled;
    const normalized = String(value).trim().toLowerCase();
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    return defaultEnabled;
}

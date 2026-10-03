/** Settings-table keys edited from Admin → Settings. Every key here has a real reader in the backend. */
export const PLATFORM_SETTING_KEYS = {
  MAINTENANCE_MODE: 'maintenance_mode',
  ALLOW_REGISTRATIONS: 'allow_registrations',
  SITE_NAME: 'site_name',
  CONTACT_EMAIL: 'contact_email',
  ADMIN_REVIEW_EMAILS: 'ADMIN_REVIEW_EMAILS',
  REPORTING_FEE_PKR: 'REPORTING_FEE_PKR',
  MEMBERSHIP_FEE_UNIVERSITY_PKR: 'MEMBERSHIP_FEE_UNIVERSITY_PKR',
  MEMBERSHIP_FEE_CORPORATE_PKR: 'MEMBERSHIP_FEE_CORPORATE_PKR',
  REVIEW_SLA_DAYS: 'REVIEW_SLA_DAYS',
} as const;

export function parseBooleanSetting(
  value: string | null | undefined,
  fallback: boolean,
): boolean {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

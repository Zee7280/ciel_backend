/**
 * "Partner" is not a separate account type: the role enum maps PARTNER to the same value as NGO
 * ('ngo'), and old rows with role 'partner' were migrated to 'ngo'. Anything that still sends the
 * word "partner" (older clients, admin tools, filters) means the NGO / Partner account type.
 */
export function normalizeUserRoleInput<T>(value: T): T | 'ngo' {
  return typeof value === 'string' && value.trim().toLowerCase() === 'partner'
    ? 'ngo'
    : value;
}

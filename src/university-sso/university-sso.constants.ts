/** Identity providers a university can be configured with. Google and Microsoft are presets of OpenID Connect. */
export const SSO_PROVIDERS = ['google', 'microsoft', 'oidc'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export const SSO_PROVIDER_LABEL: Record<SsoProvider, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  oidc: 'OpenID Connect',
};

/** draft: configured, not yet live · active: students may sign in · disabled: switched off by an admin. */
export const SSO_STATUSES = ['draft', 'active', 'disabled'] as const;
export type SsoStatus = (typeof SSO_STATUSES)[number];

export const SSO_SCOPE = 'openid email profile';

/** How long a browser has between leaving for the provider and coming back. */
export const SSO_STATE_TTL_SECONDS = 10 * 60;
/** One-time ticket handed to the frontend after a successful callback. */
export const SSO_TICKET_TTL_SECONDS = 2 * 60;
/** Sealed identity a first-time student completes their profile with. */
export const SSO_SIGNUP_TTL_SECONDS = 20 * 60;
/** Admin-issued test sign-in link. */
export const SSO_TEST_LINK_TTL_SECONDS = 24 * 60 * 60;

/** Microsoft multi-tenant endpoints cannot pin a university, so they are never accepted. */
const MICROSOFT_SHARED_TENANTS = new Set([
  'common',
  'organizations',
  'consumers',
]);

export function isMicrosoftTenantId(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v || MICROSOFT_SHARED_TENANTS.has(v)) return false;
  return /^[a-z0-9][a-z0-9.-]{1,120}$/.test(v);
}

export function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

/** Discovery document location for a configured university. */
export function ssoDiscoveryUrlFor(
  provider: SsoProvider,
  issuer: string | null | undefined,
  tenantId: string | null | undefined,
): string {
  switch (provider) {
    case 'google':
      return 'https://accounts.google.com/.well-known/openid-configuration';
    case 'microsoft':
      return `https://login.microsoftonline.com/${encodeURIComponent(
        (tenantId ?? '').trim(),
      )}/v2.0/.well-known/openid-configuration`;
    default:
      return `${(issuer ?? '').trim().replace(/\/+$/, '')}/.well-known/openid-configuration`;
  }
}

/** `example.edu.pk` from an email or a typed domain; null when it is not a plausible domain. */
export function normalizeDomain(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) || v.length > 253) return null;
  return v;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}

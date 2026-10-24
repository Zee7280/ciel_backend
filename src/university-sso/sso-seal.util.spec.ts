import { deriveSsoKey, seal, unseal } from './sso-seal.util';
import {
  isMicrosoftTenantId,
  normalizeDomain,
  ssoDiscoveryUrlFor,
} from './university-sso.constants';

describe('sealed SSO tokens', () => {
  const key = deriveSsoKey('a-long-enough-development-secret');
  const NOW = 1_800_000_000_000;

  it('round-trips data of the same kind before expiry', () => {
    const token = seal(key, 'state', { u: 'org', n: 'nonce' }, 600, NOW);
    expect(unseal(key, 'state', token, NOW + 599_000)).toEqual({
      u: 'org',
      n: 'nonce',
    });
  });

  it('is URL-safe', () => {
    const token = seal(key, 'state', { next: '/dashboard?x=1&y=2' }, 600, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects expiry, another kind, another key, tampering and garbage', () => {
    const token = seal(key, 'state', { u: 'org' }, 600, NOW);
    expect(unseal(key, 'state', token, NOW + 601_000)).toBeNull();
    expect(unseal(key, 'signup', token, NOW)).toBeNull();
    expect(
      unseal(deriveSsoKey('another-secret-value-here'), 'state', token, NOW),
    ).toBeNull();
    const flipped = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
    expect(unseal(key, 'state', flipped, NOW)).toBeNull();
    expect(unseal(key, 'state', 'nope', NOW)).toBeNull();
    expect(unseal(key, 'state', undefined, NOW)).toBeNull();
  });
});

describe('university SSO configuration rules', () => {
  it('normalizes email domains and rejects non-domains', () => {
    expect(normalizeDomain(' @Students.GIFT.edu.pk ')).toBe(
      'students.gift.edu.pk',
    );
    expect(normalizeDomain('gift')).toBeNull();
    expect(normalizeDomain('gift edu.pk')).toBeNull();
    expect(normalizeDomain('http://gift.edu.pk')).toBeNull();
  });

  it('refuses Microsoft shared tenants', () => {
    expect(isMicrosoftTenantId('common')).toBe(false);
    expect(isMicrosoftTenantId('organizations')).toBe(false);
    expect(isMicrosoftTenantId('9188040d-6c67-4c5b-b112-36a304b66dad')).toBe(
      true,
    );
    expect(isMicrosoftTenantId('gift.onmicrosoft.com')).toBe(true);
  });

  it('derives discovery URLs per provider', () => {
    expect(ssoDiscoveryUrlFor('google', null, null)).toBe(
      'https://accounts.google.com/.well-known/openid-configuration',
    );
    expect(ssoDiscoveryUrlFor('microsoft', null, 'abc-tenant')).toBe(
      'https://login.microsoftonline.com/abc-tenant/v2.0/.well-known/openid-configuration',
    );
    expect(ssoDiscoveryUrlFor('oidc', 'https://sso.gift.edu.pk/', null)).toBe(
      'https://sso.gift.edu.pk/.well-known/openid-configuration',
    );
  });
});

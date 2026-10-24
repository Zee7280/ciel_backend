import {
  decryptWithKey,
  deriveAesKey,
  encryptWithKey,
} from '../common/aes-gcm.util';

/**
 * Sealed (encrypted + authenticated) short-lived tokens that carry SSO flow state through the
 * browser: the OIDC state (nonce, PKCE verifier), a first-time student's verified identity, and
 * admin test links. They are not JWTs on purpose: nothing minted here can ever be presented as a
 * session token.
 */
export function deriveSsoKey(raw: string): Buffer {
  return deriveAesKey(raw, 'ciel-university-sso');
}

export function seal(
  key: Buffer,
  kind: string,
  data: Record<string, unknown>,
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  const payload = JSON.stringify({
    k: kind,
    exp: Math.floor(now / 1000) + ttlSeconds,
    d: data,
  });
  return Buffer.from(encryptWithKey(key, payload), 'utf8').toString(
    'base64url',
  );
}

/** The sealed data, or null when the token is tampered with, of another kind, or expired. */
export function unseal<T>(
  key: Buffer,
  kind: string,
  token: string | null | undefined,
  now: number = Date.now(),
): T | null {
  if (!token || typeof token !== 'string') return null;
  try {
    const plain = decryptWithKey(
      key,
      Buffer.from(token, 'base64url').toString('utf8'),
    );
    const parsed = JSON.parse(plain) as {
      k?: unknown;
      exp?: unknown;
      d?: unknown;
    };
    if (parsed.k !== kind) return null;
    if (typeof parsed.exp !== 'number' || parsed.exp * 1000 < now) return null;
    return (parsed.d ?? null) as T | null;
  } catch {
    return null;
  }
}

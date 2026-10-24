import * as crypto from 'crypto';

/**
 * Minimal OpenID Connect relying-party pieces (discovery, PKCE, code exchange, ID-token
 * verification) on Node's own crypto and fetch. Pure functions with an injectable fetch, so the
 * unit tests and the e2e mock provider need no network and no extra dependency.
 */

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Jwk = {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
};

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  given_name?: string;
  family_name?: string;
  /** Google Workspace hosted domain. */
  hd?: string;
  /** Microsoft Entra tenant id. */
  tid?: string;
  preferred_username?: string;
  [claim: string]: unknown;
};

const CACHE_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const discoveryCache = new Map<string, { value: OidcDiscovery; at: number }>();
const jwksCache = new Map<string, { keys: Jwk[]; at: number }>();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Providers must be reached over https; plain http is allowed only for a local mock. */
export function assertHttpsUrl(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OidcError('bad_url', `${what} is not a valid URL`);
  }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new OidcError('bad_url', `${what} must use https`);
  }
  return parsed;
}

export async function fetchDiscovery(
  url: string,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now(),
): Promise<OidcDiscovery> {
  const hit = discoveryCache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  assertHttpsUrl(url, 'Discovery URL');
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new OidcError(
      'discovery_failed',
      `Could not reach the identity provider (${(e as Error).message})`,
    );
  }
  if (!res.ok) {
    throw new OidcError(
      'discovery_failed',
      `Identity provider discovery returned HTTP ${res.status}`,
    );
  }
  const json = (await res
    .json()
    .catch(() => null)) as Partial<OidcDiscovery> | null;
  const fields = [
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
  ] as const;
  for (const field of fields) {
    if (!json || typeof json[field] !== 'string' || !json[field]) {
      throw new OidcError(
        'discovery_invalid',
        `Discovery document is missing ${field}`,
      );
    }
  }
  const value: OidcDiscovery = {
    issuer: json!.issuer!,
    authorization_endpoint: json!.authorization_endpoint!,
    token_endpoint: json!.token_endpoint!,
    jwks_uri: json!.jwks_uri!,
  };
  assertHttpsUrl(value.authorization_endpoint, 'authorization_endpoint');
  assertHttpsUrl(value.token_endpoint, 'token_endpoint');
  assertHttpsUrl(value.jwks_uri, 'jwks_uri');
  discoveryCache.set(url, { value, at: now });
  return value;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  discovery: OidcDiscovery,
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    scope: string;
    extra?: Record<string, string | undefined>;
  },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(params.extra ?? {})) {
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function exchangeCode(
  discovery: OidcDiscovery,
  params: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<{ id_token: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });
  let res: Response;
  try {
    res = await fetchImpl(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new OidcError(
      'token_exchange_failed',
      `Could not reach the identity provider (${(e as Error).message})`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as {
    id_token?: unknown;
    error?: unknown;
  };
  if (!res.ok || typeof json.id_token !== 'string') {
    const reason =
      typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    throw new OidcError(
      'token_exchange_failed',
      `The identity provider rejected the sign-in (${reason})`,
    );
  }
  return { id_token: json.id_token };
}

async function fetchJwks(
  uri: string,
  fetchImpl: FetchLike,
  force: boolean,
  now: number,
): Promise<Jwk[]> {
  const hit = jwksCache.get(uri);
  if (!force && hit && now - hit.at < CACHE_TTL_MS) return hit.keys;
  assertHttpsUrl(uri, 'jwks_uri');
  const res = await fetchImpl(uri, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new OidcError('jwks_failed', `Key set returned HTTP ${res.status}`);
  }
  const json = (await res.json().catch(() => null)) as {
    keys?: unknown;
  } | null;
  const keys = Array.isArray(json?.keys) ? (json.keys as Jwk[]) : [];
  jwksCache.set(uri, { keys, at: now });
  return keys;
}

function decodeSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    throw new OidcError('id_token_invalid', `Malformed ID token ${what}`);
  }
}

/** Verifies signature (RS256 against the provider's JWKS), issuer, audience, expiry and nonce. */
export async function verifyIdToken(
  idToken: string,
  opts: {
    jwksUri: string;
    issuer: string;
    clientId: string;
    nonce: string;
    fetchImpl?: FetchLike;
    now?: number;
  },
): Promise<IdTokenClaims> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new OidcError('id_token_invalid', 'Malformed ID token');
  }
  const header = decodeSegment<{ alg?: string; kid?: string }>(
    parts[0],
    'header',
  );
  if (header.alg !== 'RS256') {
    throw new OidcError('id_token_invalid', 'Unsupported ID token algorithm');
  }
  let keys = await fetchJwks(opts.jwksUri, fetchImpl, false, now);
  const pick = () =>
    keys.find((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid));
  let jwk = pick();
  if (!jwk) {
    // Key rotation: refresh once before giving up.
    keys = await fetchJwks(opts.jwksUri, fetchImpl, true, now);
    jwk = pick();
  }
  if (!jwk) {
    throw new OidcError(
      'id_token_invalid',
      'ID token signed with an unknown key',
    );
  }
  const publicKey = crypto.createPublicKey({
    key: jwk as unknown as crypto.JsonWebKey,
    format: 'jwk',
  });
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) {
    throw new OidcError('id_token_invalid', 'ID token signature is invalid');
  }
  const claims = decodeSegment<IdTokenClaims>(parts[1], 'payload');
  if (claims.iss !== opts.issuer) {
    throw new OidcError('id_token_invalid', 'ID token issuer does not match');
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) {
    throw new OidcError(
      'id_token_invalid',
      'ID token was issued to another client',
    );
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    throw new OidcError('id_token_invalid', 'ID token has expired');
  }
  if (typeof claims.iat === 'number' && claims.iat * 1000 > now + 5 * 60_000) {
    throw new OidcError('id_token_invalid', 'ID token issued in the future');
  }
  if (!claims.nonce || claims.nonce !== opts.nonce) {
    throw new OidcError('id_token_invalid', 'ID token nonce does not match');
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) {
    throw new OidcError('id_token_invalid', 'ID token has no subject');
  }
  return claims;
}

/** Test hook: forget cached discovery documents and key sets. */
export function resetOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

import * as crypto from 'crypto';
import {
  assertHttpsUrl,
  buildAuthorizationUrl,
  createPkce,
  exchangeCode,
  fetchDiscovery,
  type FetchLike,
  OidcError,
  resetOidcCaches,
  verifyIdToken,
} from './oidc.util';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
const jwks = { keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] };

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (
  claims: unknown,
  header: unknown = { alg: 'RS256', kid: 'k1' },
) => {
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey);
  return `${data}.${sig.toString('base64url')}`;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** A fetch that always answers with this JSON body. */
const replies =
  (body: unknown, status = 200): FetchLike =>
  () =>
    Promise.resolve(json(body, status));

const NOW = 1_800_000_000_000;
const opts = {
  jwksUri: 'https://idp.test/jwks',
  issuer: 'https://idp.test',
  clientId: 'cid',
  nonce: 'n1',
  fetchImpl: replies(jwks),
  now: NOW,
};
const claims = {
  iss: 'https://idp.test',
  sub: 'subject-1',
  aud: 'cid',
  exp: NOW / 1000 + 300,
  iat: NOW / 1000 - 10,
  nonce: 'n1',
  email: 'student@gift.edu.pk',
  email_verified: true,
};

beforeEach(() => resetOidcCaches());

describe('verifyIdToken', () => {
  it('accepts a correctly signed token for this client and nonce', async () => {
    const out = await verifyIdToken(sign(claims), opts);
    expect(out).toMatchObject({
      sub: 'subject-1',
      email: 'student@gift.edu.pk',
    });
  });

  it('rejects a tampered payload', async () => {
    const [h, , s] = sign(claims).split('.');
    const forged = `${h}.${b64({ ...claims, email: 'admin@ciel.pk' })}.${s}`;
    await expect(verifyIdToken(forged, opts)).rejects.toThrow(/signature/);
  });

  it.each([
    ['nonce', { nonce: 'other' }, /nonce/],
    ['audience', { aud: 'someone-else' }, /another client/],
    ['issuer', { iss: 'https://evil.test' }, /issuer/],
    ['expiry', { exp: NOW / 1000 - 1 }, /expired/],
    ['subject', { sub: '' }, /subject/],
  ])('rejects a wrong %s', async (_label, patch, message) => {
    await expect(
      verifyIdToken(sign({ ...claims, ...patch }), opts),
    ).rejects.toThrow(message);
  });

  it('accepts an audience list that includes this client', async () => {
    await expect(
      verifyIdToken(sign({ ...claims, aud: ['x', 'cid'] }), opts),
    ).resolves.toBeTruthy();
  });

  it('refuses alg=none and unknown algorithms', async () => {
    const unsigned = `${b64({ alg: 'none' })}.${b64(claims)}.`;
    await expect(verifyIdToken(unsigned, opts)).rejects.toThrow(/algorithm/);
    await expect(
      verifyIdToken(sign(claims, { alg: 'HS256', kid: 'k1' }), opts),
    ).rejects.toThrow(/algorithm/);
  });

  it('refreshes the key set once for an unknown kid, then gives up', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(json(jwks));
    };
    await expect(
      verifyIdToken(sign(claims, { alg: 'RS256', kid: 'rotated' }), {
        ...opts,
        fetchImpl,
      }),
    ).rejects.toThrow(/unknown key/);
    expect(calls).toBe(2);
  });
});

describe('authorization request helpers', () => {
  it('PKCE challenge is the S256 hash of the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(
      crypto.createHash('sha256').update(verifier).digest('base64url'),
    );
  });

  it('builds the authorization URL with every required parameter', () => {
    const url = new URL(
      buildAuthorizationUrl(
        {
          issuer: 'https://idp.test',
          authorization_endpoint: 'https://idp.test/authorize?tenant=a',
          token_endpoint: 'https://idp.test/token',
          jwks_uri: 'https://idp.test/jwks',
        },
        {
          clientId: 'cid',
          redirectUri: 'https://api.test/api/v1/auth/sso/callback',
          state: 'st',
          nonce: 'n1',
          codeChallenge: 'ch',
          scope: 'openid email profile',
          extra: { hd: 'gift.edu.pk', domain_hint: undefined },
        },
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: 'a',
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://api.test/api/v1/auth/sso/callback',
      scope: 'openid email profile',
      state: 'st',
      nonce: 'n1',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      hd: 'gift.edu.pk',
    });
  });

  it('only https providers, except a local mock', () => {
    expect(() => assertHttpsUrl('http://idp.test/x', 'Issuer')).toThrow(
      OidcError,
    );
    expect(() => assertHttpsUrl('not a url', 'Issuer')).toThrow(OidcError);
    expect(assertHttpsUrl('http://127.0.0.1:5555/x', 'Issuer').port).toBe(
      '5555',
    );
    expect(assertHttpsUrl('https://accounts.google.com', 'Issuer').host).toBe(
      'accounts.google.com',
    );
  });
});

describe('discovery and code exchange', () => {
  const discovery = {
    issuer: 'https://idp.test',
    authorization_endpoint: 'https://idp.test/authorize',
    token_endpoint: 'https://idp.test/token',
    jwks_uri: 'https://idp.test/jwks',
  };

  it('validates and caches the discovery document', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(json(discovery));
    };
    const url = 'https://idp.test/.well-known/openid-configuration';
    expect(await fetchDiscovery(url, fetchImpl, NOW)).toEqual(discovery);
    expect(await fetchDiscovery(url, fetchImpl, NOW + 1000)).toEqual(discovery);
    expect(calls).toBe(1);
    await expect(
      fetchDiscovery(
        'https://idp2.test/.well-known/openid-configuration',
        replies({ issuer: 'x' }),
      ),
    ).rejects.toThrow(/missing authorization_endpoint/);
    await expect(
      fetchDiscovery(
        'https://idp3.test/.well-known/openid-configuration',
        replies({ ...discovery, token_endpoint: 'http://idp.test/token' }),
      ),
    ).rejects.toThrow(/must use https/);
  });

  it('posts the code with PKCE verifier and client secret, surfacing provider errors', async () => {
    let seen = '';
    const ok: FetchLike = (_url, init) => {
      seen = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve(json({ id_token: 'tok' }));
    };
    const params = {
      clientId: 'cid',
      clientSecret: 'shh',
      code: 'c0de',
      redirectUri: 'https://api.test/cb',
      codeVerifier: 'ver',
    };
    expect(await exchangeCode(discovery, params, ok)).toEqual({
      id_token: 'tok',
    });
    expect(Object.fromEntries(new URLSearchParams(seen))).toEqual({
      grant_type: 'authorization_code',
      code: 'c0de',
      redirect_uri: 'https://api.test/cb',
      client_id: 'cid',
      client_secret: 'shh',
      code_verifier: 'ver',
    });
    await expect(
      exchangeCode(discovery, params, replies({ error: 'invalid_grant' }, 400)),
    ).rejects.toThrow(/invalid_grant/);
  });
});

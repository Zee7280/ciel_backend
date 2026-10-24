import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';

export type MockIdpUser = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
  tid?: string;
  preferred_username?: string;
};

/**
 * A tiny OpenID Connect provider on 127.0.0.1 for the e2e suite: discovery, JWKS, an authorize
 * endpoint that immediately redirects back with a code, and a token endpoint that enforces the
 * client secret, PKCE and redirect URI before signing an RS256 ID token for the user set by the test.
 */
export class MockOidcProvider {
  readonly clientId = 'ciel-e2e-client';
  readonly clientSecret = 'ciel-e2e-client-secret-value';
  readonly kid = 'e2e-key-1';
  baseUrl = '';
  tokenRequests = 0;

  private readonly keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  private server: http.Server | null = null;
  private nextUser: MockIdpUser | null = null;
  private readonly pending = new Map<
    string,
    { nonce: string; challenge: string; redirectUri: string; user: MockIdpUser }
  >();

  /** The account the next authorize call signs in as. */
  setUser(user: MockIdpUser | null): void {
    this.nextUser = user;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  signIdToken(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${b64({ alg: 'RS256', kid: this.kid, typ: 'JWT' })}.${b64(claims)}`;
    const sig = crypto.sign(
      'RSA-SHA256',
      Buffer.from(data),
      this.keys.privateKey,
    );
    return `${data}.${sig.toString('base64url')}`;
  }

  private json(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    if (url.pathname === '/.well-known/openid-configuration') {
      return this.json(res, {
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        jwks_uri: `${this.baseUrl}/jwks`,
      });
    }
    if (url.pathname === '/jwks') {
      const jwk = this.keys.publicKey.export({ format: 'jwk' });
      return this.json(res, {
        keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }],
      });
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (
        q.get('client_id') !== this.clientId ||
        q.get('response_type') !== 'code'
      ) {
        return this.json(res, { error: 'invalid_client' }, 400);
      }
      if (!this.nextUser) return this.json(res, { error: 'no_user_set' }, 400);
      const code = crypto.randomBytes(16).toString('hex');
      this.pending.set(code, {
        nonce: q.get('nonce') ?? '',
        challenge: q.get('code_challenge') ?? '',
        redirectUri: q.get('redirect_uri') ?? '',
        user: this.nextUser,
      });
      const back = new URL(q.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const raw = await new Promise<string>((resolve) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => resolve(body));
      });
      const p = new URLSearchParams(raw);
      this.tokenRequests += 1;
      const entry = this.pending.get(p.get('code') ?? '');
      const challenge = crypto
        .createHash('sha256')
        .update(p.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !entry ||
        p.get('grant_type') !== 'authorization_code' ||
        p.get('client_id') !== this.clientId ||
        p.get('client_secret') !== this.clientSecret ||
        p.get('redirect_uri') !== entry.redirectUri ||
        challenge !== entry.challenge
      ) {
        return this.json(res, { error: 'invalid_grant' }, 400);
      }
      this.pending.delete(p.get('code') ?? '');
      const now = Math.floor(Date.now() / 1000);
      return this.json(res, {
        id_token: this.signIdToken({
          iss: this.baseUrl,
          aud: this.clientId,
          exp: now + 300,
          iat: now,
          nonce: entry.nonce,
          ...entry.user,
        }),
        access_token: 'opaque',
        token_type: 'Bearer',
      });
    }
    this.json(res, { error: 'not_found' }, 404);
  }
}

import {
  canonicalString,
  computeSignature,
  isNonceWellFormed,
  isTimestampFresh,
  parseHubHeaders,
  sha256Hex,
  signHubRequest,
  verifySignature,
} from './hub-hmac.util';
import { HubNonceCache } from './hub-nonce-cache';
import { HubRateLimiter } from './hub-rate-limiter';
import {
  decryptWithKey,
  deriveHubKey,
  encryptWithKey,
} from './hub-secrets.service';

describe('hub HMAC signing', () => {
  const secret = 'vendor-secret-0123456789abcdef';
  const body = JSON.stringify({ events: [{ event_id: 'e1' }] });

  it('round-trips a signed request through verifySignature', () => {
    const headers = signHubRequest({
      keyId: 'hk_test',
      secret,
      method: 'post',
      path: '/api/integrations/v1/events',
      body,
    });
    const canonical = canonicalString({
      method: 'POST',
      path: '/api/integrations/v1/events',
      timestamp: headers['x-hub-timestamp'],
      nonce: headers['x-hub-nonce'],
      bodySha256: sha256Hex(body),
    });
    expect(verifySignature(secret, canonical, headers['x-hub-signature'])).toBe(
      true,
    );
    expect(
      verifySignature('other', canonical, headers['x-hub-signature']),
    ).toBe(false);
    // Any change to the body, path or method breaks the signature.
    expect(
      verifySignature(
        secret,
        canonicalString({
          method: 'POST',
          path: '/api/integrations/v1/events',
          timestamp: headers['x-hub-timestamp'],
          nonce: headers['x-hub-nonce'],
          bodySha256: sha256Hex(body + ' '),
        }),
        headers['x-hub-signature'],
      ),
    ).toBe(false);
  });

  it('computeSignature is versioned and deterministic', () => {
    const sig = computeSignature(secret, 'v1\nGET\n/x\n1\nn\nh');
    expect(sig.startsWith('v1=')).toBe(true);
    expect(computeSignature(secret, 'v1\nGET\n/x\n1\nn\nh')).toBe(sig);
  });

  it('accepts timestamps inside the window only', () => {
    const now = 1_800_000_000_000;
    expect(isTimestampFresh(String(1_800_000_000), now)).toBe(true);
    expect(isTimestampFresh(String(1_800_000_000 - 299), now)).toBe(true);
    expect(isTimestampFresh(String(1_800_000_000 - 301), now)).toBe(false);
    expect(isTimestampFresh('abc', now)).toBe(false);
  });

  it('parses headers case-insensitively and rejects partial sets', () => {
    expect(
      parseHubHeaders({
        'x-hub-key-id': 'k',
        'x-hub-timestamp': '1',
        'x-hub-nonce': 'n',
        'x-hub-signature': 'v1=s',
      }),
    ).toEqual({ keyId: 'k', timestamp: '1', nonce: 'n', signature: 'v1=s' });
    expect(parseHubHeaders({ 'x-hub-key-id': 'k' })).toBeNull();
  });

  it('validates nonce shape', () => {
    expect(isNonceWellFormed('0123456789abcdef')).toBe(true);
    expect(isNonceWellFormed('short')).toBe(false);
    expect(isNonceWellFormed('has space in it 1234567')).toBe(false);
  });
});

describe('HubNonceCache', () => {
  it('allows a nonce once per key within the ttl', () => {
    const cache = new HubNonceCache(1000);
    expect(cache.consume('k', 'n', 0)).toBe(true);
    expect(cache.consume('k', 'n', 500)).toBe(false);
    expect(cache.consume('k2', 'n', 500)).toBe(true);
    expect(cache.consume('k', 'n', 1500)).toBe(true);
  });
});

describe('HubRateLimiter', () => {
  it('limits per key per window and reports retry-after', () => {
    const rl = new HubRateLimiter();
    for (let i = 0; i < 3; i++) {
      expect(rl.check('p1', 3, 60_000, 1000 + i).allowed).toBe(true);
    }
    const refused = rl.check('p1', 3, 60_000, 1003);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(rl.check('p2', 3, 60_000, 1003).allowed).toBe(true);
    expect(rl.rateLimitHits).toBe(1);
  });
});

describe('hub secret encryption', () => {
  it('round-trips with hex and passphrase keys and detects tampering', () => {
    const hexKey = deriveHubKey('a'.repeat(64));
    const ct = encryptWithKey(hexKey, 'the-secret');
    expect(decryptWithKey(hexKey, ct)).toBe('the-secret');
    const passKey = deriveHubKey('a long passphrase for the hub');
    expect(decryptWithKey(passKey, encryptWithKey(passKey, 'x'))).toBe('x');
    const tampered = ct.slice(0, -2) + (ct.endsWith('00') ? '11' : '00');
    expect(() => decryptWithKey(hexKey, tampered)).toThrow();
  });
});

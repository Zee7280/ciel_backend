import * as crypto from 'crypto';

/**
 * Vendor request signing (universal for every platform):
 *
 *   X-Hub-Key-Id:     credential key id
 *   X-Hub-Timestamp:  unix seconds
 *   X-Hub-Nonce:      random string, unique per request (16–64 chars)
 *   X-Hub-Signature:  v1=<hex HMAC-SHA256 over the canonical string>
 *
 *   canonical = "v1\n" + METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)
 *
 * `path` is the request path without query string (e.g. /api/integrations/v1/events). An empty
 * body hashes as sha256("").
 */
export const HUB_SIGNATURE_VERSION = 'v1';
export const HUB_TIMESTAMP_WINDOW_SECONDS = 300;

export const HUB_HEADERS = {
  keyId: 'x-hub-key-id',
  timestamp: 'x-hub-timestamp',
  nonce: 'x-hub-nonce',
  signature: 'x-hub-signature',
} as const;

export type HubSignatureHeaders = {
  keyId: string;
  timestamp: string;
  nonce: string;
  signature: string;
};

export function sha256Hex(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function canonicalString(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    HUB_SIGNATURE_VERSION,
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256,
  ].join('\n');
}

export function computeSignature(secret: string, canonical: string): string {
  const mac = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');
  return `${HUB_SIGNATURE_VERSION}=${mac}`;
}

export function verifySignature(
  secret: string,
  canonical: string,
  presented: string,
): boolean {
  const expected = Buffer.from(computeSignature(secret, canonical));
  const given = Buffer.from((presented ?? '').trim());
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

export function isTimestampFresh(
  timestamp: string,
  nowMs = Date.now(),
  windowSeconds = HUB_TIMESTAMP_WINDOW_SECONDS,
): boolean {
  if (!/^\d{9,11}$/.test(timestamp)) return false;
  const ts = Number(timestamp) * 1000;
  return Math.abs(nowMs - ts) <= windowSeconds * 1000;
}

export function isNonceWellFormed(nonce: string): boolean {
  return /^[A-Za-z0-9_\-:.]{16,64}$/.test(nonce);
}

/** Pulls the four signing headers (case-insensitive); null when any is missing. */
export function parseHubHeaders(
  headers: Record<string, string | string[] | undefined>,
): HubSignatureHeaders | null {
  const pick = (name: string): string => {
    const v = headers[name] ?? headers[name.toUpperCase()];
    return (Array.isArray(v) ? v[0] : (v ?? '')).trim();
  };
  const out = {
    keyId: pick(HUB_HEADERS.keyId),
    timestamp: pick(HUB_HEADERS.timestamp),
    nonce: pick(HUB_HEADERS.nonce),
    signature: pick(HUB_HEADERS.signature),
  };
  if (!out.keyId || !out.timestamp || !out.nonce || !out.signature) return null;
  return out;
}

/** Helper for vendor SDKs, simulators and tests: builds the headers for one request. */
export function signHubRequest(input: {
  keyId: string;
  secret: string;
  method: string;
  path: string;
  body: Buffer | string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? crypto.randomBytes(16).toString('hex');
  const canonical = canonicalString({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodySha256: sha256Hex(input.body),
  });
  return {
    [HUB_HEADERS.keyId]: input.keyId,
    [HUB_HEADERS.timestamp]: timestamp,
    [HUB_HEADERS.nonce]: nonce,
    [HUB_HEADERS.signature]: computeSignature(input.secret, canonical),
  };
}

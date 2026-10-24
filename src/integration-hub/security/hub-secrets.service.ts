import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

/** Accepts a 64-hex key or any passphrase (scrypt-derived). Exported for tests. */
export function deriveHubKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  return crypto.scryptSync(trimmed, 'ciel-hub-secrets', 32);
}

export function encryptWithKey(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('hex'),
    tag.toString('hex'),
    ct.toString('hex'),
  ].join(':');
}

export function decryptWithKey(key: Buffer, payload: string): string {
  const [version, ivHex, tagHex, ctHex] = payload.split(':');
  if (version !== VERSION || !ivHex || !tagHex || !ctHex) {
    throw new Error('Unrecognized hub secret ciphertext');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Encrypts vendor signing secrets at rest (AES-256-GCM) with HUB_SECRETS_KEY. The verifier needs
 * the plaintext secret to recompute HMACs, so a one-way hash would not do (design §2 / §12).
 * Without the key, credential issuance and vendor authentication are refused — never silently
 * weakened.
 */
@Injectable()
export class HubSecretsService {
  private readonly key: Buffer | null;

  constructor() {
    const raw = process.env.HUB_SECRETS_KEY ?? '';
    this.key = raw.trim().length >= 16 ? deriveHubKey(raw) : null;
  }

  get configured(): boolean {
    return this.key !== null;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ServiceUnavailableException(
        'HUB_SECRETS_KEY is not configured; Integration Hub credentials are unavailable',
      );
    }
    return this.key;
  }

  encrypt(plain: string): string {
    return encryptWithKey(this.requireKey(), plain);
  }

  decrypt(payload: string): string {
    return decryptWithKey(this.requireKey(), payload);
  }
}

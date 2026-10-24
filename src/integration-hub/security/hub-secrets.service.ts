import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  decryptWithKey,
  deriveAesKey,
  encryptWithKey,
} from '../../common/aes-gcm.util';

/** Accepts a 64-hex key or any passphrase (scrypt-derived). Exported for tests. */
export function deriveHubKey(raw: string): Buffer {
  return deriveAesKey(raw, 'ciel-hub-secrets');
}

export { encryptWithKey, decryptWithKey };

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

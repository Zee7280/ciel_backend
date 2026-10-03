import * as crypto from 'crypto';

/**
 * Built-in CNIC encryption secret. All existing CNIC rows were written with it, so it MUST NOT change:
 * changing this string makes every stored CNIC undecryptable. It is used when ENCRYPTION_KEY is not set
 * (the normal case today) and is always kept as a decrypt fallback, so setting ENCRYPTION_KEY later never
 * breaks old rows. NOTE: it lives in the repo, so it protects against casual reads of the DB, not against
 * someone who has both the DB and this code.
 */
export const LEGACY_DEFAULT_ENCRYPTION_SECRET =
  'default-secret-key-32-chars-long!!';

const ALGORITHM = 'aes-256-cbc';

type Candidate = { label: 'current' | 'previous' | 'legacy'; key: Buffer };

function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, 'salt', 32);
}

/** A decrypted CNIC is a digit string; wrong-key CBC output that happens to unpad is almost never digits. */
function looksLikeCnic(value: string): boolean {
  return /^\d{6,20}$/.test(value);
}

/**
 * AES-256-CBC cipher for participant CNICs that supports key rotation:
 * encrypt → current key; decrypt → current, then ENCRYPTION_KEY_PREVIOUS, then the legacy default key.
 * Setting a new ENCRYPTION_KEY is therefore safe immediately; old rows keep decrypting until re-encrypted
 * by scripts/rotate-cnic-key.ts.
 */
export class CnicCipher {
  private readonly candidates: Candidate[];

  constructor(opts: { current?: string | null; previous?: string | null } = {}) {
    const current = (opts.current || '').trim() || LEGACY_DEFAULT_ENCRYPTION_SECRET;
    const list: Candidate[] = [{ label: 'current', key: deriveKey(current) }];
    const previous = (opts.previous || '').trim();
    if (previous && previous !== current) {
      list.push({ label: 'previous', key: deriveKey(previous) });
    }
    if (current !== LEGACY_DEFAULT_ENCRYPTION_SECRET) {
      list.push({ label: 'legacy', key: deriveKey(LEGACY_DEFAULT_ENCRYPTION_SECRET) });
    }
    this.candidates = list;
  }

  /** True when a non-default ENCRYPTION_KEY is in use (i.e. rotation away from the public default is possible). */
  get usesCustomKey(): boolean {
    return this.candidates[0].key.compare(deriveKey(LEGACY_DEFAULT_ENCRYPTION_SECRET)) !== 0;
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, this.candidates[0].key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  private attempt(text: string, key: Buffer): string | null {
    try {
      const [ivHex, encryptedText] = text.split(':');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
      let out = decipher.update(encryptedText, 'hex', 'utf8');
      out += decipher.final('utf8');
      return out;
    } catch {
      return null;
    }
  }

  /** Decrypts with whichever key works; `usedCurrentKey` tells the rotation script whether the row is already migrated. */
  tryDecrypt(text: string): { value: string; usedCurrentKey: boolean } | null {
    if (!text || !text.includes(':')) return null;
    for (const c of this.candidates) {
      const out = this.attempt(text, c.key);
      if (out !== null && looksLikeCnic(out)) {
        return { value: out, usedCurrentKey: c.label === 'current' };
      }
    }
    // Lenient pass: old/test rows that are not a plain digit string. Only plausible text is accepted, so
    // wrong-key output (random bytes that happen to unpad) is never returned as if it were a CNIC.
    for (const c of this.candidates) {
      const out = this.attempt(text, c.key);
      if (out !== null && /^[\x20-\x7E]{1,64}$/.test(out)) {
        return { value: out, usedCurrentKey: c.label === 'current' };
      }
    }
    return null;
  }

  decrypt(text: string): string {
    const res = this.tryDecrypt(text);
    if (!res) throw new Error('Unable to decrypt CNIC with any configured key');
    return res.value;
  }

  needsRotation(text: string): boolean {
    const res = this.tryDecrypt(text);
    return !!res && !res.usedCurrentKey;
  }
}

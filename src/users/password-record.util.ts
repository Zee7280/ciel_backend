import * as crypto from 'crypto';
import { LEGACY_DEFAULT_ENCRYPTION_SECRET } from '../common/cnic-cipher';

const ALGORITHM = 'aes-256-cbc';

function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, 'salt', 32);
}

function candidateKeys(): Buffer[] {
  const current =
    (process.env.ENCRYPTION_KEY || '').trim() || LEGACY_DEFAULT_ENCRYPTION_SECRET;
  const keys = [deriveKey(current)];
  const previous = (process.env.ENCRYPTION_KEY_PREVIOUS || '').trim();
  if (previous && previous !== current) keys.push(deriveKey(previous));
  if (current !== LEGACY_DEFAULT_ENCRYPTION_SECRET) {
    keys.push(deriveKey(LEGACY_DEFAULT_ENCRYPTION_SECRET));
  }
  return keys;
}

/** Admin-only recoverable password copy (encrypted at rest; not returned unless Super Admin reveals). */
export function encryptPasswordRecord(plainPassword: string): string {
  const text = String(plainPassword || '').trim();
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, candidateKeys()[0], iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

export function decryptPasswordRecord(
  stored: string | null | undefined,
): string | null {
  const value = String(stored || '').trim();
  if (!value || !value.includes(':')) return null;
  const [ivHex, encryptedText] = value.split(':');
  if (!ivHex || !encryptedText) return null;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    if (iv.length !== 16) return null;
    for (const key of candidateKeys()) {
      try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        if (decrypted) return decrypted;
      } catch {
        /* try next key */
      }
    }
  } catch {
    return null;
  }
  return null;
}

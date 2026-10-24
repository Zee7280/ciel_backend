import * as crypto from 'crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

/**
 * Key for AES-256-GCM at-rest encryption: a 64-hex value is used as is, anything else is a
 * passphrase stretched with scrypt under the caller's salt (so two features sharing one
 * passphrase still get different keys).
 */
export function deriveAesKey(raw: string, salt: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  return crypto.scryptSync(trimmed, salt, 32);
}

/** `v1:<iv>:<tag>:<ciphertext>` (hex); the tag makes any tampering detectable on decrypt. */
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
    throw new Error('Unrecognized ciphertext');
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

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';

function encryptionKey(): Buffer {
    const secret = process.env.ENCRYPTION_KEY || 'default-secret-key-32-chars-long!!';
    return crypto.scryptSync(secret, 'salt', 32);
}

/** Admin-only recoverable password copy (encrypted at rest; not returned in normal API responses). */
export function encryptPasswordRecord(plainPassword: string): string {
    const text = String(plainPassword || '').trim();
    if (!text) return '';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

export function decryptPasswordRecord(stored: string | null | undefined): string | null {
    const value = String(stored || '').trim();
    if (!value || !value.includes(':')) return null;
    try {
        const [ivHex, encryptedText] = value.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted || null;
    } catch {
        return null;
    }
}

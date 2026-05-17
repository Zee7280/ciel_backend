import { decryptPasswordRecord, encryptPasswordRecord } from './password-record.util';

describe('password-record.util', () => {
    it('encrypts and decrypts a password record', () => {
        const stored = encryptPasswordRecord('MySecretPass123');
        expect(stored).toContain(':');
        expect(decryptPasswordRecord(stored)).toBe('MySecretPass123');
    });

    it('returns null for empty or invalid stored values', () => {
        expect(decryptPasswordRecord(null)).toBeNull();
        expect(decryptPasswordRecord('')).toBeNull();
        expect(decryptPasswordRecord('not-encrypted')).toBeNull();
    });
});

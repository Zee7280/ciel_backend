import { CnicCipher, LEGACY_DEFAULT_ENCRYPTION_SECRET } from './cnic-cipher';

describe('CnicCipher', () => {
  const cnic = '3520112345671';

  it('round-trips with the default key when no ENCRYPTION_KEY is set', () => {
    const c = new CnicCipher();
    expect(c.usesCustomKey).toBe(false);
    expect(c.decrypt(c.encrypt(cnic))).toBe(cnic);
  });

  it('after setting a new key, legacy rows still decrypt and are flagged for rotation', () => {
    const legacyRow = new CnicCipher({ current: LEGACY_DEFAULT_ENCRYPTION_SECRET }).encrypt(cnic);
    const rotated = new CnicCipher({ current: 'brand-new-secret-key-value-123456' });
    expect(rotated.usesCustomKey).toBe(true);
    expect(rotated.decrypt(legacyRow)).toBe(cnic);
    expect(rotated.needsRotation(legacyRow)).toBe(true);
    const fresh = rotated.encrypt(cnic);
    expect(rotated.decrypt(fresh)).toBe(cnic);
    expect(rotated.needsRotation(fresh)).toBe(false);
  });

  it('new rows are NOT readable with only the legacy key (the public default no longer protects them)', () => {
    const fresh = new CnicCipher({ current: 'brand-new-secret-key-value-123456' }).encrypt(cnic);
    expect(new CnicCipher().tryDecrypt(fresh)).toBeNull();
  });

  it('supports a previous key during a second rotation', () => {
    const oldRow = new CnicCipher({ current: 'key-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).encrypt(cnic);
    const c = new CnicCipher({ current: 'key-two-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', previous: 'key-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(c.decrypt(oldRow)).toBe(cnic);
    expect(c.needsRotation(oldRow)).toBe(true);
  });

  it('never returns wrong-key garbage for many random rows and returns null for non-ciphertext', () => {
    const a = new CnicCipher({ current: 'key-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const b = new CnicCipher({ current: 'key-two-bbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    for (let i = 0; i < 2000; i++) {
      const row = a.encrypt(String(1000000000000 + i));
      expect(b.tryDecrypt(row)).toBeNull();
    }
    expect(a.tryDecrypt('plain-text')).toBeNull();
    // non-digit but plausible legacy text still decrypts (old behaviour preserved)
    expect(a.decrypt(a.encrypt('PASSPORT-AB12'))).toBe('PASSPORT-AB12');
    expect(a.tryDecrypt('')).toBeNull();
  });

  it('built-in key is pinned: a row written by the original code (default secret, scrypt salt, aes-256-cbc) still decrypts', () => {
    // Generated once with the pre-CnicCipher algorithm. If this fails, someone changed the built-in secret or
    // the derivation, which would make every stored CNIC unreadable — revert the change instead.
    const historicalRow = '000102030405060708090a0b0c0d0e0f:7849d6f3a12a2fdb45242b0dd1964288';
    expect(new CnicCipher().decrypt(historicalRow)).toBe('3520112345671');
    expect(new CnicCipher({ current: 'some-new-secret-key-value-123456' }).decrypt(historicalRow)).toBe('3520112345671');
  });
});

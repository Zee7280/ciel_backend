import {
  canonicalizePhoneInput,
  isValidPakistanMobileE164,
  normalizeE164Phone,
  validatePhoneE164,
  validateVerificationPhone,
} from './phone-e164.util';

describe('phone-e164.util', () => {
  it('normalizes PK national, trunk 0, and E.164 to +923001234567', () => {
    expect(normalizeE164Phone('3001234567')).toBe('+923001234567');
    expect(normalizeE164Phone('03001234567')).toBe('+923001234567');
    expect(normalizeE164Phone('+923001234567')).toBe('+923001234567');
    expect(normalizeE164Phone('923001234567')).toBe('+923001234567');
    expect(normalizeE164Phone('+14155552671')).toBe('+14155552671');
  });

  it('accepts a valid PK mobile and rejects short / landline-like numbers', () => {
    expect(isValidPakistanMobileE164('+923001234567')).toBe(true);
    expect(validateVerificationPhone('+923001234567')).toBeNull();
    expect(validateVerificationPhone('03001234567')).toBeNull();
    expect(validateVerificationPhone('')).toMatch(/must provide/);
    expect(validateVerificationPhone('2001234567')).toMatch(/10 digits starting with 3/);
    expect(validateVerificationPhone('30012')).toMatch(/10 digits starting with 3/);
  });

  it('treats empty as valid when optional and rejects incomplete PK mobiles', () => {
    expect(validatePhoneE164('', { required: false })).toBeNull();
    expect(validatePhoneE164('', { required: true })).toMatch(/Enter a mobile/);
    expect(canonicalizePhoneInput('03001234567').e164).toBe('+923001234567');
    expect(canonicalizePhoneInput('2001234567').error).toMatch(/10 digits starting with 3/);
    expect(canonicalizePhoneInput('', { required: false })).toEqual({
      e164: '',
      error: null,
    });
  });
});

/** Shared E.164 helpers — keep in lockstep with FE `countryCallingCodes` phone rules. */

export function digitsOnlyPhone(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Canonical E.164, e.g. `+923001234567`.
 * Strips Pakistan trunk `0` and a pasted `92` country prefix from the national part.
 * Numbers that already include `+` keep their country code (non-PK E.164 is unchanged).
 */
export function normalizeE164Phone(raw: string, defaultDial = '+92'): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let n = digitsOnlyPhone(trimmed);
  if (!n) return '';

  if (trimmed.startsWith('+')) {
    if (n.startsWith('92')) {
      let national = n.slice(2);
      if (national.startsWith('0')) national = national.replace(/^0+/, '');
      if (national.length === 10 && national.startsWith('3')) return `+92${national}`;
    }
    return `+${n}`;
  }

  if (n.startsWith('0')) n = n.replace(/^0+/, '');
  if (n.startsWith('92') && n.length > 10) n = n.slice(2);
  const dial = digitsOnlyPhone(defaultDial) || '92';
  if (dial === '92') {
    n = n.slice(0, 10);
    return n ? `+92${n}` : '';
  }
  return n ? `+${dial}${n}` : '';
}

export function isValidPakistanMobileE164(e164: string): boolean {
  const n = digitsOnlyPhone(e164);
  if (!n.startsWith('92')) return false;
  const national = n.slice(2);
  return national.length === 10 && national.startsWith('3');
}

/** Full-submit check for any role's mobile / WhatsApp (required or optional). */
export function validatePhoneE164(
  raw: string,
  opts?: { required?: boolean; requiredMessage?: string },
): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    if (opts?.required) {
      return (
        opts.requiredMessage || 'Enter a mobile / WhatsApp number.'
      );
    }
    return null;
  }
  const e164 = normalizeE164Phone(trimmed);
  if (!e164) {
    return 'Enter a valid mobile number in international format (E.164, e.g. +923001234567).';
  }
  const n = digitsOnlyPhone(e164);
  if (n.startsWith('92')) {
    if (!isValidPakistanMobileE164(e164)) {
      return 'Pakistan mobile must be 10 digits starting with 3 (e.g. +923001234567).';
    }
    return null;
  }
  if (n.length < 8 || n.length > 15) {
    return 'Enter a valid mobile number in international format (E.164, e.g. +923001234567).';
  }
  return null;
}

/** Full-submit check for CIEL PK verification / private-candidate mobile. */
export function validateVerificationPhone(raw: string): string | null {
  return validatePhoneE164(raw, {
    required: true,
    requiredMessage:
      'Private candidates must provide a mobile / WhatsApp number for CIEL PK verification.',
  });
}

/** Canonical E.164, or `{ error }` when invalid. Empty optional numbers return empty `e164`. */
export function canonicalizePhoneInput(
  raw: string | null | undefined,
  opts?: { required?: boolean; requiredMessage?: string },
): { e164: string; error: null } | { e164: string; error: string } {
  const text = raw == null ? '' : String(raw);
  const error = validatePhoneE164(text, opts);
  if (error) return { e164: '', error };
  return { e164: text.trim() ? normalizeE164Phone(text) : '', error: null };
}

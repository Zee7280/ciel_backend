/** Removes e-mail addresses, CNIC-shaped numbers and Pakistani mobile numbers from free text. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CNIC_RE = /\b\d{5}-?\d{7}-?\d\b/g;
const PK_MOBILE_RE = /(?:\+92|0092|\b0)3\d{2}[-\s]?\d{7}\b/g;

export function scrubPersonalText(text: string): string {
  return text
    .replace(EMAIL_RE, '[email removed]')
    .replace(CNIC_RE, '[id removed]')
    .replace(PK_MOBILE_RE, '[phone removed]');
}

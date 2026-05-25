/**
 * Canonical certificate verification code from the report's public verify slug (DB field).
 * Format: CIL-{YY}-{4-char groups}, e.g. CIL-26-FA0D-CA28-ABDF-4C15-B008
 */
export function formatCertificateVerificationCode(
    verificationPublicSlug: string | null | undefined,
): string | null {
    const compact = String(verificationPublicSlug || '')
        .trim()
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase();
    if (compact.length < 6) return null;

    const yr = new Date().getFullYear().toString().slice(-2);
    const chunks = compact.match(/.{1,4}/g)?.slice(0, 6) ?? [];
    if (!chunks.length) return null;
    return `CIL-${yr}-${chunks.join('-')}`;
}

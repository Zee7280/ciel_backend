/**
 * Absolute (or path-only, if no frontend base URL is configured) public verification page URL
 * for a report — the single source of truth for both the QR code payload and the "download
 * certificate" link, so both features point at the one page that actually renders CII/badge/QR.
 */
export function buildImpactVerifyUrl(
    slug: string | null | undefined,
    opts: { frontendUrl?: string | null; impactVerifyPath?: string | null } = {},
): string | null {
    const s = slug?.trim();
    if (!s) return null;
    let pathSeg = (opts.impactVerifyPath || '/impact/verify').trim();
    if (!pathSeg.startsWith('/')) pathSeg = `/${pathSeg}`;
    pathSeg = pathSeg.replace(/\/+$/, '');
    const base = (opts.frontendUrl || '').trim().replace(/\/+$/, '');
    const pathAndSlug = `${pathSeg}/${encodeURIComponent(s)}`;
    return base ? `${base}${pathAndSlug}` : pathAndSlug;
}

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

/**
 * Magic-link project verification (GET/POST …/verifications/verify, faculty verify).
 *
 * - VERIFICATION_REQUIRE_AUTH=false|0|no|off → anonymous verify (legacy / migration).
 * - VERIFICATION_REQUIRE_AUTH=true|1|yes|on → JWT required + identity checks in OpportunitiesService.
 * - Unset → require auth only when NODE_ENV is production (so cielpk.com is locked down without a second env);
 *   non-production defaults to anonymous for local/dev.
 */
export function isProjectVerificationAuthRequired(): boolean {
    const raw = (process.env.VERIFICATION_REQUIRE_AUTH || '').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(raw)) {
        return false;
    }
    if (['1', 'true', 'yes', 'on'].includes(raw)) {
        return true;
    }
    return process.env.NODE_ENV === 'production';
}

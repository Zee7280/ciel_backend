/** Platform setting: when false, impact reports skip NGO/partner approval before admin final verify. */
export const REPORT_PARTNER_APPROVAL_SETTING_KEY = 'REPORT_PARTNER_APPROVAL_ENABLED';

export type ReportPartnerApprovalInput = {
    section7?: {
        has_partners?: string;
        partners?: unknown[];
    } | null;
    section8?: {
        partner_verification?: boolean;
    } | null;
    partner_status?: string | null;
    opportunity?: {
        requiresPartnerApproval?: boolean;
        partner_organization?: unknown;
    } | null;
};

export function parseReportPartnerApprovalSettingValue(
    value: string | null | undefined,
    defaultEnabled = true,
): boolean {
    if (value == null || String(value).trim() === '') return defaultEnabled;
    const normalized = String(value).trim().toLowerCase();
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    return defaultEnabled;
}

export function isReportPartnerStepSatisfied(partnerStatus: string | null | undefined): boolean {
    const ps = (partnerStatus || '').trim().toLowerCase();
    return ps === 'approved' || ps === 'not_applicable' || ps === 'not_required';
}

/**
 * Report approval is CIEL PK Admin only. Opportunity / attendance partner flows are unchanged.
 * Kept as a function so existing callers and the settings registry stay compiling.
 */
export function evaluateReportRequiresPartnerApproval(
    _report: ReportPartnerApprovalInput,
    _partnerApprovalGloballyEnabled: boolean,
    _hasMeaningfulObjectValue: (value: unknown) => boolean,
): boolean {
    return false;
}

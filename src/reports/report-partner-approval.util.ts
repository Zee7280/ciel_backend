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
 * Whether this report row needs partner/NGO sign-off before CIEL admin can mark it verified.
 * When `partnerApprovalGloballyEnabled` is false (DB setting), always returns false.
 */
export function evaluateReportRequiresPartnerApproval(
    report: ReportPartnerApprovalInput,
    partnerApprovalGloballyEnabled: boolean,
    hasMeaningfulObjectValue: (value: unknown) => boolean,
): boolean {
    if (!partnerApprovalGloballyEnabled) return false;

    const partners = Array.isArray(report.section7?.partners) ? report.section7.partners : [];
    const hasSectionPartner =
        report.section7?.has_partners === 'yes' ||
        report.section8?.partner_verification === true ||
        partners.some((partner) => hasMeaningfulObjectValue(partner));
    const hasNgo = partners.some((partner) => {
        if (!partner || typeof partner !== 'object') return false;
        const row = partner as Record<string, unknown>;
        const type = String(row.type || row.name || '').toLowerCase();
        return type.includes('ngo') || type.includes('non-government');
    });

    return Boolean(
        report.opportunity?.requiresPartnerApproval ||
        hasSectionPartner ||
        hasNgo ||
        report.partner_status === 'approved',
    );
}

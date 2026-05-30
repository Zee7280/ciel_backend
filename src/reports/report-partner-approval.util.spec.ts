import {
    evaluateReportRequiresPartnerApproval,
    isReportPartnerStepSatisfied,
    parseReportPartnerApprovalSettingValue,
} from './report-partner-approval.util';

describe('report-partner-approval.util', () => {
    const hasValue = (value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        return Object.keys(value as object).length > 0;
    };

    it('parseReportPartnerApprovalSettingValue defaults to enabled', () => {
        expect(parseReportPartnerApprovalSettingValue(undefined)).toBe(true);
        expect(parseReportPartnerApprovalSettingValue('')).toBe(true);
        expect(parseReportPartnerApprovalSettingValue('false')).toBe(false);
        expect(parseReportPartnerApprovalSettingValue('true')).toBe(true);
    });

    it('evaluateReportRequiresPartnerApproval returns false when globally disabled', () => {
        expect(
            evaluateReportRequiresPartnerApproval(
                {
                    opportunity: { requiresPartnerApproval: true },
                    section7: { has_partners: 'yes' },
                },
                false,
                hasValue,
            ),
        ).toBe(false);
    });

    it('evaluateReportRequiresPartnerApproval respects opportunity flag when enabled', () => {
        expect(
            evaluateReportRequiresPartnerApproval(
                { opportunity: { requiresPartnerApproval: true } },
                true,
                hasValue,
            ),
        ).toBe(true);
    });

    it('isReportPartnerStepSatisfied treats not_applicable as satisfied', () => {
        expect(isReportPartnerStepSatisfied('not_applicable')).toBe(true);
        expect(isReportPartnerStepSatisfied('pending')).toBe(false);
    });
});

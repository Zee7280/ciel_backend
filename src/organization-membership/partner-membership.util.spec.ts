import {
    parsePartnerMembershipRequiredSettingValue,
} from './partner-membership.util';

describe('parsePartnerMembershipRequiredSettingValue', () => {
    it('defaults to false when unset', () => {
        expect(parsePartnerMembershipRequiredSettingValue(undefined)).toBe(false);
        expect(parsePartnerMembershipRequiredSettingValue('')).toBe(false);
    });

    it('parses enabled values', () => {
        expect(parsePartnerMembershipRequiredSettingValue('true')).toBe(true);
        expect(parsePartnerMembershipRequiredSettingValue('1')).toBe(true);
        expect(parsePartnerMembershipRequiredSettingValue('enabled')).toBe(true);
    });

    it('parses disabled values', () => {
        expect(parsePartnerMembershipRequiredSettingValue('false')).toBe(false);
        expect(parsePartnerMembershipRequiredSettingValue('0')).toBe(false);
        expect(parsePartnerMembershipRequiredSettingValue('off')).toBe(false);
    });
});

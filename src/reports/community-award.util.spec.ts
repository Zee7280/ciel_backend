import { scoreCommunityAward } from './community-award.util';

describe('community-award.util', () => {
    it('scores CII as 40% of the 100-point index and caps each band', () => {
        const high = scoreCommunityAward({
            cii: 90,
            hours: 50,
            sessions: 10,
            evidenceCount: 6,
            hasBaseline: true,
            hasEndline: true,
            hasMeasuredChange: true,
            continuation: 'yes',
            partnerCount: 1,
        });
        expect(high.pts[0]).toBe(36);
        expect(high.total).toBeGreaterThanOrEqual(85);

        const thin = scoreCommunityAward({
            cii: 0,
            hours: 0,
            sessions: 0,
            evidenceCount: 0,
            hasBaseline: false,
            hasEndline: false,
            hasMeasuredChange: false,
            continuation: '',
            partnerCount: 0,
        });
        expect(thin.total).toBeLessThan(15);
    });
});

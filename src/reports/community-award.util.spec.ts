import { communityServiceLevel, isCommunityAwardLiveReport, isCommunityAwardMedalReport, scoreCommunityAward } from './community-award.util';

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

describe('isCommunityAwardLiveReport', () => {
    it('keeps faculty-approved and verified reports on the live deck', () => {
        expect(isCommunityAwardLiveReport({ faculty_status: 'approved', status: 'submitted', hours: 0 })).toBe(true);
        expect(isCommunityAwardLiveReport({ faculty_status: 'pending', status: 'verified', hours: 0 })).toBe(true);
    });

    it('keeps submitted reports in the waiting inbox even when hours are already logged', () => {
        expect(isCommunityAwardLiveReport({ faculty_status: 'pending', status: 'submitted', hours: 16 })).toBe(false);
        expect(isCommunityAwardLiveReport({ faculty_status: 'pending', status: 'submitted', hours: 0 })).toBe(false);
        expect(isCommunityAwardLiveReport({ faculty_status: 'pending', status: 'paid', hours: 16 })).toBe(false);
    });

    it('excludes drafts and rejections', () => {
        expect(isCommunityAwardLiveReport({ faculty_status: 'pending', status: 'draft', hours: 20 })).toBe(false);
        expect(isCommunityAwardLiveReport({ faculty_status: 'rejected', status: 'submitted', hours: 20 })).toBe(false);
    });
});

describe('isCommunityAwardMedalReport', () => {
    it('requires faculty and admin sign-off for the award vault', () => {
        expect(
            isCommunityAwardMedalReport({
                faculty_status: 'approved',
                admin_status: 'approved',
                status: 'submitted',
            }),
        ).toBe(true);
        expect(
            isCommunityAwardMedalReport({
                faculty_status: 'approved',
                admin_status: 'pending',
                status: 'submitted',
            }),
        ).toBe(false);
        expect(
            isCommunityAwardMedalReport({
                faculty_status: 'pending',
                admin_status: 'approved',
                status: 'verified',
            }),
        ).toBe(false);
        expect(
            isCommunityAwardMedalReport({
                faculty_status: 'approved',
                admin_status: 'pending',
                status: 'verified',
            }),
        ).toBe(true);
    });
});

describe('communityServiceLevel', () => {
    it('bands the 4 tiers at the 85/70/50 thresholds, inclusive lower bound', () => {
        expect(communityServiceLevel(100)).toBe('Transformative');
        expect(communityServiceLevel(85)).toBe('Transformative');
        expect(communityServiceLevel(84)).toBe('Distinguished');
        expect(communityServiceLevel(70)).toBe('Distinguished');
        expect(communityServiceLevel(69)).toBe('Strong');
        expect(communityServiceLevel(50)).toBe('Strong');
        expect(communityServiceLevel(49)).toBe('Developing');
        expect(communityServiceLevel(0)).toBe('Developing');
    });
});

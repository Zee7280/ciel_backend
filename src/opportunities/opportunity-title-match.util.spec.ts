import {
    normalizeOpportunityTitleForMatch,
    opportunityMatchesUniversity,
    opportunityTitlesAreSimilar,
} from './opportunity-title-match.util';

describe('opportunity-title-match.util', () => {
    it('normalizes SDG prefix and punctuation', () => {
        expect(normalizeOpportunityTitleForMatch('(SDG - 11) Sustainable cities')).toBe(
            'sustainable cities',
        );
    });

    it('detects exact and near-duplicate titles', () => {
        expect(
            opportunityTitlesAreSimilar(
                'AI & Digital Learning Era: Transforming Education',
                'AI Digital Learning Era Transforming Education for Youth',
            ),
        ).toBe(true);
    });

    it('does not match unrelated short titles', () => {
        expect(opportunityTitlesAreSimilar('Library Help', 'Tree Planting')).toBe(false);
    });

    it('matches university on participation scope', () => {
        expect(
            opportunityMatchesUniversity(
                {
                    participation_scope: { creator_university_name: 'Beaconhouse National University (BNU)' },
                },
                'beaconhouse national university (bnu)',
            ),
        ).toBe(true);
    });
});

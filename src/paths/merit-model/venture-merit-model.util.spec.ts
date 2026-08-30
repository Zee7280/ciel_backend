import { VentureEntry } from '../entities/venture-entry.entity';
import { computeVentureMeritCard, byVentureMerit, scoreVenture } from './venture-merit-model.util';

function fixture(overrides: Partial<VentureEntry>): VentureEntry {
    const base: VentureEntry = {
        id: 'venture-1',
        userId: 'user-1',
        ventureName: 'Test Venture',
        description: null as any,
        stage: 'Idea',
        tractionRows: [],
        team: [],
        materialUrls: null as any,
        isVisible: false,
        academicSetup: null,
        documents: [],
        ideaInfo: null,
        solutionInfo: null,
        sdgMapping: null,
        evidenceInfo: null,
        reviewPipeline: null,
        publishSettings: null,
        teamConsent: [],
        sectionSummaries: null,
        stepCompleted: 8,
        status: 'submitted',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-06-10T00:00:00Z'),
    };
    return { ...base, ...overrides };
}

describe('venture-merit-model.util', () => {
    it('scores an empty venture near-zero — only the vacuous "no team to consent" governance credit applies', () => {
        const S = scoreVenture(fixture({}));
        expect(S.total).toBe(4);
        expect(S.traction.pts).toBe(0);
        expect(S.market.pts).toBe(0);
        expect(S.team.pts).toBe(0);
        expect(S.governance.pts).toBe(4);
    });

    it('awards full traction points for 6+ rows plus demand signals, capped at 25', () => {
        const S = scoreVenture(
            fixture({
                tractionRows: Array.from({ length: 6 }, (_, i) => ({ date: '2026-01-01', metric: 'customers', value: String(i) })),
                evidenceInfo: { customers: 10, revenueToDate: 500, pilotPartners: 2, testers: 4, lettersOfIntent: 1, preOrders: 3 },
            }),
        );
        expect(S.traction.pts).toBe(25);
    });

    it('scores market rigor only when marketSource is not the "educated guess" placeholder', () => {
        const guess = scoreVenture(
            fixture({ solutionInfo: { marketWho: 'Retailers', marketSize: '$1M', marketSource: 'Educated guess — needs checking' } }),
        );
        expect(guess.market.pts).toBe(10); // marketWho + marketSize, no source credit

        const sourced = scoreVenture(
            fixture({ solutionInfo: { marketWho: 'Retailers', marketSize: '$1M', marketSource: 'Industry report' } }),
        );
        expect(sourced.market.pts).toBe(15);
    });

    it('caps team points at 10 and rewards accepted invites', () => {
        const S = scoreVenture(
            fixture({
                team: [
                    { name: 'A', role: 'Founder', email: 'a@test.com', inviteStatus: 'accepted' },
                    { name: 'B', role: 'CTO', email: 'b@test.com', inviteStatus: 'accepted' },
                    { name: 'C', role: 'Ops', email: 'c@test.com', inviteStatus: 'pending' },
                    { name: 'D', role: 'Sales', email: 'd@test.com', inviteStatus: 'accepted' },
                ],
            }),
        );
        expect(S.team.pts).toBe(10); // 4+ members (8) + 3/4 accepted rounded bonus (2), capped at 10
    });

    it('scores full SDG rigor with mapped entries, 2+ verifiable indicators, and impact narrative', () => {
        const S = scoreVenture(
            fixture({
                sdgMapping: {
                    entries: [{ goalNumber: 12, targets: ['12.5'] }],
                    indicators: [
                        { indicator: 'kg diverted', forGoal: '12', target12mo: '500kg', verifiedBy: 'Partner audit' },
                        { indicator: 'repeat customers', forGoal: '12', target12mo: '30%', verifiedBy: 'Sales log' },
                    ],
                    howImpact: 'Diverts textile waste from landfill.',
                },
            }),
        );
        expect(S.sdg.pts).toBe(15);
    });

    it('rewards a full business plan document over a generic upload', () => {
        const generic = scoreVenture(fixture({ documents: [{ type: 'Pitch deck', version: 1, fileUrl: 'x', uploadedAt: '2026-01-01' }] }));
        expect(generic.evidence.pts).toBe(5);
        const plan = scoreVenture(fixture({ documents: [{ type: 'Full business plan', version: 1, fileUrl: 'x', uploadedAt: '2026-01-01' }] }));
        expect(plan.evidence.pts).toBe(10);
    });

    it('treats an empty teamConsent list as satisfied (no team to consent)', () => {
        const S = scoreVenture(fixture({ teamConsent: [], reviewPipeline: { declarationWork: true, declarationConsent: true } }));
        expect(S.governance.pts).toBe(7); // consentOk(4) + declarations(3)
    });

    it('withholds consent credit when any team member has not consented', () => {
        const S = scoreVenture(fixture({ teamConsent: [{ name: 'A', consented: true }, { name: 'B', consented: false }] }));
        expect(S.governance.pts).toBe(0);
    });

    it('computeVentureMeritCard assembles id/name/stage/grade from the scorecard total', () => {
        const card = computeVentureMeritCard(fixture({ ventureName: 'EcoPack', stage: 'Growth' }));
        expect(card.id).toBe('venture-1');
        expect(card.ventureName).toBe('EcoPack');
        expect(card.stage).toBe('Growth');
        expect(card.grade).toBeDefined();
    });

    it('byVentureMerit sorts descending by total', () => {
        const low = computeVentureMeritCard(fixture({ id: 'low' }));
        const high = computeVentureMeritCard(
            fixture({
                id: 'high',
                tractionRows: Array.from({ length: 6 }, () => ({ date: '2026-01-01', metric: 'x', value: '1' })),
            }),
        );
        expect([low, high].sort(byVentureMerit).map((c) => c.id)).toEqual(['high', 'low']);
    });
});

import { DEFAULT_FYP_MILESTONES, FypEntry } from '../entities/fyp-entry.entity';
import { computeFypMeritCard } from './fyp-merit-model.util';

function fixture(overrides: Partial<FypEntry>): FypEntry {
    const base: FypEntry = {
        id: 'fyp-1',
        userId: 'user-1',
        projectTitle: 'Test thesis',
        overview: null as any,
        milestones: DEFAULT_FYP_MILESTONES,
        deliverables: [],
        communityLinkage: null,
        supervisorApprovalStatus: 'approved',
        supervisorApprovalNote: null,
        supervisorApprovalAt: new Date('2026-06-15T00:00:00Z'),
        projectInfo: {},
        background: {},
        objectivesInfo: {},
        literature: {},
        methodology: {},
        findings: {},
        routeDetails: {},
        sdgMapping: {},
        reflectionInfo: {},
        repository: {},
        sectionSummaries: {},
        addedNote: null,
        stepCompleted: 8,
        status: 'submitted',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-06-10T00:00:00Z'),
    };
    return { ...base, ...overrides };
}

describe('fyp-merit-model.util', () => {
    it('scores a rich, measured maker-route entry as RICH & CREDIBLE with a high total', () => {
        const entry = fixture({
            deliverables: [{ version: 1, label: 'Thesis', fileUrl: 'https://files.example.com/thesis.pdf', uploadedAt: '2026-06-01T00:00:00Z' }],
            projectInfo: {
                school: 'SVAD — Textile',
                supervisorName: 'Dr. Sara Ahmed',
                supervisorEmail: 'sara.ahmed@bnu.edu.pk',
                span: 'Semester 7',
                projectTypes: ['Degree-show collection'],
                teamMembers: [{ name: 'Sana Malik', email: 'sana.malik@bnu.edu.pk', role: 'Co-author' }],
            },
            objectivesInfo: {
                aim: 'Develop and test food-waste dyes that small dyeing units can actually afford at meaningful production scale',
                objectives: ['Can food-waste dyes match synthetic wash-fastness?', 'What do they cost per metre?'],
                scope: 'We tested cotton only, not blends; cost modelling excluded labour',
            },
            methodology: {
                approaches: ['Practice-based / studio', 'Experimental'],
                methods: ['Experiment', 'Lab testing', 'Prototyping & iteration'],
                scaleEntries: [
                    { n: '12', unit: 'trials / experiments' },
                    { n: '3', unit: 'fabric or material types' },
                ],
                periodFrom: '2026-01',
                periodTo: '2026-06',
            },
            findings: {
                findings: ['Trial 7 matched synthetic wash-fastness at ~60% of the cost', 'Water use fell by 40%'],
                evidenceStatus: 'Measured / tested result',
                metrics: [
                    { name: 'Wash-fastness grade', value: '4.5', unit: '/5 grade', status: 'Measured' },
                    { name: 'Dye-bath water saved', value: '40', unit: '%', status: 'Measured' },
                ],
                limitation: 'Tested on cotton only, one standard wash cycle — blends and industrial cycles remain untested here',
            },
            sdgMapping: {
                entries: [{ goalNumber: 12, targets: ['12.2 Sustainable use of materials'], how: 'Turns food waste into a production input' }],
            },
            reflectionInfo: {
                wrongAssumption: 'I assumed natural means weaker — trial 7 beat the synthetic control',
                whatsNext: 'Could become a venture',
                adviceForNext: 'Start your trials in month one',
            },
            routeDetails: { showMonth: '2026-06', piecesShown: 8, juryExaminer: 'Prof. R. Chaudhry (external)' },
        });

        const card = computeFypMeritCard(entry);

        expect(card.route).toBe('maker');
        expect(card.scorecard.total).toBeGreaterThanOrEqual(70);
        expect(card.qualityProfile.badge.label).toBe('RICH & CREDIBLE');
        expect(card.scorecard.honesty.flag).toContain('✅');
    });

    it('never fabricates a deduction on a thin-but-honest entry with nothing to classify', () => {
        const entry = fixture({});
        const card = computeFypMeritCard(entry);
        expect(card.scorecard.honesty.pts).toBe(2);
        expect(card.scorecard.honesty.flag).toContain('✅');
    });

    it('honestly declared "no SDG applies" scores the SDG anchor respectably without crashing', () => {
        const entry = fixture({ sdgMapping: { noSdgApplies: true } });
        const card = computeFypMeritCard(entry);
        expect(card.scorecard.sdg.pts).toBe(9);
        expect(card.scorecard.total).toBeGreaterThanOrEqual(0);
    });

    it('flags the honesty check when "measured / tested" is claimed but no MEASURED-tagged metric exists', () => {
        const entry = fixture({
            findings: {
                evidenceStatus: 'Measured / tested result',
                metrics: [{ name: 'Cost', value: '4.2', unit: 'score', status: 'Estimated' }],
            },
        });
        const card = computeFypMeritCard(entry);
        expect(card.scorecard.honesty.flag).toContain('⚠️');
        expect(card.scorecard.honesty.flag).toContain('MEASURED-tagged');
    });

    it('flags the honesty check for a maker route claiming "work itself is evidence" with no route block filled', () => {
        const entry = fixture({
            projectInfo: { projectTypes: ['Degree-show collection'] },
            findings: { evidenceStatus: 'The work itself is the evidence' },
            routeDetails: {},
        });
        const card = computeFypMeritCard(entry);
        expect(card.route).toBe('maker');
        expect(card.scorecard.honesty.flag).toContain('⚠️');
        expect(card.scorecard.honesty.flag).toContain('documentation/degree-show details');
    });
});

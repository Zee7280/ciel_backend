import { CourseProjectEntry } from '../entities/course-project-entry.entity';
import { computeMeritCard, extractMeritInputs, scorecard } from './merit-model.util';

function fixture(overrides: Partial<CourseProjectEntry>): CourseProjectEntry {
    const base: CourseProjectEntry = {
        id: 'entry-1',
        userId: 'user-1',
        course: null as any,
        projectTitle: 'Test project',
        projectDescription: null as any,
        sdgs: null as any,
        evidenceUrls: [],
        evidenceTypes: null as any,
        assignmentFileUrl: null as any,
        facultyApprovalStatus: 'approved',
        facultyApprovalNote: null,
        facultyApprovalAt: new Date('2026-01-15T00:00:00Z'),
        studentInfo: { disciplineName: 'Health Sciences', teamMode: 'Individual', semester: '5' },
        assignmentInfo: { formats: ['Report'] },
        aimsInfo: {},
        processInfo: {},
        resultsInfo: {},
        sdgMapping: {},
        reflectionInfo: {},
        moduleInclusion: {},
        sectionSummaries: {},
        addedNote: null as any,
        stepCompleted: 8,
        status: 'submitted',
        verificationPublicSlug: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-10T00:00:00Z'),
        assignVerificationPublicSlugIfNeeded: () => {},
    };
    return { ...base, ...overrides } as CourseProjectEntry;
}

describe('merit-model.util', () => {
    it('scores a rich, measured, well-evidenced entry as EXEMPLARY/STRONG with a rich & credible profile', () => {
        const entry = fixture({
            assignmentFileUrl: 'https://files.example.com/report.pdf',
            evidenceUrls: ['https://files.example.com/evidence.pdf'],
            aimsInfo: {
                aimStatement:
                    'This project aims to reduce single-use plastic waste across campus cafeterias by piloting a refill-station program and measuring its uptake over one semester.',
                objectives: ['Map plastic waste sources', 'Pilot refill stations', 'Measure uptake'],
            },
            assignmentInfo: { formats: ['Report'], realWorldIssue: 'Plastic waste in campus cafeterias' },
            processInfo: { methods: ['Survey'], activities: ['Waste audit'], sampleScale: '3 cafeterias, 6 weeks' },
            resultsInfo: {
                outputs: ['A costed refill-station rollout plan'],
                findings: ['Uptake rose 40% after week 2', 'Plastic cup use fell 25%'],
                resultsSummary: 'Refill stations measurably cut single-use plastic cup usage within weeks.',
                measured: 'Yes',
                metrics: [
                    { id: 'm1', value: '25', unit: '% reduction', status: 'Actual — measured', evidenceAttached: true },
                ],
                limitationType: 'Small sample',
                limitationDetail: 'Only 3 cafeterias tracked',
                limitationInterpretation: 'Results may not generalize campus-wide without a larger rollout',
            },
            sdgMapping: {
                origin: '💡 Introduced by the student / team',
                entries: [{ goalNumber: 12, targets: ['12.5'], how: 'Directly reduces plastic waste generation', strength: 'Direct' }],
            },
            reflectionInfo: {
                integrationLevel: '🌱 Central to the work and demonstrated',
                lessonLearned:
                    'Behaviour change needs visible, convenient infrastructure, not just awareness campaigns — placement mattered more than signage.',
                adviceNextSemester: 'Track cup counts weekly from day one',
                nextSteps: 'Recommended for implementation',
                skills: ['Data collection', 'Stakeholder engagement', 'Report writing'],
            },
        });

        const card = computeMeritCard(entry);

        expect(card.scorecard.total).toBeGreaterThanOrEqual(70);
        expect(['EXEMPLARY', 'STRONG']).toContain(card.grade.label);
        expect(card.qualityProfile.badge.label).toBe('RICH & CREDIBLE');
        expect(card.scorecard.honesty.flag).toContain('✅');
    });

    it('never fabricates a deduction for honesty when there is nothing to classify (no metrics)', () => {
        const entry = fixture({
            resultsInfo: { measured: 'Not yet' },
            reflectionInfo: { integrationLevel: 'Partially integrated' },
        });
        const card = computeMeritCard(entry);
        // numOk should default to 1 (nothing to misclassify) — honesty floor is lim*4 + 1*4 + 3, never zeroed by numOk.
        expect(card.scorecard.honesty.pts).toBeGreaterThanOrEqual(7);
    });

    it('honestly declared "not applicable" SDG scores the sustainability anchor low without crashing', () => {
        const entry = fixture({
            sdgMapping: { notApplicable: true, origin: '📋 Built into the assignment' },
        });
        const card = computeMeritCard(entry);
        expect(card.sdg.goalNumber).toBeUndefined();
        expect(card.scorecard.sdg.pts).toBeLessThan(10);
        expect(card.scorecard.total).toBeGreaterThanOrEqual(0);
    });

    it('flags the consistency check when integration claims "central & demonstrated" but evidence is low', () => {
        const entry = fixture({
            resultsInfo: { measured: '⏳ Not yet — will be measured later' },
            sdgMapping: {
                origin: '👩‍🏫 Suggested by the instructor',
                entries: [{ goalNumber: 3, targets: [], strength: 'Direct' }],
            },
            reflectionInfo: { integrationLevel: '🌱 Central to the work and demonstrated' },
        });
        const card = computeMeritCard(entry);
        expect(card.scorecard.honesty.flag).toContain('⚠️');
        expect(card.scorecard.honesty.flag).toContain('4 points deducted');
    });

    it('a thin but honestly-evidenced entry is scored LEAN BUT CREDIBLE, not penalized to zero', () => {
        const entry = fixture({
            assignmentFileUrl: 'https://files.example.com/essay.pdf',
            aimsInfo: { aimStatement: 'Short aim.' },
            resultsInfo: {
                measured: '🌓 Partly — some evidence, not enough to confirm',
                findings: ['Some qualitative change observed'],
                metrics: [{ id: 'm1', value: '', status: '' }],
            },
            sdgMapping: {
                origin: '🔍 Emerged during the work',
                entries: [{ goalNumber: 4, targets: ['4.7'], how: 'Ties into the course topic' }],
            },
            reflectionInfo: { integrationLevel: '📊 Clearly connected, outcome not measured' },
        });
        const card = computeMeritCard(entry);
        expect(card.scorecard.total).toBeGreaterThan(0);
        expect(card.scorecard.honesty.pts).toBeGreaterThan(0);
    });

    // Regression tests for the coursework-final-form (5).html vocabulary audit — these pin down
    // real chip text (with its leading emoji, as the final-form's chips actually carry) hitting the
    // real INTEG/ORIGB/METRIC_STATUS_TO_EVS lookup tables instead of silently falling back.
    it('ORIGB/INTEG lookups hit on the final-form\'s real chip text, not the fallback values', () => {
        const entry = fixture({
            sdgMapping: {
                origin: '💡 Introduced by the student / team',
                entries: [{ goalNumber: 3, targets: ['3.4'], how: 'Explained' }],
            },
            reflectionInfo: { integrationLevel: '🌱 Central to the work and demonstrated' },
        });
        const inputs = extractMeritInputs(entry);
        expect(inputs.orig).toBe('Introduced by the student / team');
        expect(inputs.integ).toBe('Central to the work and demonstrated');
        const S = scorecard(inputs);
        // (p?6:0)+target*4+how*5+INTEG+ORIGB-2 = 6+4+5+8+4-2 = 25 — the true top score, not the
        // 6+4+5+2+1-2=16 that the old, wrong lookup keys silently produced for every real submission.
        expect(S.sdg.pts).toBe(25);
    });

    it('the metric-status "Proposed — not yet tested" maps to Conceptual recommendation, not the unmapped fallback', () => {
        const entry = fixture({
            resultsInfo: {
                metrics: [{ id: 'm1', value: '7', unit: 'score', status: 'Proposed — not yet tested' }],
            },
        });
        const inputs = extractMeritInputs(entry);
        expect(inputs.evs).toBe('Conceptual recommendation');
    });

    it('a full-sentence "measured" chip value ("✅ Yes — a result was actually measured") is recognized, not just the bare word "Yes"', () => {
        const entry = fixture({
            resultsInfo: {
                measured: '✅ Yes — a result was actually measured',
                findings: ['Something was found'],
            },
        });
        const inputs = extractMeritInputs(entry);
        expect(inputs.evs).toBe('Qualitative evidence');
    });
});

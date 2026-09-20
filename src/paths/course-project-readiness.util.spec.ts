import { computeCourseworkReadiness } from './course-project-readiness.util';

const COMPLETE = {
    studentInfo: {
        studentName: 'Ali Khan',
        universityName: 'Test University',
        teacherEmail: 'teacher@test.com',
    },
    assignmentInfo: { format: 'Report' },
    aimsInfo: { aimStatement: 'Audit rooftop solar viability.' },
    processInfo: { activities: ['Site survey'] },
    resultsInfo: { resultsSummary: 'Rooftop can host 5kW.' },
    sdgMapping: { notApplicable: true },
    reflectionInfo: { lessonLearned: 'Data collection takes longer than planned.' },
};

describe('computeCourseworkReadiness', () => {
    it('passes a fully-completed record', () => {
        expect(computeCourseworkReadiness(COMPLETE)).toEqual({ ready: true, missing: [] });
    });

    it('fails an entirely empty record and lists every missing item', () => {
        const result = computeCourseworkReadiness({
            studentInfo: null,
            assignmentInfo: null,
            aimsInfo: null,
            processInfo: null,
            resultsInfo: null,
            sdgMapping: null,
            reflectionInfo: null,
        });
        expect(result.ready).toBe(false);
        expect(result.missing.length).toBeGreaterThan(0);
    });

    it('requires a faculty connection specifically, not just other student-info fields', () => {
        const result = computeCourseworkReadiness({
            ...COMPLETE,
            studentInfo: { studentName: 'Ali Khan', universityName: 'Test University' },
        });
        expect(result.ready).toBe(false);
        expect(result.missing.some((m) => m.includes('Faculty / teacher email'))).toBe(true);
    });

    it('accepts SDG mapping via an explicit "not applicable" declaration, not just real entries', () => {
        const result = computeCourseworkReadiness({
            ...COMPLETE,
            sdgMapping: { notApplicable: false, entries: [] },
        });
        expect(result.ready).toBe(false);
        expect(result.missing.some((m) => m.includes('SDG mapping'))).toBe(true);
    });

    it('accepts a metrics-only results section without a written summary', () => {
        const result = computeCourseworkReadiness({
            ...COMPLETE,
            resultsInfo: { metrics: [{ id: 'm1', name: 'Energy saved' }] },
        });
        expect(result.ready).toBe(true);
    });
});

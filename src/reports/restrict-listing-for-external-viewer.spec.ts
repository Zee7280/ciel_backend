import { StudentReportsService } from './student-reports.service';

const restrict = (StudentReportsService as any).restrictListingForExternalViewer;

describe('restrictListingForExternalViewer', () => {
  const lockedRow = {
    id: 'r1',
    ciiV45: {
      finalCII: 70,
      sectionScores: [
        { dimension: '1', name: 'Participation & Verified Effort', maximumPoints: 10, score: 7, criterionScores: [{ anchor: 3 }] },
      ],
      adminReviewReasons: ['x'],
      extraMileUplift: { total: 1 },
      integrityPenalty: { points: 0 },
    },
    ciiV45Lock: { locked: true, hash: 'h', lockedAt: '2026-01-01T00:00:00.000Z' },
    independentAiAnalyses: [{ secret: true }],
    review_package: {
      documents: { evidence: { count: 2, files: [{ url: 'https://x/a' }] } },
    },
  };

  it('gives the curated locked subset only, never per-criterion detail or evidence links', () => {
    const out = restrict(lockedRow);
    expect(out.ciiV45.finalCII).toBe(70);
    const json = JSON.stringify(out);
    expect(json).not.toContain('criterionScores');
    expect(json).not.toContain('adminReviewReasons');
    expect(json).not.toContain('https://x/a');
    expect(out.independentAiAnalyses).toBeNull();
    expect(out.review_package.documents.evidence.count).toBe(0);
  });

  it('hides ciiV45 when unlocked — v4.5 has no pre-lock provisional release', () => {
    expect(restrict({ ...lockedRow, ciiV45Lock: null }).ciiV45).toBeNull();
    expect(restrict({ ...lockedRow, ciiV45: null, ciiV45Lock: null }).ciiV45).toBeNull();
  });

  it('reduces an unsubmitted draft to progress only', () => {
    const out = restrict({
      ...lockedRow,
      student_name: 'Z',
      story: 'private',
      is_submitted: false,
      progress_pct: 40,
    });
    expect(out.draft_locked).toBe(true);
    expect(out.progress_pct).toBe(40);
    expect(out).not.toHaveProperty('story');
    expect(out).not.toHaveProperty('ciiV45');
  });
});

describe('stripAnalysisFromListingRow (partner / NGO)', () => {
  const strip = (StudentReportsService as any).stripAnalysisFromListingRow;
  it('removes the analysis report but keeps the package documents', () => {
    const out = strip({
      id: 'r1',
      ciiV45: { finalCII: 70 },
      ciiV45Lock: { locked: true },
      independentAiAnalyses: [{}],
      review_package: {
        analysis_attached: true,
        documents: { flashcard: { title: 'Impact flashcard' }, analysis_report: { href: 'x' } },
      },
    });
    expect(out.ciiV45).toBeNull();
    expect(out.ciiV45Lock).toBeNull();
    expect(out.independentAiAnalyses).toBeNull();
    expect(out.review_package.analysis_attached).toBe(false);
    expect(out.review_package.documents.analysis_report).toBeNull();
    expect(out.review_package.documents.flashcard.title).toBe('Impact flashcard');
  });
});

describe('partner payload carries no AI / CII scalars', () => {
  const strip = (StudentReportsService as any).stripAnalysisScalarsForPartner;
  it('removes scores, AI section11 keys and analyser links', () => {
    const out = strip({
      cii_score: 80,
      total: 70,
      level: 'L3',
      section11: { cii_index: { totalScore: 80 }, summary_text: 'CII 80', ai_generated_impact_score: 80, keep: 1 },
      review_package: { ai_analyser_href: 'x', analysis_hrefs: {}, documents: { flashcard: {} } },
    });
    expect(out.cii_score).toBeNull();
    expect(out.total).toBeNull();
    expect(JSON.stringify(out.section11)).toBe('{"keep":1}');
    expect(out.review_package.ai_analyser_href).toBeUndefined();
    expect(out.review_package.documents.flashcard).toEqual({});
  });
});

describe('supersedeCiiLock', () => {
  it('resets faculty approval so a resubmitted report needs a fresh analysis', () => {
    const svc = Object.create(StudentReportsService.prototype);
    const report: any = { faculty_status: 'approved', ciiV45: { finalCII: 70 }, ciiV45Lock: { locked: true } };
    svc.supersedeCiiLock(report, 'rejected');
    expect(report.faculty_status).toBe('pending');
    expect(report.ciiV45Lock).toBeNull();
    expect(report.ciiV45.previousLocks).toHaveLength(1);
  });
});

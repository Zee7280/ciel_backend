import { StudentReportsService } from './student-reports.service';

const restrict = (StudentReportsService as any).restrictListingForExternalViewer;

describe('restrictListingForExternalViewer', () => {
  const row = {
    id: 'r1',
    ciiV2: {
      final: 70,
      sections: [{ id: 1, criteria: [{ anchor: 3 }] }],
      integrityChecks: [{ title: 'x' }],
    },
    ciiV2Lock: null,
    independentAiAnalyses: [{ secret: true }],
    review_package: {
      documents: { evidence: { count: 2, files: [{ url: 'https://x/a' }] } },
    },
  };

  it('gives provisional score only, no AI internals or evidence links', () => {
    const out = restrict(row);
    expect(out.ciiV2.final).toBe(70);
    expect(out.ciiV2.provisional).toBe(true);
    const json = JSON.stringify(out);
    expect(json).not.toContain('anchor');
    expect(json).not.toContain('integrityChecks');
    expect(json).not.toContain('https://x/a');
    expect(out.independentAiAnalyses).toBeNull();
    expect(out.review_package.documents.evidence.count).toBe(0);
  });

  it('hides ciiV2 when the analyser has not run', () => {
    expect(restrict({ ...row, ciiV2: null }).ciiV2).toBeNull();
  });

  it('reduces an unsubmitted draft to progress only', () => {
    const out = restrict({
      ...row,
      student_name: 'Z',
      story: 'private',
      is_submitted: false,
      progress_pct: 40,
    });
    expect(out.draft_locked).toBe(true);
    expect(out.progress_pct).toBe(40);
    expect(out).not.toHaveProperty('story');
    expect(out).not.toHaveProperty('ciiV2');
  });
});

describe('stripAnalysisFromListingRow (partner / NGO)', () => {
  const strip = (StudentReportsService as any).stripAnalysisFromListingRow;
  it('removes the analysis report but keeps the package documents', () => {
    const out = strip({
      id: 'r1',
      ciiV2: { final: 70 },
      ciiV2Lock: { locked: true },
      independentAiAnalyses: [{}],
      review_package: {
        analysis_attached: true,
        documents: { flashcard: { title: 'Impact flashcard' }, analysis_report: { href: 'x' } },
      },
    });
    expect(out.ciiV2).toBeNull();
    expect(out.ciiV2Lock).toBeNull();
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
    const report: any = { faculty_status: 'approved', ciiV2: { final: 70 }, ciiV2Lock: { locked: true } };
    svc.supersedeCiiLock(report, 'rejected');
    expect(report.faculty_status).toBe('pending');
    expect(report.ciiV2Lock).toBeNull();
    expect(report.ciiV2.previousLocks).toHaveLength(1);
  });
});

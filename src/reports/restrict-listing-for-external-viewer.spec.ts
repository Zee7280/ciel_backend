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

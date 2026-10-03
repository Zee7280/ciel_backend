import {
  computeReportProgress,
  isReportSubmittedStatus,
  redactDraftRowForNonAdmin,
} from './report-progress.util';

describe('report progress', () => {
  it('an empty draft is 0% and not submitted', () => {
    const p = computeReportProgress({ status: 'draft' });
    expect(p).toMatchObject({
      is_submitted: false,
      sections_complete: 0,
      sections_total: 10,
      progress_pct: 0,
    });
  });

  it('submitted reports are 100%', () => {
    expect(computeReportProgress({ status: 'submitted' }).progress_pct).toBe(100);
    expect(
      computeReportProgress({ status: 'draft', reportSubmittedAt: new Date() })
        .is_submitted,
    ).toBe(true);
  });

  it('status helper', () => {
    expect(isReportSubmittedStatus('draft')).toBe(false);
    expect(isReportSubmittedStatus('continue')).toBe(false);
    expect(isReportSubmittedStatus('')).toBe(false);
    expect(isReportSubmittedStatus('payment_pending')).toBe(true);
  });

  it('draft rows are reduced to progress-only for non-admin viewers', () => {
    const out = redactDraftRowForNonAdmin({
      id: 'r1',
      student_name: 'Z',
      project_title: 'P',
      story: 'private answer',
      ciiV2: { final: 50 },
      student_email: 'a@b.c',
      is_submitted: false,
      progress_pct: 30,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({ id: 'r1', progress_pct: 30, draft_locked: true });
    expect(out).not.toHaveProperty('story');
    expect(out).not.toHaveProperty('ciiV2');
    expect(out).not.toHaveProperty('student_email');
    const submitted = { id: 'r2', is_submitted: true, story: 's' };
    expect(redactDraftRowForNonAdmin(submitted)).toBe(submitted);
  });
});

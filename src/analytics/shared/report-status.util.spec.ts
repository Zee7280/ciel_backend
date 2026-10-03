import { isVerifiedReport } from './report-status.util';

describe('isVerifiedReport', () => {
  it('counts admin-accepted and verified reports', () => {
    expect(isVerifiedReport({ status: 'submitted', admin_status: 'approved' })).toBe(true);
    expect(isVerifiedReport({ status: 'verified', admin_status: 'approved' })).toBe(true);
    expect(isVerifiedReport({ status: 'verified' })).toBe(true);
  });
  it("does not count an unreviewed 'paid' report (fee cleared, nobody reviewed it)", () => {
    expect(isVerifiedReport({ status: 'paid', admin_status: 'pending' })).toBe(false);
    expect(isVerifiedReport({ status: 'paid' })).toBe(false);
  });
  it('does not count drafts / pending / rejected', () => {
    for (const status of ['draft', 'submitted', 'revision', 'rejected']) {
      expect(isVerifiedReport({ status, admin_status: 'pending' })).toBe(false);
    }
  });
});

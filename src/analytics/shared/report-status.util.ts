/**
 * Shared report-status predicates so every analytics number (KPI, donut, section summary,
 * reported hours / reach, de-duplication) agrees on what "verified" and "submitted" mean.
 */

type StatusLike = { status?: string | null; admin_status?: string | null };

/** Not yet submitted (or terminally rejected): excluded from reported hours / reach. */
const NOT_SUBMITTED_STATUSES = ['draft', 'continue'];

/** Verified = CIEL PK Admin accepted the report, or it reached 'verified'. A bare 'paid' only means
 * the reporting fee cleared — it has not been reviewed — so it does not count. A 'closed' report
 * was retracted after publication and must stop counting even though admin_status still says
 * 'approved' from before the retraction. */
export function isVerifiedReport(report: StatusLike): boolean {
  const status = String(report.status || '').toLowerCase();
  if (status === 'closed') return false;
  return report.admin_status === 'approved' || status === 'verified';
}

/** Submitted or later and not rejected/closed — the only reports that count toward hours / reach. */
export function isSubmittedAndLiveReport(report: StatusLike): boolean {
  const status = String(report.status || 'draft').toLowerCase();
  if (NOT_SUBMITTED_STATUSES.includes(status)) return false;
  if (status === 'closed') return false;
  if (status.includes('reject') || report.admin_status === 'rejected') {
    return false;
  }
  return true;
}

/** Higher = further along; used to keep the most advanced report per student+project. */
export function reportStatusRank(status?: string | null): number {
  switch (String(status || '').toLowerCase()) {
    case 'paid':
      return 6;
    case 'verified':
      return 5;
    case 'payment_under_review':
    case 'payment_pending':
      return 4;
    case 'partner_verified':
      return 3;
    case 'submitted':
    case 'under_review':
      return 2;
    case 'rejected':
      return 1;
    case 'closed':
      return 0; // retracted after publish — don't let it outrank a live resubmission
    default:
      return 0; // draft / continue / unknown
  }
}

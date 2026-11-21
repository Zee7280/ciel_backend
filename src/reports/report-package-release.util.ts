/**
 * One rule for every stakeholder: nobody opens the Impact Package (flashcard, detailed report,
 * evidence) before CIEL PK Admin accepts the report. Until then faculty, university, partner and
 * NGO see the report's status only; the student sees their own draft as usual.
 */
export const REPORT_PACKAGE_LOCKED_MESSAGE =
  'This report opens after CIEL PK Admin has accepted it. Until then stakeholders see its status only.';

function lower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const RELEASED_ADMIN_STATUSES = new Set(['approved', 'verified']);

export function isReportPackageReleased(
  report: { admin_status?: unknown; status?: unknown } | null | undefined,
): boolean {
  if (!report) return false;
  const admin = lower(report.admin_status);
  if (RELEASED_ADMIN_STATUSES.has(admin)) return true;
  // Admin approval also moves the report itself to "verified" (CII lock path).
  return lower(report.status) === 'verified';
}

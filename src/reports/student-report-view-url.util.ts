/** Student report page deep-links used by listing actions (certificate / print dossier / Impact Package). */

export type StudentReportPageView =
  | 'certificate'
  | 'print'
  | 'report'
  | 'v17'
  | 'evidence'
  | 'flash'
  | 'package'
  | 'analysis';

/** `v17` is a legacy inbound alias for the detailed report. New URLs always emit `report`. */
const CANONICAL_VIEW: Record<StudentReportPageView, Exclude<StudentReportPageView, 'v17'>> =
  {
    certificate: 'certificate',
    print: 'print',
    report: 'report',
    v17: 'report',
    evidence: 'evidence',
    flash: 'flash',
    package: 'package',
    analysis: 'analysis',
  };

export function buildStudentReportPagePath(
  projectId: string,
  view: StudentReportPageView,
): string {
  return `/dashboard/student/report?projectId=${encodeURIComponent(projectId)}&view=${CANONICAL_VIEW[view]}`;
}

export function buildStudentReportPageUrl(
  projectId: string | null | undefined,
  view: StudentReportPageView,
  frontendBase?: string | null,
): string | null {
  const id = (projectId || '').trim();
  if (!id) return null;
  const path = buildStudentReportPagePath(id, view);
  const base = (frontendBase || '').trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

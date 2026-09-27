/** Student report page deep-links used by listing actions (certificate / print dossier / V17 package). */

export type StudentReportPageView = 'certificate' | 'print' | 'v17';

export function buildStudentReportPagePath(
  projectId: string,
  view: StudentReportPageView,
): string {
  return `/dashboard/student/report?projectId=${encodeURIComponent(projectId)}&view=${view}`;
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

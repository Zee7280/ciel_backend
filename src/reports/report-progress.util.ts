import { validateReportSectionsForSubmit } from './report-submit-validation.util';

export const REPORT_PROGRESS_SECTIONS_TOTAL = 10;

export type ReportProgress = {
  is_submitted: boolean;
  sections_complete: number;
  sections_total: number;
  progress_pct: number;
};

type ProgressInput = {
  status?: string | null;
  reportSubmittedAt?: Date | string | null;
  section1?: unknown;
  section2?: unknown;
  section3?: unknown;
  section4?: unknown;
  section5?: unknown;
  section6?: unknown;
  section7?: unknown;
  section8?: unknown;
  section9?: unknown;
  section10?: unknown;
  section11?: unknown;
};

export function isReportSubmittedStatus(
  status: string | null | undefined,
  reportSubmittedAt?: unknown,
): boolean {
  if (reportSubmittedAt) return true;
  return !['draft', 'continue', ''].includes(
    String(status ?? '')
      .trim()
      .toLowerCase(),
  );
}

/**
 * Draft progress = how many of the 10 report sections already pass the same checks the submit
 * gate runs (validateReportSectionsForSubmit). Never exposes answers, only counts.
 */
export function computeReportProgress(report: ProgressInput): ReportProgress {
  const total = REPORT_PROGRESS_SECTIONS_TOTAL;
  const submitted = isReportSubmittedStatus(
    report.status,
    report.reportSubmittedAt,
  );
  if (submitted) {
    return {
      is_submitted: true,
      sections_complete: total,
      sections_total: total,
      progress_pct: 100,
    };
  }
  const asRec = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  let issues: Array<{ section: number }> = [];
  try {
    issues = validateReportSectionsForSubmit({
      section1: asRec(report.section1),
      section2: asRec(report.section2),
      section3: asRec(report.section3),
      section4: asRec(report.section4),
      section5: asRec(report.section5),
      section6: asRec(report.section6),
      section7: asRec(report.section7),
      section8: asRec(report.section8),
      section9: asRec(report.section9),
      section10: asRec(report.section10),
      section11: asRec(report.section11),
    });
  } catch {
    issues = Array.from({ length: total }, (_, i) => ({ section: i + 1 }));
  }
  const incomplete = new Set(
    issues.map((i) => i.section).filter((s) => s >= 1 && s <= total),
  );
  const complete = Math.max(0, total - incomplete.size);
  return {
    is_submitted: false,
    sections_complete: complete,
    sections_total: total,
    progress_pct: Math.round((complete / total) * 100),
  };
}

/** Fields a non-admin reviewer may see for a report that has not been submitted yet. */
const DRAFT_SAFE_KEYS = [
  'id',
  'student_name',
  'project_title',
  'project_id',
  'opportunity_id',
  'organization_name',
  'status',
  'hours',
  'updated_at',
  'last_edited_at',
  'is_submitted',
  'sections_complete',
  'sections_total',
  'progress_pct',
] as const;

export function redactDraftRowForNonAdmin<T extends Record<string, any>>(
  row: T,
): Record<string, unknown> | T {
  if (row.is_submitted !== false) return row;
  const out: Record<string, unknown> = { draft_locked: true };
  for (const key of DRAFT_SAFE_KEYS) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

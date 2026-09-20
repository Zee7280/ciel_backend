import { FypEntry } from './entities/fyp-entry.entity';

/**
 * "Ready to Submit" gate for FYP, mirroring computeCourseworkReadiness (course-project-readiness.util.ts).
 * Without this, a student could PATCH status: 'submitted' with no supervisorEmail — applyFypPatch's
 * anti-hijack rule then freezes projectInfo.supervisorEmail for the lifetime of the record once it's
 * 'submitted', so an empty value at that point becomes permanent and unfixable (invisible to every
 * supervisor, no admin remediation path). Blocking here, before the transition, is the only fix.
 */
export interface FypReadiness {
  ready: boolean;
  missing: string[];
}

function hasText(v: string | null | undefined): boolean {
  return !!(v && v.trim());
}

export function computeFypReadiness(
  entry: Pick<FypEntry, 'projectTitle' | 'projectInfo'>,
): FypReadiness {
  const missing: string[] = [];
  const title = entry.projectTitle || entry.projectInfo?.title;
  if (!hasText(title)) missing.push('Project title (Step 1)');
  if (!hasText(entry.projectInfo?.supervisorEmail)) {
    missing.push(
      'Supervisor email — connect your supervisor before submitting (Step 1)',
    );
  }
  return { ready: missing.length === 0, missing };
}

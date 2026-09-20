import { CourseProjectEntry } from './entities/course-project-entry.entity';

/**
 * "Ready to Submit" gate — the pre-submit validation the Coursework Master Fix spec requires
 * (mandatory fields + the faculty connection must exist before a record can flip to `submitted`).
 * Blocking here, not just warning, matches the spec's data-integrity intent: an incomplete record
 * must never reach a faculty's review queue only to be rejected on formalities.
 */
export interface CourseworkReadiness {
    ready: boolean;
    missing: string[];
}

function hasText(v: string | null | undefined): boolean {
    return !!(v && v.trim());
}

export function computeCourseworkReadiness(
    entry: Pick<
        CourseProjectEntry,
        'studentInfo' | 'assignmentInfo' | 'aimsInfo' | 'processInfo' | 'resultsInfo' | 'sdgMapping' | 'reflectionInfo'
    >,
): CourseworkReadiness {
    const missing: string[] = [];
    const si = entry.studentInfo;
    const ai = entry.assignmentInfo;
    const aims = entry.aimsInfo;
    const process = entry.processInfo;
    const results = entry.resultsInfo;
    const sdg = entry.sdgMapping;
    const reflection = entry.reflectionInfo;

    if (!hasText(si?.studentName)) missing.push('Your name (Step 1)');
    if (!hasText(si?.universityName)) missing.push('University (Step 1)');
    if (!hasText(si?.teacherEmail)) missing.push('Faculty / teacher email — connect your supervisor before submitting (Step 1)');

    const hasFormat = hasText(ai?.format) || !!ai?.formats?.length;
    if (!hasFormat) missing.push('Assignment format (Step 2)');

    if (!hasText(aims?.aimStatement)) missing.push('Aim statement (Step 3)');

    const hasProcessDetail = !!process?.activities?.length || !!process?.methods?.length;
    if (!hasProcessDetail) missing.push('At least one activity or method (Step 4)');

    const hasResults = hasText(results?.measured) || hasText(results?.resultsSummary) || !!results?.metrics?.length;
    if (!hasResults) missing.push('Results summary or at least one result (Step 5)');

    const hasSdg = !!sdg?.notApplicable || !!sdg?.entries?.length;
    if (!hasSdg) missing.push('SDG mapping — pick a goal or mark "not applicable" (Step 6)');

    if (!hasText(reflection?.lessonLearned)) missing.push('Reflection — what you learned (Step 7)');

    return { ready: missing.length === 0, missing };
}

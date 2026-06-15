import {
    MAX_DAILY_ATTENDANCE_HOURS,
    dailyAttendanceCapMessage,
} from '../engagement/attendance-description.constants';

/** Keep in sync with `ciel_frontend/src/app/dashboard/student/report/utils/ciiSectionWeights.ts`. */
export const CII_SECTION_MAX_BY_KEY = {
    participation: 10,
    context: 10,
    sdg: 10,
    outputs: 15,
    outcomes: 10,
    resources: 15,
    partnerships: 10,
    evidence: 10,
    learning: 5,
    sustainability: 5,
} as const;

export type CiiSectionBreakdownKey = keyof typeof CII_SECTION_MAX_BY_KEY;

export const CII_SECTION_MAX_TOTAL = Object.values(CII_SECTION_MAX_BY_KEY).reduce(
    (sum, value) => sum + value,
    0,
);

export const CII_SECTION_WEIGHTS_BY_NUMBER: Record<
    number,
    { key: CiiSectionBreakdownKey; title: string; max: number }
> = {
    1: { key: 'participation', title: 'Identity & Participation', max: 10 },
    2: { key: 'context', title: 'Project Context & Discipline', max: 10 },
    3: { key: 'sdg', title: 'SDG Strategy & Intent', max: 10 },
    4: { key: 'outputs', title: 'Activities & Output Scale', max: 15 },
    5: { key: 'outcomes', title: 'Outcomes & Measurable Change', max: 10 },
    6: { key: 'resources', title: 'Resource Mobilization', max: 15 },
    7: { key: 'partnerships', title: 'Partnerships & Collaboration', max: 10 },
    8: { key: 'evidence', title: 'Evidence & Verification', max: 10 },
    9: { key: 'learning', title: 'Personal & Academic Reflection', max: 5 },
    10: { key: 'sustainability', title: 'Sustainability & Continuation', max: 5 },
};

export function getReportScoringConfig() {
    return {
        cii_section_max_by_key: { ...CII_SECTION_MAX_BY_KEY },
        cii_section_weights_by_number: { ...CII_SECTION_WEIGHTS_BY_NUMBER },
        cii_section_max_total: CII_SECTION_MAX_TOTAL,
        max_daily_attendance_hours_per_student: MAX_DAILY_ATTENDANCE_HOURS,
        daily_attendance_cap_message: dailyAttendanceCapMessage(),
        ai_evaluator_framework_version: 'v8.1',
    };
}

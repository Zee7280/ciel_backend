/** Shared stakeholder lens for all report-section analytics (1–10). */
export type AnalyticsStakeholder =
    | 'ciel'
    | 'student'
    | 'partner'
    | 'university'
    | 'un_government';

export type AnalyticsScope = 'project' | 'aggregate';

export type AnalyticsFieldCategory = 'basic' | 'premium' | 'restricted';

export interface AnalyticsFieldDefinition {
    key: string;
    category: AnalyticsFieldCategory;
    presentation: string;
    stakeholders: AnalyticsStakeholder[];
}

export type AnalyticsFieldValues = Record<string, unknown>;

export interface AnalyticsFieldMeta {
    category: AnalyticsFieldCategory;
    presentation: string;
}

/** Additive grouping for UI bands — does not replace `fields` / `meta`. */
export type AnalyticsFieldsByCategory = Record<
    AnalyticsFieldCategory,
    AnalyticsFieldValues
>;

export type AnalyticsCategoryCounts = Record<AnalyticsFieldCategory, number>;

export interface SectionAnalyticsResponse {
    success: true;
    data: {
        section: number;
        stakeholder: AnalyticsStakeholder;
        scope: AnalyticsScope;
        project_id?: string;
        student_id?: string;
        organization_id?: string;
        fields: AnalyticsFieldValues;
        meta: Record<string, AnalyticsFieldMeta>;
        /** UI helper: same values as `fields`, split by `meta.category`. */
        fields_by_category: AnalyticsFieldsByCategory;
        category_counts: AnalyticsCategoryCounts;
    };
}

export interface SummaryAnalyticsResponse {
    success: true;
    data: {
        stakeholder: AnalyticsStakeholder;
        scope: AnalyticsScope;
        project_id?: string;
        organization_id?: string;
        sections: Array<{
            section: number;
            title: string;
            status: 'ready' | 'partial' | 'empty';
            headline: string;
            completion_percent: number;
            key_metrics: Record<string, unknown>;
        }>;
        composite: {
            sections_with_data: number;
            average_completion_percent: number;
            verified_reports: number;
            total_reports: number;
        };
    };
}

export type ReportSectionNumber = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const REPORT_SECTION_TITLES: Record<number, string> = {
    1: 'Participation & attendance',
    2: 'Project context',
    3: 'SDG alignment',
    4: 'Activities & outputs (Part A)',
    5: 'Outcomes (Part B)',
    6: 'Resources & mobilization',
    7: 'Partnerships & collaboration',
    8: 'Evidence & credibility',
    9: 'Reflection & competencies',
    10: 'Sustainability & continuation',
};

/** Display mark for stored section ids (APIs still use 1–10). */
export function analyticsSectionUiMark(section: number): string {
    if (section === 4) return '4A';
    if (section === 5) return '4B';
    if (section >= 6 && section <= 10) return String(section - 1);
    return String(section);
}

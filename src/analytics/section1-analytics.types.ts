export type Section1AnalyticsStakeholder =
    | 'ciel'
    | 'student'
    | 'partner'
    | 'university'
    | 'un_government';

export type Section1AnalyticsScope = 'project' | 'aggregate';

export type Section1AnalyticsFieldCategory = 'basic' | 'premium' | 'restricted';

export interface Section1AnalyticsFieldDefinition {
    key: string;
    category: Section1AnalyticsFieldCategory;
    presentation: string;
    /** Stakeholders allowed to receive this field (after scope/auth checks). */
    stakeholders: Section1AnalyticsStakeholder[];
}

export type Section1AnalyticsFieldValues = Record<string, unknown>;

export interface Section1AnalyticsFieldMeta {
    category: Section1AnalyticsFieldCategory;
    presentation: string;
}

export interface Section1AnalyticsResponse {
    success: true;
    data: {
        stakeholder: Section1AnalyticsStakeholder;
        scope: Section1AnalyticsScope;
        project_id?: string;
        student_id?: string;
        organization_id?: string;
        fields: Section1AnalyticsFieldValues;
        meta: Record<string, Section1AnalyticsFieldMeta>;
    };
}

export interface Section1AnalyticsRequestContext {
    stakeholder: Section1AnalyticsStakeholder;
    scope: Section1AnalyticsScope;
    requesterUserId: string;
    requesterRole: string;
    organizationId?: string | null;
    projectId?: string;
    studentId?: string;
    universityOrgId?: string;
}

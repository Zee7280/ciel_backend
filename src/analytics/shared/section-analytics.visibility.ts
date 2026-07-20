import {
    AnalyticsCategoryCounts,
    AnalyticsFieldCategory,
    AnalyticsFieldDefinition,
    AnalyticsFieldMeta,
    AnalyticsFieldsByCategory,
    AnalyticsFieldValues,
    AnalyticsStakeholder,
} from './section-analytics.types';

const EMPTY_CATEGORY_BUCKETS = (): AnalyticsFieldsByCategory => ({
    basic: {},
    premium: {},
    restricted: {},
});

const EMPTY_CATEGORY_COUNTS = (): AnalyticsCategoryCounts => ({
    basic: 0,
    premium: 0,
    restricted: 0,
});

/**
 * Groups already-filtered fields by meta.category for UI bands.
 * Additive only — callers keep returning flat `fields` + `meta` unchanged.
 */
export function groupFieldsByCategory(
    fields: AnalyticsFieldValues,
    meta: Record<string, { category?: AnalyticsFieldCategory }>,
): {
    fields_by_category: AnalyticsFieldsByCategory;
    category_counts: AnalyticsCategoryCounts;
} {
    const fields_by_category = EMPTY_CATEGORY_BUCKETS();
    const category_counts = EMPTY_CATEGORY_COUNTS();

    for (const [key, value] of Object.entries(fields)) {
        const category: AnalyticsFieldCategory =
            meta[key]?.category === 'premium' || meta[key]?.category === 'restricted'
                ? meta[key].category
                : 'basic';
        fields_by_category[category][key] = value;
        category_counts[category] += 1;
    }

    return { fields_by_category, category_counts };
}

const ALL: AnalyticsStakeholder[] = [
    'ciel',
    'student',
    'partner',
    'university',
    'un_government',
];
const NO_PARTNER: AnalyticsStakeholder[] = [
    'ciel',
    'student',
    'university',
    'un_government',
];
const INTERNAL: AnalyticsStakeholder[] = ['ciel', 'student', 'university'];
const CIEL_ONLY: AnalyticsStakeholder[] = ['ciel'];
const UNI_UN: AnalyticsStakeholder[] = ['ciel', 'university', 'un_government'];

function field(
    key: string,
    category: AnalyticsFieldDefinition['category'],
    presentation: string,
    stakeholders: AnalyticsStakeholder[] = ALL,
): AnalyticsFieldDefinition {
    return { key, category, presentation, stakeholders };
}

/** Field catalogs for sections 2–10 (computed once, filtered per stakeholder). */
export const SECTION_FIELD_DEFINITIONS: Record<number, AnalyticsFieldDefinition[]> = {
    2: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: context completion %'),
        field('reports_with_section', 'basic', 'KPI: reports with Section 2 data'),
        field('discipline_distribution', 'basic', 'Bar/donut: discipline mix'),
        field('problem_category_distribution', 'basic', 'Problem category rollup', UNI_UN),
        field('baseline_evidence_distribution', 'basic', 'Baseline evidence sources'),
        field('primary_beneficiary_distribution', 'basic', 'Beneficiary types'),
        field('context_quality_flags', 'premium', 'Missing statement / thin baseline', INTERNAL),
        field('red_flag_count', 'restricted', 'Admin quality flags', CIEL_ONLY),
    ],
    3: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: SDG section completion'),
        field('reports_with_section', 'basic', 'KPI: reports with SDG mapping'),
        field('primary_sdg_distribution', 'basic', 'Primary SDG heatmap'),
        field('secondary_sdg_count', 'basic', 'Secondary SDG volume'),
        field('validation_status_mix', 'basic', 'Validated / provisional / weak'),
        field('goal_coverage_count', 'basic', 'Distinct SDG goals covered', UNI_UN),
        field('contribution_statement_rate', 'premium', 'Intent statement completeness', INTERNAL),
        field('red_flag_count', 'restricted', 'Weak SDG mappings', CIEL_ONLY),
    ],
    4: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: activities completion'),
        field('reports_with_section', 'basic', 'KPI: reports with activities'),
        field('activity_type_distribution', 'basic', 'Activity type mix'),
        field('total_beneficiaries', 'basic', 'Sum of reported beneficiaries'),
        field('beneficiary_category_distribution', 'basic', 'Beneficiary categories'),
        field('delivery_mode_distribution', 'basic', 'In-person / hybrid / online'),
        field('avg_sessions', 'premium', 'Average sessions per project', NO_PARTNER),
        field('hours_logged_sum', 'basic', 'Self-reported activity hours'),
        field('red_flag_count', 'restricted', 'Missing beneficiary counts', CIEL_ONLY),
    ],
    5: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: outcomes completion'),
        field('reports_with_section', 'basic', 'KPI: reports with outcomes'),
        field('outcome_area_distribution', 'basic', 'Outcome area mix'),
        field('confidence_level_mix', 'basic', 'Confidence tiers'),
        field('baseline_endline_rate', 'premium', 'Reports with both baseline & endline', UNI_UN),
        field('challenges_documented_rate', 'basic', 'Challenges narrative rate', INTERNAL),
        field('red_flag_count', 'restricted', 'Low-confidence outcomes', CIEL_ONLY),
    ],
    6: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: resources completion'),
        field('reports_with_section', 'basic', 'KPI: reports with resources'),
        field('total_resource_entries', 'basic', 'Resource ledger entry count'),
        field('resource_type_mix', 'basic', 'Type mix (normalized counts)'),
        field('source_mix', 'basic', 'Who funded / provided'),
        field('verification_status_mix', 'basic', 'Verified vs self-reported'),
        field('time_only_projects', 'basic', 'Projects with no financial/material resources'),
        field('self_funded_share', 'premium', 'Student self-funding equity flag', INTERNAL),
        field('mobilized_value_estimate', 'premium', 'Parsed PKR/amount sum where numeric', UNI_UN),
        field('red_flag_count', 'restricted', 'Unverified high-value entries', CIEL_ONLY),
    ],
    7: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: partnerships completion'),
        field('reports_with_section', 'basic', 'KPI: reports with partners section'),
        field('projects_with_partners_percent', 'basic', 'Partnered vs independent'),
        field('partner_type_mix', 'basic', 'Partner sector mix'),
        field('formalization_rate', 'basic', 'MOU / letter / approval rate'),
        field('verification_level_mix', 'basic', 'Verification ladder mix'),
        field('distinct_partners_estimate', 'premium', 'Deduped partner name count', UNI_UN),
        field('sdg17_classification_spread', 'basic', 'Basic / Moderate / Strategic'),
        field('contribution_type_mix', 'premium', 'What partners contribute', ALL),
        field('red_flag_count', 'restricted', 'Self-reported-only partnerships', CIEL_ONLY),
    ],
    8: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: evidence completion'),
        field('reports_with_section', 'basic', 'KPI: reports with evidence'),
        field('evidence_backed_percent', 'basic', 'Projects with evidence types'),
        field('evidence_type_coverage', 'basic', 'Evidence type bar chart'),
        field('partner_verified_percent', 'basic', 'Externally confirmed'),
        field('avg_credibility_score', 'premium', 'Heuristic credibility 0–100', INTERNAL),
        field('ethics_completion_rate', 'basic', 'Ethics declaration completeness'),
        field('media_visibility_mix', 'basic', 'Public / limited / internal', UNI_UN),
        field('consent_risk_count', 'restricted', 'Public + incomplete consent', CIEL_ONLY),
        field('red_flag_count', 'restricted', 'Bypass / no-evidence flags', CIEL_ONLY),
    ],
    9: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: reflection completion'),
        field('reports_with_section', 'basic', 'KPI: reports with reflection'),
        field('competency_group_means', 'basic', 'Cognitive / practical / social / transformative'),
        field('academic_integration_distribution', 'basic', 'Integration ladder'),
        field('curricular_integration_percent', 'basic', 'Course-linked or higher', UNI_UN),
        field('specific_reflection_rate', 'premium', 'Non-generic narrative rate', INTERNAL),
        field('strongest_competency_distribution', 'basic', 'Top competency tags'),
        field('avg_self_rating', 'basic', 'Mean of competency scores'),
        field('red_flag_count', 'restricted', 'Straight-line / empty narrative flags', CIEL_ONLY),
    ],
    10: [
        field('project_title', 'basic', 'Scope title'),
        field('section_completion_rate', 'basic', 'KPI: sustainability completion'),
        field('reports_with_section', 'basic', 'KPI: reports with Section 10'),
        field('continuation_status_mix', 'basic', 'Yes / partially / no'),
        field('continuation_yes_rate', 'basic', 'Projects planning to continue', UNI_UN),
        field('mechanisms_distribution', 'basic', 'Continuation mechanisms'),
        field('scaling_potential_mix', 'premium', 'Scaling readiness', UNI_UN),
        field('policy_influence_rate', 'basic', 'Policy influence documented'),
        field('red_flag_count', 'restricted', 'No continuation plan flags', CIEL_ONLY),
    ],
};

export function filterFieldsForStakeholder(
    section: number,
    stakeholder: AnalyticsStakeholder,
    values: AnalyticsFieldValues,
): {
    fields: AnalyticsFieldValues;
    meta: Record<string, AnalyticsFieldMeta>;
    fields_by_category: AnalyticsFieldsByCategory;
    category_counts: AnalyticsCategoryCounts;
} {
    const defs = SECTION_FIELD_DEFINITIONS[section] ?? [];
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const fields: AnalyticsFieldValues = {};
    const meta: Record<string, AnalyticsFieldMeta> = {};

    for (const [key, value] of Object.entries(values)) {
        const def = byKey.get(key);
        if (!def || !def.stakeholders.includes(stakeholder)) continue;
        fields[key] = value;
        meta[key] = { category: def.category, presentation: def.presentation };
    }
    const grouped = groupFieldsByCategory(fields, meta);
    return { fields, meta, ...grouped };
}

export function sanitizeForStakeholder(
    stakeholder: AnalyticsStakeholder,
    values: AnalyticsFieldValues,
): AnalyticsFieldValues {
    if (stakeholder === 'ciel') return values;
    const clone = { ...values };
    if (stakeholder === 'partner' || stakeholder === 'un_government') {
        delete clone.red_flag_count;
        delete clone.consent_risk_count;
        delete clone.context_quality_flags;
    }
    if (stakeholder === 'un_government') {
        delete clone.self_funded_share;
    }
    return clone;
}

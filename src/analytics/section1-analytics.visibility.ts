import {
  Section1AnalyticsFieldDefinition,
  Section1AnalyticsFieldMeta,
  Section1AnalyticsFieldValues,
  Section1AnalyticsStakeholder,
} from './section1-analytics.types';

const ALL_STAKEHOLDERS: Section1AnalyticsStakeholder[] = [
  'ciel',
  'student',
  'partner',
  'university',
  'un_government',
];

const CIEL_ONLY: Section1AnalyticsStakeholder[] = ['ciel'];
const CIEL_STUDENT: Section1AnalyticsStakeholder[] = ['ciel', 'student'];
const CIEL_STUDENT_UNIVERSITY: Section1AnalyticsStakeholder[] = [
  'ciel',
  'student',
  'university',
];
const CIEL_UNIVERSITY: Section1AnalyticsStakeholder[] = ['ciel', 'university'];
const CIEL_UNIVERSITY_UN: Section1AnalyticsStakeholder[] = [
  'ciel',
  'university',
  'un_government',
];
const CIEL_STUDENT_UNIVERSITY_UN: Section1AnalyticsStakeholder[] = [
  'ciel',
  'student',
  'university',
  'un_government',
];

/** Field catalog aligned with CIEL.PK Section 1 analytics stakeholder matrix. */
export const SECTION1_ANALYTICS_FIELD_DEFINITIONS: Section1AnalyticsFieldDefinition[] =
  [
    {
      key: 'project_title',
      category: 'basic',
      presentation: 'Read-only project title card at top of report',
      stakeholders: ALL_STAKEHOLDERS,
    },
    {
      key: 'current_report_step',
      category: 'basic',
      presentation: 'Stepper + progress bar',
      stakeholders: ['ciel', 'student', 'university'],
    },
    {
      key: 'section_1_status',
      category: 'basic',
      presentation: 'Status chip: Completed / In Progress / Pending',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'progress_mode_status',
      category: 'basic',
      presentation: 'Header badge: “Progress Mode”',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'hours_status_in_header',
      category: 'basic',
      presentation: 'KPI card with progress bar',
      stakeholders: CIEL_STUDENT_UNIVERSITY_UN,
    },
    {
      key: 'institutional_purpose_acknowledged',
      category: 'basic',
      presentation: 'Small completion indicator',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'verified_participation_via_audit_ready_logs',
      category: 'basic',
      presentation: 'Compliance KPI card',
      stakeholders: [
        'ciel',
        'student',
        'partner',
        'university',
        'un_government',
      ],
    },
    {
      key: 'academic_linkage_to_official_student_records',
      category: 'basic',
      presentation: 'KPI card: Academic Linkage Rate',
      stakeholders: CIEL_UNIVERSITY_UN,
    },
    {
      key: 'attendance_integrity_hec_compliant_tracking',
      category: 'basic',
      presentation: 'Institutional compliance card',
      stakeholders: [
        'ciel',
        'student',
        'partner',
        'university',
        'un_government',
      ],
    },
    {
      key: 'individual_accountability_for_community_hours',
      category: 'basic',
      presentation: 'Faculty/university KPI card',
      stakeholders: CIEL_UNIVERSITY_UN,
    },
    {
      key: 'identity_verification_status',
      category: 'basic',
      presentation: 'Badge beside student name: Verified / Pending / Failed',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'personal_info_tab_completion',
      category: 'basic',
      presentation: 'Progress bar in Personal Info tab',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'full_name_completion',
      category: 'restricted',
      presentation: 'Admin/audit checklist only',
      stakeholders: CIEL_ONLY,
    },
    {
      key: 'cnic_completion',
      category: 'restricted',
      presentation: 'Restricted admin panel only',
      stakeholders: CIEL_ONLY,
    },
    {
      key: 'duplicate_cnic_check',
      category: 'restricted',
      presentation: 'Admin red-flag panel',
      stakeholders: CIEL_ONLY,
    },
    {
      key: 'mobile_contact_completion',
      category: 'restricted',
      presentation: 'Admin completion metric only',
      stakeholders: CIEL_ONLY,
    },
    {
      key: 'mobile_otp_verification_rate',
      category: 'basic',
      presentation: 'Verification KPI; numbers remain hidden',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'email_completion_rate',
      category: 'restricted',
      presentation: 'Admin/internal completion metric',
      stakeholders: CIEL_ONLY,
    },
    {
      key: 'email_otp_sent_count',
      category: 'restricted',
      presentation: 'System/admin OTP log',
      stakeholders: CIEL_ONLY,
    },
    {
      key: 'email_verification_rate',
      category: 'basic',
      presentation: 'KPI card',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'personal_identity_completion_rate',
      category: 'premium',
      presentation: 'Premium identity readiness progress bar',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'university_institution_distribution',
      category: 'basic',
      presentation: 'Bar chart or table',
      stakeholders: [
        'ciel',
        'student',
        'partner',
        'university',
        'un_government',
      ],
    },
    {
      key: 'student_id_cnic_link_completion',
      category: 'restricted',
      presentation: 'Academic audit readiness metric',
      stakeholders: CIEL_UNIVERSITY,
    },
    {
      key: 'degree_program_distribution',
      category: 'basic',
      presentation: 'Bar chart',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'year_of_study_distribution',
      category: 'basic',
      presentation: 'Bar chart / donut chart',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'academic_integration_type_distribution',
      category: 'basic',
      presentation: 'Donut / stacked bar chart',
      stakeholders: CIEL_UNIVERSITY_UN,
    },
    {
      key: 'course_linked_participation_count',
      category: 'basic',
      presentation: 'KPI card for university/HEC-style report',
      stakeholders: CIEL_UNIVERSITY_UN,
    },
    {
      key: 'academic_info_completion_rate',
      category: 'basic',
      presentation: 'Progress bar in Academic Info tab',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'verify_identity_link_record_button_status',
      category: 'restricted',
      presentation: 'Button state with missing-field message',
      stakeholders: CIEL_STUDENT,
    },
    {
      key: 'identity_academic_record_linkage_rate',
      category: 'premium',
      presentation: 'Premium compliance KPI card',
      stakeholders: CIEL_STUDENT_UNIVERSITY_UN,
    },
    {
      key: 'team_configuration_status',
      category: 'basic',
      presentation: 'Team setup badge',
      stakeholders: ['ciel', 'student', 'partner', 'university'],
    },
    {
      key: 'add_team_member_count',
      category: 'basic',
      presentation: 'Team panel activity count',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'registered_ciel_users_added_rate',
      category: 'basic',
      presentation: 'Team compliance progress bar',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'team_member_count',
      category: 'basic',
      presentation: 'Team size card',
      stakeholders: [
        'ciel',
        'student',
        'partner',
        'university',
        'un_government',
      ],
    },
    {
      key: 'team_member_university_distribution',
      category: 'basic',
      presentation: 'Small table / bar chart',
      stakeholders: [
        'ciel',
        'student',
        'partner',
        'university',
        'un_government',
      ],
    },
    {
      key: 'team_member_role_distribution',
      category: 'basic',
      presentation: 'Role chips',
      stakeholders: ['ciel', 'student', 'partner', 'university'],
    },
    {
      key: 'active_contributor_count',
      category: 'basic',
      presentation: 'Small KPI card',
      stakeholders: [
        'ciel',
        'student',
        'partner',
        'university',
        'un_government',
      ],
    },
    {
      key: 'team_member_identity_verification_rate',
      category: 'basic',
      presentation: 'Team verification progress bar',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'average_team_size',
      category: 'basic',
      presentation: 'Dashboard KPI card',
      stakeholders: CIEL_UNIVERSITY_UN,
    },
    {
      key: 'fully_verified_team_count',
      category: 'premium',
      presentation: 'Premium compliance KPI',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'team_verification_rate',
      category: 'premium',
      presentation: 'Progress ring / premium card',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'team_compliance_warning',
      category: 'restricted',
      presentation: 'Warning banner',
      stakeholders: ['ciel', 'student', 'partner', 'university'],
    },
    {
      key: 'configure_member_status',
      category: 'basic',
      presentation: 'Status chip on each team member row',
      stakeholders: CIEL_STUDENT,
    },
    {
      key: 'delete_member_action_count',
      category: 'restricted',
      presentation: 'Admin audit log',
      stakeholders: CIEL_ONLY,
    },
    {
      key: 'duplicate_team_member_check',
      category: 'restricted',
      presentation: 'Admin/faculty warning panel',
      stakeholders: ['ciel', 'university'],
    },
    {
      key: 'attendance_logging_unlock_status',
      category: 'basic',
      presentation: 'Large locked/unlocked banner',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'section_1_completion_rate',
      category: 'basic',
      presentation: 'Section progress bar',
      stakeholders: ['ciel', 'student', 'university', 'un_government'],
    },
    {
      key: 'section_1_readiness_score',
      category: 'premium',
      presentation: 'Premium scorecard with breakdown',
      stakeholders: CIEL_STUDENT_UNIVERSITY,
    },
    {
      key: 'section_1_red_flag_count',
      category: 'restricted',
      presentation: 'Restricted risk panel',
      stakeholders: ['ciel', 'student', 'university'],
    },
  ];

const FIELD_DEFINITION_BY_KEY = new Map(
  SECTION1_ANALYTICS_FIELD_DEFINITIONS.map((d) => [d.key, d]),
);

export function filterSection1AnalyticsForStakeholder(
  stakeholder: Section1AnalyticsStakeholder,
  values: Section1AnalyticsFieldValues,
): {
  fields: Section1AnalyticsFieldValues;
  meta: Record<string, Section1AnalyticsFieldMeta>;
} {
  const fields: Section1AnalyticsFieldValues = {};
  const meta: Record<string, Section1AnalyticsFieldMeta> = {};

  for (const [key, value] of Object.entries(values)) {
    const def = FIELD_DEFINITION_BY_KEY.get(key);
    if (!def || !def.stakeholders.includes(stakeholder)) {
      continue;
    }
    fields[key] = value;
    meta[key] = {
      category: def.category,
      presentation: def.presentation,
    };
  }

  return { fields, meta };
}

/** Strip restricted PII before partner / UN / government aggregate responses. */
export function sanitizeRestrictedValuesForStakeholder(
  stakeholder: Section1AnalyticsStakeholder,
  values: Section1AnalyticsFieldValues,
): Section1AnalyticsFieldValues {
  if (stakeholder === 'ciel') {
    return values;
  }

  const clone = { ...values };

  if (stakeholder === 'partner' || stakeholder === 'un_government') {
    delete clone.full_name_completion;
    delete clone.cnic_completion;
    delete clone.duplicate_cnic_check;
    delete clone.mobile_contact_completion;
    delete clone.email_completion_rate;
    delete clone.email_otp_sent_count;
    delete clone.delete_member_action_count;
    delete clone.student_id_cnic_link_completion;
    delete clone.section_1_red_flag_count;
    delete clone.verify_identity_link_record_button_status;
    delete clone.configure_member_status;
  }

  if (stakeholder === 'un_government') {
    delete clone.identity_verification_status;
    delete clone.personal_info_tab_completion;
    delete clone.personal_identity_completion_rate;
    delete clone.team_compliance_warning;
    delete clone.duplicate_team_member_check;
  }

  return clone;
}

import { Injectable } from '@nestjs/common';
import {
  SECTION1_ANALYTICS_FIELD_DEFINITIONS,
  filterSection1AnalyticsForStakeholder,
  sanitizeRestrictedValuesForStakeholder,
} from './section1-analytics.visibility';
import { Section1AnalyticsService } from './section1-analytics.service';
import { SectionReportAnalyticsService } from './section-report-analytics.service';
import {
  SECTION_FIELD_DEFINITIONS,
  filterFieldsForStakeholder,
  sanitizeForStakeholder,
} from './shared/section-analytics.visibility';
import {
  AnalyticsFieldCategory,
  AnalyticsFieldValues,
  AnalyticsStakeholder,
  REPORT_SECTION_TITLES,
} from './shared/section-analytics.types';
import {
  AllFieldsConsoleRole,
  ALL_FIELDS_CONSOLE_ROLES,
} from './dto/all-fields-console-query.dto';

const ROLE_META: Record<
  AllFieldsConsoleRole,
  { label: string; chip: string; color: string }
> = {
  student: { label: 'Student', chip: 'S', color: '#4f46e5' },
  faculty: { label: 'Faculty', chip: 'F', color: '#8b5cf6' },
  university: { label: 'University', chip: 'U', color: '#06b6d4' },
  partner: { label: 'Partner Org', chip: 'P', color: '#10b981' },
  unhec: { label: 'UN · HEC · Govt', chip: 'G', color: '#0f1222' },
};

/** Map console role → primary analytics stakeholder used for live filtering. */
export function consoleRoleToStakeholder(
  role: AllFieldsConsoleRole,
): AnalyticsStakeholder {
  switch (role) {
    case 'student':
      return 'student';
    case 'faculty':
      // Closest existing lens for cohort-style field visibility (not ciel-only).
      return 'university';
    case 'university':
      return 'university';
    case 'partner':
      return 'partner';
    case 'unhec':
      return 'un_government';
  }
}

function roleSeesField(
  role: AllFieldsConsoleRole,
  stakeholders: AnalyticsStakeholder[],
): boolean {
  if (role === 'faculty') {
    // Faculty review mirror: fields student or university can read (excludes ciel-only).
    return (
      stakeholders.includes('student') || stakeholders.includes('university')
    );
  }
  const mapped = consoleRoleToStakeholder(role);
  return stakeholders.includes(mapped);
}

type RegistryFieldRow = {
  key: string;
  presentation: string;
  category: AnalyticsFieldCategory;
  mapped_roles: AllFieldsConsoleRole[];
};

@Injectable()
export class AllFieldsConsoleService {
  constructor(
    private readonly section1AnalyticsService: Section1AnalyticsService,
    private readonly sectionReportAnalyticsService: SectionReportAnalyticsService,
  ) {}

  /** Read-only ownership registry from existing field catalogs (no DB writes). */
  getRegistry() {
    const sections: Array<{
      section: number;
      name: string;
      short_label: string;
      field_count: number;
      fields: RegistryFieldRow[];
    }> = [];
    for (let section = 1; section <= 10; section++) {
      const defs =
        section === 1
          ? SECTION1_ANALYTICS_FIELD_DEFINITIONS
          : (SECTION_FIELD_DEFINITIONS[section] ?? []);

      const fields: RegistryFieldRow[] = defs.map((d) => ({
        key: d.key,
        presentation: d.presentation,
        category: d.category,
        mapped_roles: ALL_FIELDS_CONSOLE_ROLES.filter((role) =>
          roleSeesField(role, d.stakeholders as AnalyticsStakeholder[]),
        ),
      }));

      sections.push({
        section,
        name: REPORT_SECTION_TITLES[section] ?? `Section ${section}`,
        short_label: `S${section}`,
        field_count: fields.length,
        fields,
      });
    }

    return {
      success: true as const,
      data: {
        primary_owner: 'super_admin' as const,
        editable: false,
        note: 'Primary owner is Super Admin. Role chips show mapped read access from the live field catalogs. Registry is read-only — visibility changes go through code review.',
        roles: ALL_FIELDS_CONSOLE_ROLES.map((id) => ({
          id,
          ...ROLE_META[id],
        })),
        sections,
        view_count: ALL_FIELDS_CONSOLE_ROLES.length * 10,
      },
    };
  }

  /**
   * Super-admin “View as” mirror: platform aggregate owned by ciel, then
   * filtered to the selected stakeholder lens (does not impersonate a user).
   */
  async getViewAs(
    requester: {
      id: string;
      role: string;
      organizationId?: string | null;
      orgType?: string | null;
    },
    role: AllFieldsConsoleRole,
    section: number,
  ) {
    const stakeholder = consoleRoleToStakeholder(role);
    const sectionTitle =
      REPORT_SECTION_TITLES[section] ?? `Section ${section}`;

    let analyticsPayload: {
      stakeholder: string;
      scope: string;
      fields: AnalyticsFieldValues;
      meta: Record<string, { category?: AnalyticsFieldCategory; presentation?: string }>;
      fields_by_category?: unknown;
      category_counts?: unknown;
    };

    if (section === 1) {
      const full = await this.section1AnalyticsService.getSection1Analytics(
        requester,
        { scope: 'aggregate' },
        'ciel',
      );
      const raw = full.data.fields;
      const sanitized = sanitizeRestrictedValuesForStakeholder(
        stakeholder as 'student' | 'partner' | 'university' | 'un_government' | 'ciel',
        raw,
      );
      // Faculty: start from university lens (cohort), then drop ciel-only leftovers already filtered.
      const filtered = filterSection1AnalyticsForStakeholder(
        stakeholder as 'student' | 'partner' | 'university' | 'un_government' | 'ciel',
        sanitized,
      );
      const roleFiltered = this.applyFacultyExtraFilter(
        role,
        section,
        filtered.fields,
        filtered.meta,
      );
      analyticsPayload = {
        stakeholder: role === 'faculty' ? 'faculty_mirror' : stakeholder,
        scope: 'aggregate',
        fields: roleFiltered.fields,
        meta: roleFiltered.meta,
        fields_by_category: roleFiltered.fields_by_category,
        category_counts: roleFiltered.category_counts,
      };
    } else {
      const full =
        await this.sectionReportAnalyticsService.getSectionAnalytics(
          section,
          requester,
          { scope: 'aggregate' },
          'ciel',
        );
      const sanitized = sanitizeForStakeholder(stakeholder, full.data.fields);
      const filtered = filterFieldsForStakeholder(
        section,
        stakeholder,
        sanitized,
      );
      const roleFiltered = this.applyFacultyExtraFilter(
        role,
        section,
        filtered.fields,
        filtered.meta,
      );
      analyticsPayload = {
        stakeholder: role === 'faculty' ? 'faculty_mirror' : stakeholder,
        scope: 'aggregate',
        fields: roleFiltered.fields,
        meta: roleFiltered.meta,
        fields_by_category: roleFiltered.fields_by_category,
        category_counts: roleFiltered.category_counts,
      };
    }

    const underlying_fields = Object.entries(analyticsPayload.meta).map(
      ([key, m]) => ({
        key,
        presentation: m.presentation ?? key,
        category: (m.category ?? 'basic') as AnalyticsFieldCategory,
      }),
    );

    return {
      success: true as const,
      data: {
        console_role: role,
        role_label: ROLE_META[role].label,
        role_color: ROLE_META[role].color,
        mapped_stakeholder: analyticsPayload.stakeholder,
        section,
        section_title: sectionTitle,
        primary_owner: 'super_admin' as const,
        note:
          role === 'faculty'
            ? 'Faculty mirror uses university/student field visibility on the platform aggregate — not a live faculty account session.'
            : `Read-only mirror of the ${ROLE_META[role].label} field lens on the Super Admin master ledger.`,
        analytics: analyticsPayload,
        underlying_fields,
      },
    };
  }

  /**
   * Faculty mirror: after university filter, keep only fields that student OR
   * university can see in the catalog (already true for university set mostly).
   */
  private applyFacultyExtraFilter(
    role: AllFieldsConsoleRole,
    section: number,
    fields: AnalyticsFieldValues,
    meta: Record<string, { category?: AnalyticsFieldCategory; presentation?: string }>,
  ) {
    if (role !== 'faculty') {
      return {
        fields,
        meta,
        ...this.groupMeta(fields, meta),
      };
    }

    const defs =
      section === 1
        ? SECTION1_ANALYTICS_FIELD_DEFINITIONS
        : (SECTION_FIELD_DEFINITIONS[section] ?? []);
    const allowed = new Set(
      defs
        .filter((d) =>
          roleSeesField('faculty', d.stakeholders as AnalyticsStakeholder[]),
        )
        .map((d) => d.key),
    );

    const nextFields: AnalyticsFieldValues = {};
    const nextMeta: typeof meta = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.has(key)) continue;
      nextFields[key] = value;
      if (meta[key]) nextMeta[key] = meta[key];
    }
    return {
      fields: nextFields,
      meta: nextMeta,
      ...this.groupMeta(nextFields, nextMeta),
    };
  }

  private groupMeta(
    fields: AnalyticsFieldValues,
    meta: Record<string, { category?: AnalyticsFieldCategory; presentation?: string }>,
  ) {
    const fields_by_category: Record<
      AnalyticsFieldCategory,
      AnalyticsFieldValues
    > = { basic: {}, premium: {}, restricted: {} };
    const category_counts: Record<AnalyticsFieldCategory, number> = {
      basic: 0,
      premium: 0,
      restricted: 0,
    };
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
}

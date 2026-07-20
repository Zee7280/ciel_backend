import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AnalyticsScopeService } from './shared/analytics-scope.service';
import {
  filterFieldsForStakeholder,
  sanitizeForStakeholder,
} from './shared/section-analytics.visibility';
import {
  AnalyticsFieldValues,
  AnalyticsStakeholder,
  ReportSectionNumber,
  SectionAnalyticsResponse,
  SummaryAnalyticsResponse,
  REPORT_SECTION_TITLES,
} from './shared/section-analytics.types';
import { Section1AnalyticsQueryDto } from './dto/section1-analytics-query.dto';

type DistRow = { label: string; count: number };

@Injectable()
export class SectionReportAnalyticsService {
  private readonly logger = new Logger(SectionReportAnalyticsService.name);

  constructor(private readonly scopeService: AnalyticsScopeService) {}

  async getSectionAnalytics(
    section: number,
    requester: {
      id: string;
      role: string;
      organizationId?: string | null;
      orgType?: string | null;
    },
    query: Section1AnalyticsQueryDto,
    forcedStakeholder?: AnalyticsStakeholder,
  ): Promise<SectionAnalyticsResponse> {
    this.assertValidSection(section);

    const orgType = await this.scopeService.resolveOrgType(
      requester.organizationId,
      requester.orgType,
    );
    const stakeholder =
      forcedStakeholder ??
      this.scopeService.resolveStakeholderFromRole(requester.role, orgType);

    const scope =
      query.scope === 'aggregate' ||
      (!query.project_id && stakeholder !== 'student')
        ? 'aggregate'
        : 'project';

    if (scope === 'project' && !query.project_id) {
      throw new BadRequestException(
        'project_id is required for project-scoped analytics',
      );
    }

    const studentId =
      stakeholder === 'student'
        ? requester.id
        : (query.student_id || '').trim() || undefined;

    await this.scopeService.assertAccess({
      stakeholder,
      scope,
      requesterUserId: requester.id,
      requesterRole: requester.role,
      organizationId: requester.organizationId,
      projectId: query.project_id,
      studentId,
    });

    const { reports, titles } = await this.scopeService.loadScopedReports({
      stakeholder,
      scope,
      organizationId: requester.organizationId,
      projectId: query.project_id,
      studentId,
      universityFilter: query.university,
      facultyId: requester.role === 'faculty' ? requester.id : undefined,
    });

    let raw: AnalyticsFieldValues;
    try {
      raw = this.computeSectionMetrics(
        section as ReportSectionNumber,
        reports,
        {
          stakeholder,
          scope,
          titles,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Section ${section} analytics failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      raw = {
        project_title:
          scope === 'project' ? titles[0] || 'Project' : titles.slice(0, 25),
        section_completion_rate: {
          percent: 0,
          numerator: 0,
          denominator: reports.length,
        },
        reports_with_section: 0,
        analytics_error: true,
      };
    }

    const sanitized = sanitizeForStakeholder(stakeholder, raw);
    const { fields, meta, fields_by_category, category_counts } =
      filterFieldsForStakeholder(section, stakeholder, sanitized);

    return {
      success: true,
      data: {
        section,
        stakeholder,
        scope,
        project_id: query.project_id,
        student_id: studentId,
        organization_id: requester.organizationId ?? undefined,
        fields,
        meta,
        fields_by_category,
        category_counts,
      },
    };
  }

  async getUnGovernmentSlice(
    section: number,
    slice: 'hec' | 'government' | 'un' = 'un',
  ): Promise<SectionAnalyticsResponse> {
    this.assertValidSection(section);
    const { reports, titles } = await this.scopeService.loadScopedReports({
      stakeholder: 'un_government',
      scope: 'aggregate',
    });
    const raw = this.computeSectionMetrics(
      section as ReportSectionNumber,
      reports,
      {
        stakeholder: 'un_government',
        scope: 'aggregate',
        titles,
      },
    );
    const sanitized = sanitizeForStakeholder('un_government', raw);
    const { fields, meta, fields_by_category, category_counts } =
      filterFieldsForStakeholder(section, 'un_government', sanitized);
    return {
      success: true,
      data: {
        section,
        stakeholder: 'un_government',
        scope: 'aggregate',
        fields: { slice, ...fields },
        meta,
        fields_by_category,
        category_counts,
      },
    };
  }

  async getSummary(
    requester: {
      id: string;
      role: string;
      organizationId?: string | null;
      orgType?: string | null;
    },
    query: Section1AnalyticsQueryDto,
    forcedStakeholder?: AnalyticsStakeholder,
  ): Promise<SummaryAnalyticsResponse> {
    const orgType = await this.scopeService.resolveOrgType(
      requester.organizationId,
      requester.orgType,
    );
    const stakeholder =
      forcedStakeholder ??
      this.scopeService.resolveStakeholderFromRole(requester.role, orgType);

    const scope =
      query.scope === 'aggregate' ||
      (!query.project_id && stakeholder !== 'student')
        ? 'aggregate'
        : 'project';

    const studentId =
      stakeholder === 'student'
        ? requester.id
        : (query.student_id || '').trim() || undefined;

    await this.scopeService.assertAccess({
      stakeholder,
      scope,
      requesterUserId: requester.id,
      requesterRole: requester.role,
      organizationId: requester.organizationId,
      projectId: query.project_id,
      studentId,
    });

    const { reports } = await this.scopeService.loadScopedReports({
      stakeholder,
      scope,
      organizationId: requester.organizationId,
      projectId: query.project_id,
      studentId,
      universityFilter: query.university,
      facultyId: requester.role === 'faculty' ? requester.id : undefined,
    });

    type SummarySectionRow =
      SummaryAnalyticsResponse['data']['sections'][number];
    const sections: SummarySectionRow[] = [];

    // Section 1 proxy summary from report presence
    const s1Ready = reports.filter((r) => r.section1).length;
    const s1Pct =
      reports.length === 0 ? 0 : Math.round((100 * s1Ready) / reports.length);
    sections.push({
      section: 1,
      title: REPORT_SECTION_TITLES[1],
      status: s1Ready === 0 ? 'empty' : s1Pct >= 70 ? 'ready' : 'partial',
      headline: `${s1Ready} of ${reports.length} reports have Section 1 data`,
      completion_percent: s1Pct,
      key_metrics: {
        reports_with_section: s1Ready,
        total_reports: reports.length,
      },
    });

    for (const section of [2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
      try {
        const metrics = this.computeSectionMetrics(section, reports, {
          stakeholder,
          scope,
          titles: [],
        });
        const completion =
          typeof (metrics.section_completion_rate as { percent?: number })
            ?.percent === 'number'
            ? (metrics.section_completion_rate as { percent: number }).percent
            : 0;
        const withSection =
          typeof metrics.reports_with_section === 'number'
            ? metrics.reports_with_section
            : 0;
        const status: 'ready' | 'partial' | 'empty' =
          withSection === 0 ? 'empty' : completion >= 70 ? 'ready' : 'partial';
        sections.push({
          section,
          title: REPORT_SECTION_TITLES[section] ?? `Section ${section}`,
          status,
          headline: this.headlineForSection(section, metrics),
          completion_percent: completion,
          key_metrics: this.pickSummaryKeys(section, metrics),
        });
      } catch (error) {
        this.logger.warn(
          `Section ${section} summary failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        sections.push({
          section,
          title: REPORT_SECTION_TITLES[section] ?? `Section ${section}`,
          status: 'empty',
          headline: 'Section analytics temporarily unavailable',
          completion_percent: 0,
          key_metrics: {},
        });
      }
    }

    const avg =
      sections.length === 0
        ? 0
        : Math.round(
            sections.reduce((a, s) => a + s.completion_percent, 0) /
              sections.length,
          );

    return {
      success: true,
      data: {
        stakeholder,
        scope,
        project_id: query.project_id,
        organization_id: requester.organizationId ?? undefined,
        sections,
        composite: {
          sections_with_data: sections.filter((s) => s.status !== 'empty')
            .length,
          average_completion_percent: avg,
          verified_reports: reports.filter(
            (r) =>
              r.status === 'verified' ||
              r.admin_status === 'approved' ||
              r.partner_status === 'approved',
          ).length,
          total_reports: reports.length,
        },
      },
    };
  }

  private assertValidSection(section: number): void {
    if (!Number.isInteger(section) || section < 2 || section > 10) {
      throw new BadRequestException('section must be an integer from 2 to 10');
    }
  }

  private computeSectionMetrics(
    section: ReportSectionNumber,
    reports: StudentReport[],
    ctx: {
      stakeholder: AnalyticsStakeholder;
      scope: 'project' | 'aggregate';
      titles: string[];
    },
  ): AnalyticsFieldValues {
    const projectTitle =
      ctx.stakeholder === 'un_government'
        ? {
            project_count: new Set(
              reports.map((r) => r.opportunityId || r.project_id),
            ).size,
          }
        : ctx.scope === 'project'
          ? ctx.titles[0] || 'Project'
          : ctx.titles.slice(0, 25);

    switch (section) {
      case 2:
        return this.computeSection2(reports, projectTitle);
      case 3:
        return this.computeSection3(reports, projectTitle);
      case 4:
        return this.computeSection4(reports, projectTitle);
      case 5:
        return this.computeSection5(reports, projectTitle);
      case 6:
        return this.computeSection6(reports, projectTitle);
      case 7:
        return this.computeSection7(reports, projectTitle);
      case 8:
        return this.computeSection8(reports, projectTitle);
      case 9:
        return this.computeSection9(reports, projectTitle);
      case 10:
        return this.computeSection10(reports, projectTitle);
      default:
        return { project_title: projectTitle };
    }
  }

  private computeSection2(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section2));
    const disc = this.dist(
      withSec.map(
        (r) =>
          r.section2?.discipline || r.discipline_alignment || 'Unspecified',
      ),
    );
    const cats = this.dist(
      withSec.map(
        (r) =>
          r.section2?.problem_category || r.problem_category || 'Unspecified',
      ),
    );
    const evidence = this.dist(
      withSec.map(
        (r) =>
          r.section2?.baseline_evidence ||
          r.baseline_evidence_source ||
          'Unspecified',
      ),
    );
    const beneficiaries = this.dist(
      withSec.map(
        (r) =>
          r.section2?.primary_beneficiary ||
          r.primary_beneficiary ||
          'Unspecified',
      ),
    );
    const thin = withSec.filter(
      (r) => this.asText(r.section2?.problem_statement).trim().length < 40,
    ).length;
    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      discipline_distribution: disc,
      problem_category_distribution: cats,
      baseline_evidence_distribution: evidence,
      primary_beneficiary_distribution: beneficiaries,
      context_quality_flags: {
        thin_problem_statements: thin,
        missing_baseline: withSec.filter((r) => !r.section2?.baseline_evidence)
          .length,
      },
      red_flag_count: { count: thin, action_required: thin > 0 },
    };
  }

  private computeSection3(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter(
      (r) => this.hasContent(r.section3) || r.primary_sdg_goal != null,
    );
    const primary = this.dist(
      withSec.map((r) => {
        const g = r.section3?.primary_sdg?.goal_number ?? r.primary_sdg_goal;
        return g != null ? `SDG ${g}` : 'Unspecified';
      }),
    );
    let secondary = 0;
    for (const r of withSec)
      secondary += r.section3?.secondary_sdgs?.length ?? 0;
    const validation = this.dist(
      withSec.map((r) => r.sdg_validation_status || 'pending'),
    );
    const goals = new Set(
      withSec
        .map((r) => r.section3?.primary_sdg?.goal_number ?? r.primary_sdg_goal)
        .filter((g): g is number => g != null),
    );
    const statements = withSec.filter(
      (r) =>
        this.asText(
          r.section3?.contribution_intent_statement ||
            r.contribution_intent_statement,
        ).trim().length >= 40,
    ).length;
    const weak = withSec.filter(
      (r) => r.sdg_validation_status === 'weak',
    ).length;
    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      primary_sdg_distribution: primary,
      secondary_sdg_count: secondary,
      validation_status_mix: validation,
      goal_coverage_count: goals.size,
      contribution_statement_rate: this.pctObj(statements, withSec.length || 1),
      red_flag_count: { count: weak, action_required: weak > 0 },
    };
  }

  private computeSection4(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section4));
    const types = this.dist(
      withSec.map((r) => r.section4?.activity_type || 'Unspecified'),
    );
    const modes = this.dist(
      withSec.map((r) => r.section4?.delivery_mode || 'Unspecified'),
    );
    let beneficiaries = 0;
    let hours = 0;
    let sessions = 0;
    const catMap = new Map<string, number>();
    for (const r of withSec) {
      beneficiaries +=
        this.parseNum(r.section4?.total_beneficiaries) ||
        this.parseNum(r.section4?.my_beneficiaries) ||
        0;
      hours += this.parseNum(r.section4?.my_hours) || 0;
      sessions +=
        this.parseNum(r.section4?.total_sessions) ||
        this.parseNum(r.section4?.my_sessions) ||
        0;
      for (const c of r.section4?.beneficiary_categories || []) {
        const key = this.labelKey(c);
        catMap.set(key, (catMap.get(key) || 0) + 1);
      }
    }
    const missingBen = withSec.filter(
      (r) =>
        !this.parseNum(r.section4?.total_beneficiaries) &&
        !this.parseNum(r.section4?.my_beneficiaries),
    ).length;
    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      activity_type_distribution: types,
      total_beneficiaries: Math.round(beneficiaries),
      beneficiary_category_distribution: this.toDist([...catMap.entries()]),
      delivery_mode_distribution: modes,
      avg_sessions:
        withSec.length === 0
          ? 0
          : Math.round((sessions / withSec.length) * 10) / 10,
      hours_logged_sum: Math.round(hours * 10) / 10,
      red_flag_count: { count: missingBen, action_required: missingBen > 0 },
    };
  }

  private computeSection5(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section5));
    const areas = this.dist(
      withSec.map((r) => r.section5?.outcome_area || 'Unspecified'),
    );
    const confidence = this.dist(
      withSec.map((r) => r.section5?.confidence_level || 'Unspecified'),
    );
    const both = withSec.filter(
      (r) =>
        this.asText(r.section5?.baseline).trim() &&
        this.asText(r.section5?.endline).trim(),
    ).length;
    const challenges = withSec.filter(
      (r) => this.asText(r.section5?.challenges).trim().length >= 20,
    ).length;
    const lowConf = withSec.filter((r) =>
      /low|weak|uncertain/i.test(this.asText(r.section5?.confidence_level)),
    ).length;
    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      outcome_area_distribution: areas,
      confidence_level_mix: confidence,
      baseline_endline_rate: this.pctObj(both, withSec.length || 1),
      challenges_documented_rate: this.pctObj(challenges, withSec.length || 1),
      red_flag_count: { count: lowConf, action_required: lowConf > 0 },
    };
  }

  private computeSection6(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section6));
    const timeOnly = withSec.filter(
      (r) =>
        r.section6?.use_resources === 'no' || !r.section6?.resources?.length,
    ).length;
    const typeMap = new Map<string, number>();
    const sourceMap = new Map<string, number>();
    const verifMap = new Map<string, number>();
    let entries = 0;
    let selfFunded = 0;
    let mobilized = 0;
    let unverifiedHigh = 0;

    for (const r of withSec) {
      for (const res of r.section6?.resources || []) {
        entries += 1;
        const type = this.labelKey(res.type || 'Other');
        typeMap.set(type, (typeMap.get(type) || 0) + 1);
        const source = this.labelKey(res.source || 'Unspecified');
        sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
        const ver = this.labelKey(res.verification || 'Pending');
        verifMap.set(ver, (verifMap.get(ver) || 0) + 1);
        if (/self/i.test(source)) selfFunded += 1;
        const amt = this.parseNum(res.amount);
        if (
          amt > 0 &&
          /pkr|rs|rupee|cash|financial/i.test(`${res.unit} ${res.type}`)
        ) {
          mobilized += amt;
          if (/self|pending|report/i.test(ver) && amt >= 10000)
            unverifiedHigh += 1;
        } else if (amt > 0) {
          mobilized += amt;
        }
      }
    }

    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      total_resource_entries: entries,
      resource_type_mix: this.toDist([...typeMap.entries()]),
      source_mix: this.toDist([...sourceMap.entries()]),
      verification_status_mix: this.toDist([...verifMap.entries()]),
      time_only_projects: timeOnly,
      self_funded_share: {
        self_funded_entries: selfFunded,
        total_entries: entries,
        percent: entries === 0 ? 0 : Math.round((100 * selfFunded) / entries),
      },
      mobilized_value_estimate: {
        amount: Math.round(mobilized),
        unit: 'parsed_numeric_sum',
        note: 'Sum of numeric amounts where parseable; not a full PKR normalization ledger',
      },
      red_flag_count: {
        count: unverifiedHigh,
        action_required: unverifiedHigh > 0,
      },
    };
  }

  private computeSection7(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section7));
    const withPartners = withSec.filter(
      (r) =>
        r.section7?.has_partners === 'yes' &&
        (r.section7?.partners?.length || 0) > 0,
    );
    const typeMap = new Map<string, number>();
    const verMap = new Map<string, number>();
    const contribMap = new Map<string, number>();
    const names = new Set<string>();
    let formalized = 0;
    let selfOnly = 0;
    const classMap = new Map<string, number>([
      ['None', 0],
      ['Basic', 0],
      ['Moderate', 0],
      ['Strategic', 0],
    ]);

    for (const r of withSec) {
      if (r.section7?.has_partners !== 'yes' || !r.section7.partners?.length) {
        classMap.set('None', (classMap.get('None') || 0) + 1);
        continue;
      }
      const formal = (r.section7.formalization_status || []).some((s) =>
        /mou|letter|approval|formal/i.test(s),
      );
      if (formal) formalized += 1;
      let maxVer = 0;
      for (const p of r.section7.partners) {
        names.add(this.labelKey(p.name).toLowerCase());
        const partnerType = this.labelKey(p.type || 'Other');
        typeMap.set(partnerType, (typeMap.get(partnerType) || 0) + 1);
        const v = this.labelKey(p.verification || 'Self-reported');
        verMap.set(v, (verMap.get(v) || 0) + 1);
        if (/self/i.test(v)) selfOnly += 1;
        maxVer = Math.max(maxVer, this.partnerVerRank(v));
        for (const c of p.contribution || []) {
          const contrib = this.labelKey(c);
          contribMap.set(contrib, (contribMap.get(contrib) || 0) + 1);
        }
      }
      const partnerCount = r.section7.partners.length;
      let cls = 'Basic';
      if (partnerCount >= 2 && formal && maxVer >= 3) cls = 'Strategic';
      else if (formal || maxVer >= 2) cls = 'Moderate';
      classMap.set(cls, (classMap.get(cls) || 0) + 1);
    }

    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      projects_with_partners_percent: this.pctObj(
        withPartners.length,
        withSec.length || 1,
      ),
      partner_type_mix: this.toDist([...typeMap.entries()]),
      formalization_rate: this.pctObj(formalized, withPartners.length || 1),
      verification_level_mix: this.toDist([...verMap.entries()]),
      distinct_partners_estimate: [...names].filter(Boolean).length,
      sdg17_classification_spread: this.toDist([...classMap.entries()]),
      contribution_type_mix: this.toDist([...contribMap.entries()]),
      red_flag_count: { count: selfOnly, action_required: selfOnly > 0 },
    };
  }

  private computeSection8(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section8));
    const backed = withSec.filter(
      (r) => (r.section8?.evidence_types?.length || 0) > 0,
    );
    const typeMap = new Map<string, number>();
    const visMap = new Map<string, number>();
    let partnerVerified = 0;
    let ethicsOk = 0;
    let credibilitySum = 0;
    let consentRisk = 0;
    let bypass = 0;

    for (const r of withSec) {
      const types = r.section8?.evidence_types || [];
      if (types.length === 0) bypass += 1;
      for (const t of types) typeMap.set(t, (typeMap.get(t) || 0) + 1);
      const vis = r.section8?.media_visible || 'internal';
      visMap.set(vis, (visMap.get(vis) || 0) + 1);
      if (r.section8?.partner_verification) partnerVerified += 1;
      const eth = r.section8?.ethical_compliance;
      const ethCount = eth
        ? [
            eth.authentic,
            eth.informed_consent,
            eth.no_harm,
            eth.privacy_respected,
          ].filter(Boolean).length
        : 0;
      if (ethCount === 4) ethicsOk += 1;
      if (vis === 'public' && ethCount < 4) consentRisk += 1;
      credibilitySum += this.credibilityScore(r);
    }

    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      evidence_backed_percent: this.pctObj(backed.length, withSec.length || 1),
      evidence_type_coverage: this.toDist([...typeMap.entries()]),
      partner_verified_percent: this.pctObj(
        partnerVerified,
        withSec.length || 1,
      ),
      avg_credibility_score: {
        score:
          withSec.length === 0
            ? 0
            : Math.round(credibilitySum / withSec.length),
      },
      ethics_completion_rate: this.pctObj(ethicsOk, withSec.length || 1),
      media_visibility_mix: this.toDist([...visMap.entries()]),
      consent_risk_count: consentRisk,
      red_flag_count: {
        count: bypass + consentRisk,
        action_required: bypass + consentRisk > 0,
      },
    };
  }

  private computeSection9(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section9));
    const integration = this.dist(
      withSec.map((r) => r.section9?.academic_integration || 'Unspecified'),
    );
    const strong = this.dist(
      withSec.map((r) => r.section9?.strongest_competency || 'Unspecified'),
    );
    let cog = 0,
      prac = 0,
      soc = 0,
      trans = 0,
      n = 0,
      ratingSum = 0,
      ratingCount = 0;
    let specific = 0;
    let curricular = 0;
    let flags = 0;

    for (const r of withSec) {
      const scores = r.section9?.competency_scores;
      if (scores) {
        cog += Number(scores.cognitive) || 0;
        prac += Number(scores.practical) || 0;
        soc += Number(scores.social) || 0;
        trans += Number(scores.transformative) || 0;
        n += 1;
        for (const v of [
          scores.cognitive,
          scores.practical,
          scores.social,
          scores.transformative,
        ]) {
          if (typeof v === 'number') {
            ratingSum += v;
            ratingCount += 1;
          }
        }
        const vals = [
          scores.cognitive,
          scores.practical,
          scores.social,
          scores.transformative,
        ];
        if (vals.every((v) => v === vals[0]) && vals[0] != null) flags += 1;
      }
      const text = `${this.asText(r.section9?.personal_learning)} ${this.asText(r.section9?.academic_application)}`;
      if (
        text.trim().length >= 80 &&
        !/improved my communication and teamwork/i.test(text)
      ) {
        specific += 1;
      }
      if (
        /course|credit|capstone|research/i.test(
          this.asText(r.section9?.academic_integration),
        )
      ) {
        curricular += 1;
      }
      if (!this.asText(r.section9?.academic_application).trim()) flags += 1;
    }

    const mean = (x: number) => (n === 0 ? 0 : Math.round((x / n) * 10) / 10);

    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      competency_group_means: [
        { label: 'Cognitive', count: mean(cog) },
        { label: 'Practical', count: mean(prac) },
        { label: 'Social & Civic', count: mean(soc) },
        { label: 'Transformative', count: mean(trans) },
      ],
      academic_integration_distribution: integration,
      curricular_integration_percent: this.pctObj(
        curricular,
        withSec.length || 1,
      ),
      specific_reflection_rate: this.pctObj(specific, withSec.length || 1),
      strongest_competency_distribution: strong,
      avg_self_rating:
        ratingCount === 0 ? 0 : Math.round((ratingSum / ratingCount) * 10) / 10,
      red_flag_count: { count: flags, action_required: flags > 0 },
    };
  }

  private computeSection10(
    reports: StudentReport[],
    projectTitle: unknown,
  ): AnalyticsFieldValues {
    const withSec = reports.filter((r) => this.hasContent(r.section10));
    const status = this.dist(
      withSec.map((r) => r.section10?.continuation_status || 'Unspecified'),
    );
    const yes = withSec.filter(
      (r) => r.section10?.continuation_status === 'yes',
    ).length;
    const mechMap = new Map<string, number>();
    const scale = this.dist(
      withSec.map((r) => r.section10?.scaling_potential || 'Unspecified'),
    );
    let policy = 0;
    let noPlan = 0;
    for (const r of withSec) {
      for (const m of r.section10?.mechanisms || []) {
        const key = this.labelKey(m);
        mechMap.set(key, (mechMap.get(key) || 0) + 1);
      }
      if (this.asText(r.section10?.policy_influence).trim().length >= 20)
        policy += 1;
      if (
        r.section10?.continuation_status === 'no' ||
        !this.asText(r.section10?.continuation_details).trim()
      ) {
        noPlan += 1;
      }
    }
    return {
      project_title: projectTitle,
      section_completion_rate: this.pctObj(withSec.length, reports.length),
      reports_with_section: withSec.length,
      continuation_status_mix: status,
      continuation_yes_rate: this.pctObj(yes, withSec.length || 1),
      mechanisms_distribution: this.toDist([...mechMap.entries()]),
      scaling_potential_mix: scale,
      policy_influence_rate: this.pctObj(policy, withSec.length || 1),
      red_flag_count: { count: noPlan, action_required: noPlan > 0 },
    };
  }

  private headlineForSection(
    section: number,
    metrics: AnalyticsFieldValues,
  ): string {
    const withSec =
      typeof metrics.reports_with_section === 'number'
        ? metrics.reports_with_section
        : 0;
    const completion =
      typeof (metrics.section_completion_rate as { percent?: number })
        ?.percent === 'number'
        ? (metrics.section_completion_rate as { percent: number }).percent
        : 0;
    switch (section) {
      case 3:
        return `${metrics.goal_coverage_count ?? 0} SDG goals · ${completion}% mapped`;
      case 4:
        return `${metrics.total_beneficiaries ?? 0} beneficiaries reported`;
      case 6:
        return `${metrics.total_resource_entries ?? 0} resource entries · ${completion}% complete`;
      case 7: {
        const p = (
          metrics.projects_with_partners_percent as { percent?: number }
        )?.percent;
        return `${p ?? 0}% projects with partners`;
      }
      case 8: {
        const p = (metrics.evidence_backed_percent as { percent?: number })
          ?.percent;
        return `${p ?? 0}% evidence-backed`;
      }
      case 9:
        return `Avg competency ${metrics.avg_self_rating ?? '—'} · ${completion}% complete`;
      case 10: {
        const p = (metrics.continuation_yes_rate as { percent?: number })
          ?.percent;
        return `${p ?? 0}% planning continuation`;
      }
      default:
        return `${withSec} reports · ${completion}% complete`;
    }
  }

  private pickSummaryKeys(
    section: number,
    metrics: AnalyticsFieldValues,
  ): Record<string, unknown> {
    const keysBySection: Record<number, string[]> = {
      2: ['discipline_distribution', 'section_completion_rate'],
      3: ['primary_sdg_distribution', 'goal_coverage_count'],
      4: ['total_beneficiaries', 'activity_type_distribution'],
      5: ['outcome_area_distribution', 'baseline_endline_rate'],
      6: ['total_resource_entries', 'source_mix', 'verification_status_mix'],
      7: ['projects_with_partners_percent', 'sdg17_classification_spread'],
      8: [
        'evidence_backed_percent',
        'avg_credibility_score',
        'partner_verified_percent',
      ],
      9: ['competency_group_means', 'curricular_integration_percent'],
      10: ['continuation_status_mix', 'continuation_yes_rate'],
    };
    const out: Record<string, unknown> = {};
    for (const k of keysBySection[section] || []) {
      if (metrics[k] !== undefined) out[k] = metrics[k];
    }
    return out;
  }

  private credibilityScore(r: StudentReport): number {
    const s = r.section8;
    if (!s) return 0;
    let score = 0;
    const types = s.evidence_types?.length || 0;
    if (types > 0) score += 20;
    score += Math.min(24, types * 6);
    const desc = this.asText(s.description).trim().length;
    if (desc >= 100) score += 16;
    else if (desc >= 40) score += 8;
    const eth = s.ethical_compliance;
    if (eth) {
      score +=
        [
          eth.authentic,
          eth.informed_consent,
          eth.no_harm,
          eth.privacy_respected,
        ].filter(Boolean).length * 4;
    }
    if (types >= 2) score += 9;
    if (s.partner_verification) score += 15;
    return Math.min(100, score);
  }

  private partnerVerRank(v: string): number {
    const s = v.toLowerCase();
    if (s.includes('outcome')) return 5;
    if (s.includes('output') || s.includes('resource')) return 4;
    if (s.includes('activity')) return 3;
    if (s.includes('attendance')) return 2;
    if (s.includes('self')) return 0;
    return 1;
  }

  private hasContent(section: unknown): boolean {
    if (section == null) return false;
    if (typeof section !== 'object') return false;
    return Object.keys(section as object).length > 0;
  }

  private parseNum(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(
        String(v)
          .replace(/,/g, '')
          .replace(/[^\d.-]/g, ''),
      );
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  /** Coerce jsonb-ish values into a stable distribution label. */
  private labelKey(value: unknown): string {
    if (value == null || value === '') return 'Unspecified';
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || 'Unspecified';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((entry) => this.labelKey(entry))
        .filter((entry) => entry !== 'Unspecified');
      return parts.length ? parts.join(', ') : 'Unspecified';
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['label', 'name', 'title', 'value', 'text']) {
        if (typeof record[key] === 'string') {
          const trimmed = record[key].trim();
          if (trimmed) return trimmed;
        }
      }
      try {
        return JSON.stringify(value);
      } catch {
        return 'Unspecified';
      }
    }
    return 'Unspecified';
  }

  private asText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return '';
  }

  private pctObj(
    n: number,
    d: number,
  ): { percent: number; numerator: number; denominator: number } {
    const denominator = d || 0;
    return {
      percent: denominator === 0 ? 0 : Math.round((100 * n) / denominator),
      numerator: n,
      denominator,
    };
  }

  private dist(labels: unknown[]): DistRow[] {
    const map = new Map<string, number>();
    for (const l of labels) {
      const key = this.labelKey(l);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return this.toDist([...map.entries()]);
  }

  private toDist(entries: Array<[string, number]>): DistRow[] {
    return entries
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }
}

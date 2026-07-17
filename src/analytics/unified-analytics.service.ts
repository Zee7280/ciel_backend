import { Injectable } from '@nestjs/common';
import { Section1AnalyticsQueryDto } from './dto/section1-analytics-query.dto';
import { SectionReportAnalyticsService } from './section-report-analytics.service';
import { AnalyticsScopeService } from './shared/analytics-scope.service';
import {
  AnalyticsStakeholder,
  SummaryAnalyticsResponse,
} from './shared/section-analytics.types';
import {
  UnifiedAnalyticsResponse,
  UnifiedAnalyticsSeries,
} from './shared/unified-analytics.types';

export type AnalyticsRequester = {
  id: string;
  /** JWT role string (matches UserRole enum values). */
  role: string;
  organizationId?: string | null;
  orgType?: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  verified: '#10b981',
  approved: '#22c55e',
  submitted: '#3b82f6',
  draft: '#94a3b8',
  rejected: '#f43f5e',
  pending: '#f59e0b',
};

@Injectable()
export class UnifiedAnalyticsService {
  constructor(
    private readonly sectionReportAnalyticsService: SectionReportAnalyticsService,
    private readonly scopeService: AnalyticsScopeService,
  ) {}

  async getOverview(
    requester: AnalyticsRequester,
    query: Section1AnalyticsQueryDto,
    forcedStakeholder?: AnalyticsStakeholder,
  ): Promise<UnifiedAnalyticsResponse> {
    const summary = await this.sectionReportAnalyticsService.getSummary(
      requester,
      query,
      forcedStakeholder,
    );
    const { stakeholder, scope, project_id, organization_id } = summary.data;
    const studentId =
      stakeholder === 'student'
        ? requester.id
        : (query.student_id || '').trim() || undefined;

    const { reports, projectIds } = await this.scopeService.loadScopedReports({
      stakeholder,
      scope,
      organizationId: requester.organizationId,
      projectId: project_id,
      studentId,
      universityFilter: query.university,
      facultyId: requester.role === 'faculty' ? requester.id : undefined,
    });

    const verifiedReports = summary.data.composite.verified_reports;
    const totalReports = summary.data.composite.total_reports;
    const verificationRate =
      totalReports === 0
        ? 0
        : Math.round((verifiedReports / totalReports) * 100);
    const reportedHours = this.sumReportValue(
      reports.map((report) => report.section4?.my_hours),
    );
    const reportedBeneficiaries = this.sumReportValue(
      reports.map((report) => report.section4?.my_beneficiaries),
    );

    return {
      success: true,
      data: {
        stakeholder,
        scope,
        project_id,
        organization_id,
        generated_at: new Date().toISOString(),
        kpis: [
          {
            key: 'total_reports',
            label: 'Reports',
            value: totalReports,
            unit: 'count',
            description: 'Latest report per student and project',
          },
          {
            key: 'verified_reports',
            label: 'Verified reports',
            value: verifiedReports,
            unit: 'count',
            description: `${verificationRate}% of scoped reports`,
          },
          {
            key: 'projects',
            label: 'Projects',
            value: projectIds.length,
            unit: 'count',
            description: 'Projects available in this analytics scope',
          },
          {
            key: 'average_completion',
            label: 'Average completion',
            value: summary.data.composite.average_completion_percent,
            unit: 'percent',
            description: 'Average completion across Sections 1–10',
          },
          {
            key: 'reported_hours',
            label: 'Reported hours',
            value: reportedHours,
            unit: 'hours',
            description: 'Student-reported activity hours',
          },
          {
            key: 'reported_beneficiaries',
            label: 'Reported reach',
            value: reportedBeneficiaries,
            unit: 'count',
            description: 'Beneficiaries attributed in scoped reports',
          },
        ],
        charts: this.buildCharts(summary, reports),
        sections: summary.data.sections,
        composite: summary.data.composite,
      },
    };
  }

  private buildCharts(
    summary: SummaryAnalyticsResponse,
    reports: Array<{
      status: string;
      admin_status: string;
      primary_sdg_goal: number | null;
      section3?: {
        primary_sdg?: { goal_number?: number | null };
      } | null;
      reportSubmittedAt: Date | null;
      submission_date: Date;
    }>,
  ): UnifiedAnalyticsSeries[] {
    const statusCounts = new Map<string, number>();
    const sdgCounts = new Map<string, number>();

    for (const report of reports) {
      const status = this.normalizeStatus(report.status, report.admin_status);
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);

      const goal =
        report.primary_sdg_goal ??
        report.section3?.primary_sdg?.goal_number ??
        null;
      const label = goal ? `SDG ${goal}` : 'Unspecified';
      sdgCounts.set(label, (sdgCounts.get(label) || 0) + 1);
    }

    return [
      {
        key: 'section_completion',
        title: 'Section completion',
        type: 'bar',
        data: summary.data.sections.map((section) => ({
          label: `S${section.section}`,
          value: section.completion_percent,
        })),
      },
      {
        key: 'report_status',
        title: 'Report status',
        type: 'donut',
        data: [...statusCounts.entries()]
          .map(([label, value]) => ({
            label: this.toTitleCase(label),
            value,
            color: STATUS_COLORS[label] || '#6366f1',
          }))
          .sort((a, b) => b.value - a.value),
      },
      {
        key: 'sdg_distribution',
        title: 'Primary SDG distribution',
        type: 'bar',
        data: [...sdgCounts.entries()]
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 10),
      },
      {
        key: 'submission_trend',
        title: 'Report submissions',
        type: 'line',
        data: this.buildMonthlySubmissionTrend(reports),
      },
    ];
  }

  private buildMonthlySubmissionTrend(
    reports: Array<{
      reportSubmittedAt: Date | null;
      submission_date: Date;
    }>,
  ): Array<{ label: string; value: number }> {
    const now = new Date();
    const months: Array<{ key: string; label: string; value: number }> = [];
    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1),
      );
      months.push({
        key: `${date.getUTCFullYear()}-${String(
          date.getUTCMonth() + 1,
        ).padStart(2, '0')}`,
        label: date.toLocaleString('en-US', {
          month: 'short',
          timeZone: 'UTC',
        }),
        value: 0,
      });
    }

    const byKey = new Map(months.map((month) => [month.key, month]));
    for (const report of reports) {
      const raw = report.reportSubmittedAt || report.submission_date;
      if (!raw) continue;
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) continue;
      const key = `${date.getUTCFullYear()}-${String(
        date.getUTCMonth() + 1,
      ).padStart(2, '0')}`;
      const month = byKey.get(key);
      if (month) month.value += 1;
    }
    return months.map(({ label, value }) => ({ label, value }));
  }

  private normalizeStatus(status: string, adminStatus: string): string {
    const normalized = String(status || 'draft').toLowerCase();
    if (normalized === 'verified' || adminStatus === 'approved') {
      return 'verified';
    }
    if (normalized.includes('reject')) return 'rejected';
    if (normalized.includes('submit')) return 'submitted';
    if (normalized.includes('pending')) return 'pending';
    return normalized || 'draft';
  }

  private sumReportValue(values: unknown[]): number {
    const total = values.reduce<number>((sum, value) => {
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string'
            ? Number.parseFloat(value.replace(/,/g, ''))
            : 0;
      return sum + (Number.isFinite(parsed) ? parsed : 0);
    }, 0);
    return Math.round(total * 100) / 100;
  }

  private toTitleCase(value: string): string {
    return value
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

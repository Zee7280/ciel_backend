import { UserRole } from '../users/enums/user-role.enum';
import { SectionReportAnalyticsService } from './section-report-analytics.service';
import { AnalyticsScopeService } from './shared/analytics-scope.service';
import { UnifiedAnalyticsService } from './unified-analytics.service';

describe('UnifiedAnalyticsService', () => {
  it('returns chart-ready KPIs and scoped report series', async () => {
    const summaryService = {
      getSummary: jest.fn().mockResolvedValue({
        success: true,
        data: {
          stakeholder: 'ciel',
          scope: 'aggregate',
          sections: Array.from({ length: 10 }, (_, index) => ({
            section: index + 1,
            title: `Section ${index + 1}`,
            status: 'ready',
            headline: 'Ready',
            completion_percent: 80,
            key_metrics: {},
          })),
          composite: {
            sections_with_data: 10,
            average_completion_percent: 80,
            verified_reports: 1,
            total_reports: 2,
          },
        },
      }),
    };
    const scopeService = {
      loadScopedReports: jest.fn().mockResolvedValue({
        projectIds: ['project-1'],
        titles: ['Project 1'],
        reports: [
          {
            status: 'verified',
            admin_status: 'approved',
            primary_sdg_goal: 3,
            section4: {
              my_hours: '12.5',
              my_beneficiaries: '20',
            },
            reportSubmittedAt: new Date(),
            submission_date: new Date(),
          },
          {
            status: 'submitted',
            admin_status: 'pending',
            primary_sdg_goal: 4,
            section4: {
              my_hours: '7.5',
              my_beneficiaries: '10',
            },
            reportSubmittedAt: new Date(),
            submission_date: new Date(),
          },
        ],
      }),
    };
    const service = new UnifiedAnalyticsService(
      summaryService as unknown as SectionReportAnalyticsService,
      scopeService as unknown as AnalyticsScopeService,
    );

    const result = await service.getOverview(
      { id: 'admin-1', role: UserRole.SUPER_ADMIN },
      { scope: 'aggregate' },
      'ciel',
    );

    expect(result.success).toBe(true);
    expect(result.data.kpis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'total_reports', value: 2 }),
        expect.objectContaining({ key: 'projects', value: 1 }),
        expect.objectContaining({ key: 'reported_hours', value: 20 }),
        expect.objectContaining({
          key: 'reported_beneficiaries',
          value: 30,
        }),
      ]),
    );
    expect(result.data.charts.map((chart) => chart.key)).toEqual(
      expect.arrayContaining(['section_completion', 'report_status']),
    );
    const reportStatus = result.data.charts.find(
      (chart) => chart.key === 'report_status',
    );
    expect(reportStatus?.data).toContainEqual(
      expect.objectContaining({ label: 'Verified', value: 1 }),
    );
    expect(summaryService.getSummary).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-1' }),
      { scope: 'aggregate' },
      'ciel',
    );
  });
});

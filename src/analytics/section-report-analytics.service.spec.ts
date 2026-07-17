import { SectionReportAnalyticsService } from './section-report-analytics.service';
import { StudentReport } from '../reports/entities/student-report.entity';

describe('SectionReportAnalyticsService metrics', () => {
  const service = new SectionReportAnalyticsService({} as any);

  function report(partial: Partial<StudentReport>): StudentReport {
    return {
      id: 'r1',
      studentId: 's1',
      opportunityId: 'p1',
      project_id: 'p1',
      status: 'submitted',
      faculty_status: 'pending',
      partner_status: 'pending',
      admin_status: 'pending',
      ...partial,
    } as StudentReport;
  }

  it('computes section 6 resource mix from ledger entries', () => {
    const reports = [
      report({
        section6: {
          use_resources: 'yes',
          resources: [
            {
              type: 'Cash funding',
              amount: '25000',
              unit: 'PKR',
              source: 'Partner',
              purpose: 'paint',
              verification: 'Partner confirmed',
            },
            {
              type: 'Transport',
              amount: '8000',
              unit: 'PKR',
              source: 'Self-funded',
              purpose: 'travel',
              verification: 'Self-reported',
            },
          ],
        },
      }),
    ];
    const metrics = (service as any).computeSection6(reports, 'Demo');
    expect(metrics.total_resource_entries).toBe(2);
    expect(metrics.self_funded_share.percent).toBe(50);
    expect(metrics.mobilized_value_estimate.amount).toBe(33000);
    expect(Array.isArray(metrics.resource_type_mix)).toBe(true);
  });

  it('computes section 7 SDG17 classification ladder', () => {
    const reports = [
      report({
        section7: {
          has_partners: 'yes',
          partners: [
            {
              name: 'SOS',
              type: 'NGO',
              role: 'Host',
              contribution: ['Venue'],
              verification: 'Outcome',
            },
            {
              name: 'WASA',
              type: 'Government',
              role: 'Verifier',
              contribution: ['Monitoring'],
              verification: 'Output',
            },
          ],
          formalization_status: ['MOU'],
        },
      }),
      report({
        id: 'r2',
        studentId: 's2',
        section7: {
          has_partners: 'no',
          partners: [],
          formalization_status: [],
        },
      }),
    ];
    const metrics = (service as any).computeSection7(reports, 'Demo');
    expect(metrics.projects_with_partners_percent.percent).toBe(50);
    expect(metrics.distinct_partners_estimate).toBe(2);
    const strategic = metrics.sdg17_classification_spread.find(
      (r: { label: string }) => r.label === 'Strategic',
    );
    expect(strategic?.count).toBe(1);
  });

  it('computes section 8 credibility and evidence coverage', () => {
    const reports = [
      report({
        section8: {
          evidence_types: ['Activity photos', 'Attendance sheet'],
          description: 'x'.repeat(120),
          media_visible: 'public',
          ethical_compliance: {
            authentic: true,
            informed_consent: true,
            no_harm: true,
            privacy_respected: true,
          },
          partner_verification: true,
        },
      }),
    ];
    const metrics = (service as any).computeSection8(reports, 'Demo');
    expect(metrics.evidence_backed_percent.percent).toBe(100);
    expect(metrics.partner_verified_percent.percent).toBe(100);
    expect(metrics.avg_credibility_score.score).toBeGreaterThan(50);
    expect(metrics.ethics_completion_rate.percent).toBe(100);
  });

  it('tolerates non-string section2 distribution labels', () => {
    const reports = [
      report({
        section2: {
          problem_statement: { text: 'short' } as any,
          discipline: { name: 'Computer Science' } as any,
          discipline_contribution: 'x',
          baseline_evidence: ['survey', 'interview'] as any,
          problem_category: 12 as any,
          primary_beneficiary: null as any,
        } as any,
      }),
    ];
    const metrics = (service as any).computeSection2(reports, 'Demo');
    expect(metrics.reports_with_section).toBe(1);
    expect(metrics.discipline_distribution[0].label).toBe('Computer Science');
    expect(metrics.baseline_evidence_distribution[0].label).toContain('survey');
    expect(metrics.problem_category_distribution[0].label).toBe('12');
  });

  it('keeps going when a section metric compute throws', () => {
    const reports = [
      report({
        section2: {
          problem_statement:
            'A sufficiently long problem statement for context.',
          discipline: 'CS',
          discipline_contribution: 'x',
          baseline_evidence: 'survey',
        },
      }),
    ];
    const svc = service as any;
    const original = svc.computeSectionMetrics.bind(svc);
    jest
      .spyOn(svc, 'computeSectionMetrics')
      .mockImplementation((section: number, ...args: any[]) => {
        if (section === 4) throw new Error('boom');
        return original(section, ...args);
      });

    const sections: Array<{ section: number; status: string }> = [];
    for (const section of [2, 3, 4, 5] as const) {
      try {
        const metrics = svc.computeSectionMetrics(section, reports, {
          stakeholder: 'ciel',
          scope: 'aggregate',
          titles: [],
        });
        sections.push({
          section,
          status: metrics.reports_with_section ? 'ready' : 'empty',
        });
      } catch {
        sections.push({ section, status: 'empty' });
      }
    }
    expect(sections.find((s) => s.section === 4)?.status).toBe('empty');
    expect(sections.find((s) => s.section === 2)?.status).toBe('ready');
    jest.restoreAllMocks();
  });

  it('rejects invalid section numbers', async () => {
    await expect(
      service.getSectionAnalytics(1, { id: 'a', role: 'admin' }, {}),
    ).rejects.toThrow(/section must be an integer from 2 to 10/);
    await expect(
      service.getSectionAnalytics(11, { id: 'a', role: 'admin' }, {}),
    ).rejects.toThrow(/section must be an integer from 2 to 10/);
  });
});

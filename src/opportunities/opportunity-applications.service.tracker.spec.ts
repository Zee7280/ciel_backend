import { OpportunityApplicationsService } from './opportunity-applications.service';

/** Admin Project Tracker needs the report id to deep-link "Open full report" / send-back actions. */
type TestableService = {
  trackerImpactReportEnrollmentFields: (
    report: Record<string, unknown> | null,
  ) => Record<string, unknown>;
};

function build(): TestableService {
  const args: unknown[] = new Array<unknown>(11).fill({});
  const Ctor = OpportunityApplicationsService as unknown as new (
    ...ctorArgs: unknown[]
  ) => unknown;
  return new Ctor(...args) as TestableService;
}

describe('OpportunityApplicationsService tracker report fields', () => {
  it('exposes a null report id when no report exists', () => {
    const fields = build().trackerImpactReportEnrollmentFields(null);
    expect(fields.impact_report_id).toBeNull();
    expect(fields.impact_report_started).toBe(false);
    expect(fields.impact_report_summary).toBe('No impact report yet');
  });

  it('exposes the report id alongside the existing status fields', () => {
    const fields = build().trackerImpactReportEnrollmentFields({
      id: 'rep-1',
      status: 'submitted',
      partner_status: 'approved',
      admin_status: 'pending',
      faculty_status: 'pending',
    });
    expect(fields.impact_report_id).toBe('rep-1');
    expect(fields.impact_report_started).toBe(true);
    expect(fields.impact_report_partner_status).toBe('approved');
    expect(fields.impact_report_summary).toBe(
      'Submitted · admin approval pending',
    );
  });
});

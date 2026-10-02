import {
  REPORTING_WINDOW_DAYS,
  addDaysToDateOnly,
  canEditOrSubmitReport,
  canJoinOrApply,
  canRecordCompletedService,
  getApplicationsCloseDate,
  getReportingCloseDate,
  isServiceDateAllowed,
  resolveLifecyclePhase,
  validateTimelineForPersist,
} from './opportunity-timeline.util';

describe('opportunity-timeline.util', () => {
  const base = {
    start_date: '2026-10-01',
    end_date: '2026-10-31',
  };

  it('defaults applications close to project end', () => {
    expect(getApplicationsCloseDate(base)).toBe('2026-10-31');
    expect(canJoinOrApply(base, '2026-10-31')).toBe(true);
    expect(canJoinOrApply(base, '2026-11-01')).toBe(false);
  });

  it('honours early application close before end', () => {
    const t = {
      ...base,
      close_applications_early: true,
      application_deadline: '2026-10-15',
    };
    expect(getApplicationsCloseDate(t)).toBe('2026-10-15');
    expect(resolveLifecyclePhase(t, '2026-10-16')).toBe(
      'applications_closed_service_active',
    );
    expect(canJoinOrApply(t, '2026-10-16')).toBe(false);
  });

  it('opens 60-day reporting window after project end', () => {
    expect(getReportingCloseDate(base)).toBe(
      addDaysToDateOnly(base.end_date, REPORTING_WINDOW_DAYS),
    );
    expect(resolveLifecyclePhase(base, '2026-11-01')).toBe(
      'service_ended_reporting_open',
    );
    expect(canRecordCompletedService(base, '2026-11-20')).toBe(true);
    expect(canEditOrSubmitReport(base, '2026-11-20')).toBe(true);
  });

  it('closes reporting after end+60 unless reopened', () => {
    const closedDay = addDaysToDateOnly(base.end_date, REPORTING_WINDOW_DAYS + 1)!;
    expect(resolveLifecyclePhase(base, closedDay)).toBe('reporting_closed');
    expect(canEditOrSubmitReport(base, closedDay)).toBe(false);

    const reopened = {
      ...base,
      reporting_window_reopened_until: '2027-01-15',
    };
    expect(canEditOrSubmitReport(reopened, '2027-01-10')).toBe(true);
  });

  it('allows service dates only inside start..end', () => {
    expect(isServiceDateAllowed('2026-10-15', base)).toBe(true);
    expect(isServiceDateAllowed('2026-11-10', base)).toBe(false);
    expect(isServiceDateAllowed('2026-09-30', base)).toBe(false);
  });

  it('validates mandatory start/end and early-close deadline', () => {
    expect(validateTimelineForPersist({})).toMatch(/start date/i);
    expect(validateTimelineForPersist(base)).toBeNull();
    expect(
      validateTimelineForPersist({
        ...base,
        close_applications_early: true,
      }),
    ).toMatch(/application closing date/i);
    expect(
      validateTimelineForPersist({
        ...base,
        close_applications_early: true,
        application_deadline: '2026-10-31',
      }),
    ).toMatch(/before the project end/i);
    expect(
      validateTimelineForPersist({
        ...base,
        close_applications_early: true,
        application_deadline: '2026-10-20',
      }),
    ).toBeNull();
    expect(
      validateTimelineForPersist({
        ...base,
        close_applications_early: true,
        application_deadline: '2026-09-01',
      }),
    ).toMatch(/before the project start/i);
  });
});

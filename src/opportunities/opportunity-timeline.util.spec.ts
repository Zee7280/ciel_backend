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
  todayDateOnlyPk,
  todayDateOnlyUtc,
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

  it('has NO application deadline: legacy early-close fields are ignored, applications run until the project end', () => {
    const t = {
      ...base,
      close_applications_early: true,
      application_deadline: '2026-10-15',
    };
    expect(getApplicationsCloseDate(t)).toBe(base.end_date);
    expect(resolveLifecyclePhase(t, '2026-10-16')).toBe('join_open');
    expect(canJoinOrApply(t, '2026-10-16')).toBe(true);
    // ... and close the day after the project end, regardless of any stored deadline
    const dayAfterEnd = addDaysToDateOnly(base.end_date, 1)!;
    expect(canJoinOrApply(t, dayAfterEnd)).toBe(false);
    expect(resolveLifecyclePhase(t, dayAfterEnd)).toBe('service_ended_reporting_open');
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

  it('validates mandatory start/end; an application deadline is neither required nor validated', () => {
    expect(validateTimelineForPersist({})).toMatch(/start date/i);
    expect(validateTimelineForPersist(base)).toBeNull();
    expect(validateTimelineForPersist({ start_date: base.start_date })).toMatch(/start date and a project end date/i);
    expect(validateTimelineForPersist({ ...base, end_date: '2000-01-01' })).toMatch(/on or after/i);
    // legacy payloads that still carry the old fields are accepted as-is (and ignored)
    expect(
      validateTimelineForPersist({ ...base, close_applications_early: true, application_deadline: '2026-10-31' }),
    ).toBeNull();
    expect(
      validateTimelineForPersist({ ...base, close_applications_early: true }),
    ).toBeNull();
  });
});

describe('validateTimelineForPersist — calendar and daily-window validity', () => {
  const ok = { start_date: '2026-10-01', end_date: '2026-10-31' };

  it('rejects impossible calendar dates that the prefix regex used to let through', () => {
    for (const bad of ['2026-13-45', '2026-02-31', '2026-00-10']) {
      expect(
        validateTimelineForPersist({ start_date: bad, end_date: '2026-12-31' }),
      ).toMatch(/valid calendar dates/);
    }
    expect(validateTimelineForPersist(ok)).toBeNull();
  });

  it('validates the daily window format and order', () => {
    expect(validateTimelineForPersist({ ...ok, from_time: '9am', to_time: '13:00' })).toMatch(/HH:mm/);
    expect(validateTimelineForPersist({ ...ok, from_time: '14:00', to_time: '13:00' })).toMatch(/after/);
    expect(validateTimelineForPersist({ ...ok, from_time: '13:00', to_time: '13:00' })).toMatch(/after/);
    expect(validateTimelineForPersist({ ...ok, from_time: '09:00', to_time: '13:00' })).toBeNull();
    expect(validateTimelineForPersist({ ...ok, from_time: '', to_time: '' })).toBeNull();
  });
});

describe('platform calendar is Pakistan time', () => {
  it('between 00:00 and 05:00 PKT the PKT date is already "today" while UTC is still yesterday', () => {
    const at = new Date('2026-10-03T21:30:00Z'); // 02:30 on 4 Oct in Pakistan
    expect(todayDateOnlyUtc(at)).toBe('2026-10-03');
    expect(todayDateOnlyPk(at)).toBe('2026-10-04');
  });
  it('after 05:00 PKT both agree', () => {
    const at = new Date('2026-10-04T06:00:00Z'); // 11:00 PKT
    expect(todayDateOnlyPk(at)).toBe('2026-10-04');
  });
  it('the last project day closes applications at 00:00 PKT, not five hours later (UTC date would still be the end date)', () => {
    const tl = { start_date: '2026-09-20', end_date: '2026-10-03' };
    const at = new Date('2026-10-03T21:30:00Z'); // 02:30 on 4 Oct PKT — project already ended there
    expect(canJoinOrApply(tl, todayDateOnlyPk(at))).toBe(false);
    expect(canJoinOrApply(tl, todayDateOnlyUtc(at))).toBe(true); // the old UTC behaviour: wrongly open
  });
});

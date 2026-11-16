import { ReportRemindersService } from './report-reminders.service';

type Row = Record<string, unknown>;

function build(input: {
  opps: Row[];
  seats?: Row[];
  reports?: Row[];
  users?: Row[];
  existing?: Row[];
}) {
  const saved: Row[] = [...(input.existing ?? [])];
  const reminders = {
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        saved.find(
          (r) =>
            r.opportunityId === where.opportunityId &&
            r.email === where.email &&
            r.kind === where.kind,
        ) ?? null,
      ),
    ),
    find: jest.fn(() => Promise.resolve(saved)),
    create: jest.fn((r: Row) => ({
      ...r,
      createdAt: new Date('2026-11-16T03:00:00Z'),
    })),
    save: jest.fn((r: Row) => {
      if (!saved.includes(r)) saved.push(r);
      return Promise.resolve(r);
    }),
  };
  const opportunities = {
    find: jest.fn(({ where }: { where: Row }) => {
      const ids = (where?.id as { _value?: string[] } | undefined)?._value;
      const rows = input.opps.filter((o) =>
        where?.creatorId ? o.creatorId === where.creatorId : true,
      );
      return Promise.resolve(
        ids ? rows.filter((o) => ids.includes(String(o.id))) : rows,
      );
    }),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(input.opps.find((o) => o.id === where.id) ?? null),
    ),
  };
  const participations = {
    find: jest.fn(() => Promise.resolve(input.seats ?? [])),
  };
  const qb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(() => Promise.resolve(input.reports ?? [])),
  };
  const reports = { createQueryBuilder: jest.fn(() => qb) };
  const users = {
    find: jest.fn(() => Promise.resolve(input.users ?? [])),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        (input.users ?? []).find((u) => u.id === where.id) ?? null,
      ),
    ),
  };
  const mail = {
    sendReportCompletionReminder: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = {
    createNotification: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ReportRemindersService(
    reminders as never,
    opportunities as never,
    participations as never,
    reports as never,
    users as never,
    mail as never,
    notifications as never,
  );
  return { service, saved, mail, notifications, reminders };
}

const NOW = new Date('2026-11-05T05:00:00Z'); // 10:00 Karachi, 5 days after the end date

const liveOpp = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Campus Clean-Up',
  admin_approved: true,
  status: 'active',
  workflowStage: 'live',
  isStudentCreated: true,
  creatorId: 'stu-lead',
  createdAt: new Date('2026-09-01'),
  timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
};

describe('ReportRemindersService.runDue', () => {
  it('reminds the students whose report is not submitted, once per cadence step', async () => {
    const { service, mail, notifications, saved } = build({
      opps: [liveOpp],
      seats: [
        {
          id: 'seat-1',
          projectId: liveOpp.id,
          studentId: 'stu-a',
          email: 'a@uni.edu',
          fullName: 'Ayesha',
          student: { id: 'stu-a', email: 'a@uni.edu', name: 'Ayesha' },
        },
        {
          id: 'seat-2',
          projectId: liveOpp.id,
          studentId: 'stu-b',
          email: 'b@uni.edu',
          fullName: 'Bilal',
          student: { id: 'stu-b', email: 'b@uni.edu', name: 'Bilal' },
        },
      ],
      reports: [
        {
          id: 'rep-b',
          opportunityId: liveOpp.id,
          studentId: 'stu-b',
          status: 'submitted',
          reportSubmittedAt: new Date('2026-11-02'),
          student: { email: 'b@uni.edu' },
        },
      ],
      users: [{ id: 'stu-lead', email: 'lead@uni.edu', name: 'Lead Student' }],
    });

    const first = await service.runDue(NOW);
    expect(first).toMatchObject({
      today: '2026-11-05',
      sent: 2,
      skipped: 0,
      failed: 0,
    });
    expect(mail.sendReportCompletionReminder).toHaveBeenCalledTimes(2);
    expect(mail.sendReportCompletionReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@uni.edu',
        reportStarted: false,
        phase: 'reporting_window',
        daysLeft: 55,
        manual: false,
      }),
    );
    expect(mail.sendReportCompletionReminder).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'lead@uni.edu' }),
    );
    expect(notifications.createNotification).toHaveBeenCalledWith(
      'stu-a',
      expect.objectContaining({
        type: 'reminder',
        title: 'Complete your report ASAP',
      }),
    );
    expect(saved.map((r) => r.kind)).toEqual(['after_end_d1', 'after_end_d1']);

    // Same night again (or an overlapping run): nothing goes out twice.
    const second = await service.runDue(NOW);
    expect(second).toMatchObject({ sent: 0, skipped: 2 });
    expect(mail.sendReportCompletionReminder).toHaveBeenCalledTimes(2);
  });

  it('does nothing when disabled or when no project has a reminder due', async () => {
    process.env.REPORT_REMINDERS_DISABLED = 'true';
    try {
      const { service, mail } = build({ opps: [liveOpp] });
      expect((await service.runDue(NOW)).sent).toBe(0);
      expect(mail.sendReportCompletionReminder).not.toHaveBeenCalled();
    } finally {
      delete process.env.REPORT_REMINDERS_DISABLED;
    }
    const { service, mail } = build({
      opps: [
        {
          ...liveOpp,
          timeline: { start_date: '2027-01-01', end_date: '2027-02-01' },
        },
      ],
    });
    expect((await service.runDue(NOW)).sent).toBe(0);
    expect(mail.sendReportCompletionReminder).not.toHaveBeenCalled();
  });

  it('a mail failure is counted, recorded on the row and never thrown', async () => {
    const { service, mail, saved } = build({
      opps: [liveOpp],
      users: [{ id: 'stu-lead', email: 'lead@uni.edu', name: 'Lead Student' }],
    });
    mail.sendReportCompletionReminder.mockRejectedValue(new Error('smtp down'));
    const out = await service.runDue(NOW);
    // In-app notice still reached the account, so the reminder counts as sent.
    expect(out).toMatchObject({ sent: 1, failed: 0 });
    expect(saved[0]).toMatchObject({
      emailSent: false,
      notified: true,
      error: 'smtp down',
    });
  });
});

describe('ReportRemindersService.remindNow / summaries / student bar', () => {
  it('remind now sends the same message once per person per day and reports each recipient', async () => {
    const { service, mail, saved } = build({
      opps: [liveOpp],
      users: [{ id: 'stu-lead', email: 'lead@uni.edu', name: 'Lead Student' }],
    });
    const first = await service.remindNow(
      liveOpp.id,
      { role: 'faculty', email: 'prof@uni.edu' },
      undefined,
      NOW,
    );
    expect(first.sent).toBe(1);
    expect(first.recipients[0]).toMatchObject({
      email: 'lead@uni.edu',
      status: 'sent',
    });
    expect(saved[0]).toMatchObject({
      kind: 'manual_2026-11-05',
      channel: 'manual',
      triggeredBy: 'faculty:prof@uni.edu',
    });
    expect(mail.sendReportCompletionReminder).toHaveBeenCalledWith(
      expect.objectContaining({ manual: true }),
    );
    const again = await service.remindNow(
      liveOpp.id,
      { role: 'faculty' },
      undefined,
      NOW,
    );
    expect(again.skipped).toBe(1);
    expect(again.recipients[0].reason).toBe('already_reminded_today');
  });

  it('summaryByOpportunity counts delivered reminders per student and keeps the latest first', async () => {
    const { service } = build({
      opps: [liveOpp],
      existing: [
        {
          opportunityId: liveOpp.id,
          email: 'a@uni.edu',
          kind: 'after_end_d1',
          channel: 'auto',
          emailSent: true,
          createdAt: new Date('2026-11-09T00:00:00Z'),
        },
        {
          opportunityId: liveOpp.id,
          email: 'a@uni.edu',
          kind: 'after_end_d0',
          channel: 'auto',
          emailSent: true,
          createdAt: new Date('2026-11-01T00:00:00Z'),
        },
        {
          opportunityId: liveOpp.id,
          email: 'a@uni.edu',
          kind: 'manual_x',
          channel: 'manual',
          emailSent: false,
          notified: false,
          createdAt: new Date('2026-11-10T00:00:00Z'),
        },
      ],
    });
    const map = await service.summaryByOpportunity([liveOpp.id]);
    expect(
      map.get(ReportRemindersService.key(liveOpp.id, 'A@uni.edu')),
    ).toEqual({
      last_reminder_at: '2026-11-09T00:00:00.000Z',
      last_reminder_kind: 'after_end_d1',
      last_reminder_channel: 'auto',
      reminders_sent: 2,
    });
  });

  it('pendingForStudent lists the open reports with their deadline, urgent ones first', async () => {
    const soon = {
      ...liveOpp,
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Tree drive',
      creatorId: 'someone-else',
      isStudentCreated: false,
      timeline: { start_date: '2026-11-01', end_date: '2026-12-15' },
    };
    const { service } = build({
      opps: [liveOpp, soon],
      seats: [
        {
          id: 's',
          projectId: soon.id,
          studentId: 'stu-lead',
          status: 'approved',
        },
      ],
      reports: [
        {
          id: 'rep-lead',
          opportunityId: liveOpp.id,
          studentId: 'stu-lead',
          status: 'draft',
          section1: { team_lead: { name: 'Lead' } },
        },
      ],
      users: [{ id: 'stu-lead', email: 'lead@uni.edu', name: 'Lead Student' }],
    });
    const rows = await service.pendingForStudent('stu-lead', NOW);
    expect(rows.map((r) => [r.project_title, r.phase, r.urgent])).toEqual([
      ['Campus Clean-Up', 'reporting_window', true],
      ['Tree drive', 'in_progress', false],
    ]);
    expect(rows[0]).toMatchObject({
      report_id: 'rep-lead',
      days_left_to_report: 55,
      reporting_close_date: '2026-12-30',
      sections_total: 10,
    });
  });
});

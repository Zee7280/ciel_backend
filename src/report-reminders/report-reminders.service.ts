import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { User } from '../users/entities/user.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportCompletionReminder } from './entities/report-completion-reminder.entity';
import {
  computeReportProgress,
  isReportSubmittedStatus,
  type ReportProgress,
} from '../reports/report-progress.util';
import { karachiToday } from '../followups/followup.util';
import { communityServicePublicCode } from '../opportunities/opportunity-approval-tracker.util';
import {
  describeReportDeadline,
  dueReminderKind,
  type ReportDeadline,
} from './report-reminder.util';

/** Seats that count as "assigned" on a project (same list as faculty project tracking). */
export const REMINDER_SEAT_STATUSES = [
  'accepted',
  'approved',
  'verified',
  'paid',
  'pending_ciel_approval',
  'pending_faculty_approval',
  'pending_payment_approval',
  'finalized',
] as const;

export type ReportReminderRunResult = {
  today: string;
  opportunities_scanned: number;
  students_scanned: number;
  sent: number;
  skipped: number;
  failed: number;
};

export type ReminderRecipientResult = {
  email: string;
  name: string;
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
};

export type ReminderSummary = {
  last_reminder_at: string | null;
  last_reminder_kind: string | null;
  last_reminder_channel: 'auto' | 'manual' | null;
  reminders_sent: number;
};

/** What the student's own dashboard shows as the "complete your report" bar. */
export type StudentReportReminderRow = {
  opportunity_id: string;
  public_code: string;
  project_title: string;
  report_id: string | null;
  report_started: boolean;
  progress_pct: number;
  sections_complete: number;
  sections_total: number;
  phase: ReportDeadline['phase'];
  end_date: string | null;
  reporting_close_date: string | null;
  days_left_to_report: number | null;
  last_reminder_at: string | null;
  reminders_sent: number;
  urgent: boolean;
};

type Candidate = {
  opportunity: Opportunity;
  studentUserId: string | null;
  email: string;
  name: string;
  report: StudentReport | null;
  progress: ReportProgress | null;
};

type Actor = { role: string; email?: string | null; name?: string | null };

function lower(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function isRejectedOrDraft(opp: Opportunity): boolean {
  const status = lower(opp.status);
  const stage = lower(opp.workflowStage);
  return (
    status === 'rejected' ||
    stage === 'rejected' ||
    status === 'draft' ||
    stage === 'draft'
  );
}

@Injectable()
export class ReportRemindersService {
  private readonly logger = new Logger(ReportRemindersService.name);

  constructor(
    @InjectRepository(ReportCompletionReminder)
    private readonly reminders: Repository<ReportCompletionReminder>,
    @InjectRepository(Opportunity)
    private readonly opportunities: Repository<Opportunity>,
    @InjectRepository(Participation)
    private readonly participations: Repository<Participation>,
    @InjectRepository(StudentReport)
    private readonly reports: Repository<StudentReport>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /** `REPORT_REMINDERS_DISABLED=true` turns the nightly job off without a deploy. */
  enabled(): boolean {
    return process.env.REPORT_REMINDERS_DISABLED !== 'true';
  }

  /**
   * Nightly: every assigned student (or student creator) on a CIEL-approved project whose report
   * is not submitted gets the reminder that is due today (see dueReminderKind). Exactly-once per
   * student + project + cadence step. Never throws: failures are counted and retried next night.
   */
  async runDue(now: Date = new Date()): Promise<ReportReminderRunResult> {
    const today = karachiToday(now);
    const result: ReportReminderRunResult = {
      today,
      opportunities_scanned: 0,
      students_scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    };
    if (!this.enabled()) return result;

    const opps = (
      await this.opportunities.find({ where: { admin_approved: true } })
    ).filter((opp) => !isRejectedOrDraft(opp));
    result.opportunities_scanned = opps.length;

    // Only projects where some reminder can be due today need their people loaded.
    const due = opps
      .map((opp) => ({
        opp,
        deadline: describeReportDeadline(opp.timeline, today),
      }))
      .filter(
        ({ deadline }) =>
          deadline.phase === 'reporting_window' ||
          deadline.phase === 'in_progress',
      );
    if (!due.length) return result;

    const candidatesByOpp = await this.loadCandidates(due.map((d) => d.opp));
    for (const { opp, deadline } of due) {
      for (const candidate of candidatesByOpp.get(opp.id) ?? []) {
        result.students_scanned += 1;
        if (this.isSubmitted(candidate.report)) continue;
        const started = Boolean(
          candidate.report && (candidate.progress?.progress_pct ?? 0) > 0,
        );
        const kind = dueReminderKind(deadline, today, started);
        if (!kind) continue;
        const outcome = await this.sendOne(candidate, deadline, kind, 'auto');
        result[outcome] += 1;
      }
    }
    this.logger.log(
      `Report reminders ${today}: sent=${result.sent} skipped=${result.skipped} failed=${result.failed} (projects=${result.opportunities_scanned}, students=${result.students_scanned})`,
    );
    return result;
  }

  /**
   * A reviewer's "Remind now": the same automatic message, to every student on the project whose
   * report is not submitted (or one student by email). Once per person per day.
   */
  async remindNow(
    opportunityId: string,
    actor: Actor,
    studentEmail?: string | null,
    now: Date = new Date(),
  ): Promise<{
    opportunity_id: string;
    sent: number;
    skipped: number;
    failed: number;
    recipients: ReminderRecipientResult[];
  }> {
    const today = karachiToday(now);
    const opp = await this.opportunities.findOne({
      where: { id: opportunityId },
    });
    const out = {
      opportunity_id: opportunityId,
      sent: 0,
      skipped: 0,
      failed: 0,
      recipients: [] as ReminderRecipientResult[],
    };
    if (!opp) return out;
    const deadline = describeReportDeadline(opp.timeline, today);
    const wanted = lower(studentEmail);
    const candidates = (
      (await this.loadCandidates([opp])).get(opp.id) ?? []
    ).filter((c) => !wanted || c.email === wanted);
    const triggeredBy = `${actor.role}:${actor.email || actor.name || 'unknown'}`;
    for (const candidate of candidates) {
      if (this.isSubmitted(candidate.report)) {
        out.skipped += 1;
        out.recipients.push({
          email: candidate.email,
          name: candidate.name,
          status: 'skipped',
          reason: 'report_submitted',
        });
        continue;
      }
      const status = await this.sendOne(
        candidate,
        deadline,
        `manual_${today}`,
        'manual',
        triggeredBy,
      );
      out[status] += 1;
      out.recipients.push({
        email: candidate.email,
        name: candidate.name,
        status,
        reason: status === 'skipped' ? 'already_reminded_today' : undefined,
      });
    }
    return out;
  }

  /** Last / count of reminders per (project, student email) for tracking rows. */
  async summaryByOpportunity(
    opportunityIds: string[],
  ): Promise<Map<string, ReminderSummary>> {
    const map = new Map<string, ReminderSummary>();
    const ids = [...new Set(opportunityIds.filter(Boolean))];
    if (!ids.length) return map;
    const rows = await this.reminders.find({
      where: { opportunityId: In(ids) },
      order: { createdAt: 'DESC' },
    });
    for (const row of rows) {
      if (!row.emailSent && !row.notified) continue;
      const key = ReportRemindersService.key(row.opportunityId, row.email);
      const cur = map.get(key);
      if (!cur) {
        map.set(key, {
          last_reminder_at: row.createdAt.toISOString(),
          last_reminder_kind: row.kind,
          last_reminder_channel: row.channel,
          reminders_sent: 1,
        });
      } else {
        cur.reminders_sent += 1;
      }
    }
    return map;
  }

  static key(opportunityId: string, email: string): string {
    return `${opportunityId}|${lower(email)}`;
  }

  /** The signed-in student's own open reports with their deadline, for the dashboard bar. */
  async pendingForStudent(
    userId: string,
    now: Date = new Date(),
  ): Promise<StudentReportReminderRow[]> {
    const today = karachiToday(now);
    const me = await this.users.findOne({
      where: { id: userId },
      select: ['id', 'email', 'name'],
    });
    if (!me) return [];
    const seats = await this.participations.find({
      where: { studentId: userId, status: In([...REMINDER_SEAT_STATUSES]) },
    });
    const oppIds = new Set(seats.map((s) => s.projectId).filter(Boolean));
    const created = await this.opportunities.find({
      where: { creatorId: userId, admin_approved: true },
    });
    for (const opp of created) oppIds.add(opp.id);
    if (!oppIds.size) return [];
    const opps = (
      await this.opportunities.find({ where: { id: In([...oppIds]) } })
    ).filter((opp) => opp.admin_approved === true && !isRejectedOrDraft(opp));
    if (!opps.length) return [];
    const reports = await this.reports
      .createQueryBuilder('report')
      .where('report."studentId" = :userId', { userId })
      .andWhere(
        '(report."opportunityId"::text IN (:...ids) OR TRIM(COALESCE(report.project_id, \'\')) IN (:...ids))',
        { ids: opps.map((o) => o.id) },
      )
      .getMany();
    const summary = await this.summaryByOpportunity(opps.map((o) => o.id));
    const rows: StudentReportReminderRow[] = [];
    for (const opp of opps) {
      const report =
        reports.find(
          (r) =>
            String(r.opportunityId || '') === opp.id ||
            String(r.project_id || '').trim() === opp.id,
        ) ?? null;
      if (this.isSubmitted(report)) continue;
      const deadline = describeReportDeadline(opp.timeline, today);
      if (deadline.phase === 'before_start' || deadline.phase === 'closed')
        continue;
      const progress = report ? computeReportProgress(report) : null;
      const sum = summary.get(ReportRemindersService.key(opp.id, me.email));
      rows.push({
        opportunity_id: opp.id,
        public_code: communityServicePublicCode(opp.id, opp.createdAt),
        project_title: opp.title || 'Community service',
        report_id: report?.id ?? null,
        report_started: Boolean(report && (progress?.progress_pct ?? 0) > 0),
        progress_pct: progress?.progress_pct ?? 0,
        sections_complete: progress?.sections_complete ?? 0,
        sections_total: progress?.sections_total ?? 10,
        phase: deadline.phase,
        end_date: deadline.end_date,
        reporting_close_date: deadline.reporting_close_date,
        days_left_to_report: deadline.days_left_to_report,
        last_reminder_at: sum?.last_reminder_at ?? null,
        reminders_sent: sum?.reminders_sent ?? 0,
        urgent: deadline.phase === 'reporting_window',
      });
    }
    return rows.sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return (a.days_left_to_report ?? 9999) - (b.days_left_to_report ?? 9999);
    });
  }

  private isSubmitted(report: StudentReport | null): boolean {
    return Boolean(
      report &&
      isReportSubmittedStatus(report.status, report.reportSubmittedAt),
    );
  }

  /** Assigned seats plus student creators, one entry per email per project, with their report. */
  private async loadCandidates(
    opps: Opportunity[],
  ): Promise<Map<string, Candidate[]>> {
    const byOpp = new Map<string, Candidate[]>();
    if (!opps.length) return byOpp;
    const ids = opps.map((o) => o.id);
    const [seats, reports] = await Promise.all([
      this.participations.find({
        where: { projectId: In(ids), status: In([...REMINDER_SEAT_STATUSES]) },
        relations: ['student'],
      }),
      this.reports
        .createQueryBuilder('report')
        .leftJoinAndSelect('report.student', 'student')
        .where(
          '(report."opportunityId"::text IN (:...ids) OR TRIM(COALESCE(report.project_id, \'\')) IN (:...ids))',
          { ids },
        )
        .getMany(),
    ]);
    const creatorIds = [
      ...new Set(
        opps
          .filter((o) => o.isStudentCreated && o.creatorId)
          .map((o) => o.creatorId),
      ),
    ];
    const creators = creatorIds.length
      ? await this.users.find({
          where: { id: In(creatorIds) },
          select: ['id', 'name', 'email'],
        })
      : [];
    const creatorById = new Map(creators.map((u) => [u.id, u]));

    const reportFor = (
      oppId: string,
      studentId: string | null,
      email: string,
    ): StudentReport | null => {
      const pool = reports.filter(
        (r) =>
          String(r.opportunityId || '') === oppId ||
          String(r.project_id || '').trim() === oppId,
      );
      return (
        pool.find(
          (r) => studentId && String(r.studentId || '') === studentId,
        ) ??
        pool.find((r) => email && lower(r.student?.email) === email) ??
        null
      );
    };

    for (const opp of opps) {
      const list: Candidate[] = [];
      const seen = new Set<string>();
      const add = (
        studentUserId: string | null,
        email: string,
        name: string,
      ) => {
        const e = lower(email);
        if (!e || !e.includes('@') || seen.has(e)) return;
        seen.add(e);
        const report = reportFor(opp.id, studentUserId, e);
        list.push({
          opportunity: opp,
          studentUserId: studentUserId || report?.studentId || null,
          email: e,
          name: name || report?.student?.name || 'Student',
          report,
          progress: report ? computeReportProgress(report) : null,
        });
      };
      for (const seat of seats) {
        if (seat.projectId !== opp.id) continue;
        add(
          seat.studentId || seat.student?.id || null,
          seat.student?.email || seat.email || '',
          seat.student?.name || seat.fullName || '',
        );
      }
      if (opp.isStudentCreated && opp.creatorId) {
        const creator = creatorById.get(opp.creatorId);
        if (creator) add(creator.id, creator.email, creator.name);
      }
      byOpp.set(opp.id, list);
    }
    return byOpp;
  }

  /** Records the reminder first (unique key = exactly-once), then emails and notifies. */
  private async sendOne(
    candidate: Candidate,
    deadline: ReportDeadline,
    kind: string,
    channel: 'auto' | 'manual',
    triggeredBy: string | null = null,
  ): Promise<'sent' | 'skipped' | 'failed'> {
    const opp = candidate.opportunity;
    const existing = await this.reminders.findOne({
      where: { opportunityId: opp.id, email: candidate.email, kind },
    });
    if (existing) return 'skipped';
    let row: ReportCompletionReminder;
    try {
      row = await this.reminders.save(
        this.reminders.create({
          opportunityId: opp.id,
          studentUserId: candidate.studentUserId,
          email: candidate.email,
          kind,
          channel,
          triggeredBy,
        }),
      );
    } catch (error) {
      // Another run inserted the same key a moment ago.
      this.logger.warn(
        `Report reminder already recorded (${opp.id}, ${candidate.email}, ${kind}): ${(error as Error).message}`,
      );
      return 'skipped';
    }

    const reportPath = `/dashboard/student/report?projectId=${encodeURIComponent(opp.id)}`;
    const publicCode = communityServicePublicCode(opp.id, opp.createdAt);
    const progress = candidate.progress;
    const started = Boolean(
      candidate.report && (progress?.progress_pct ?? 0) > 0,
    );
    let emailSent = false;
    let notified = false;
    let errorText: string | null = null;
    try {
      await this.mailService.sendReportCompletionReminder({
        to: candidate.email,
        studentName: candidate.name,
        projectTitle: opp.title || 'Community service',
        publicCode,
        reportStarted: started,
        progressPct: progress?.progress_pct ?? 0,
        sectionsComplete: progress?.sections_complete ?? 0,
        sectionsTotal: progress?.sections_total ?? 10,
        phase: deadline.phase,
        endDate: deadline.end_date,
        reportingCloseDate: deadline.reporting_close_date,
        daysLeft: deadline.days_left_to_report,
        reportPath,
        manual: channel === 'manual',
      });
      emailSent = true;
    } catch (error) {
      errorText = (error as Error).message;
    }
    if (candidate.studentUserId) {
      try {
        await this.notificationsService.createNotification(
          candidate.studentUserId,
          {
            type: 'reminder',
            title: 'Complete your report ASAP',
            message: this.notificationMessage(
              opp.title || 'Community service',
              deadline,
              started,
              progress,
            ),
          },
        );
        notified = true;
      } catch (error) {
        errorText = errorText || (error as Error).message;
      }
    }
    row.emailSent = emailSent;
    row.notified = notified;
    row.error = errorText;
    await this.reminders.save(row);
    if (!emailSent && !notified) {
      this.logger.error(
        `Report reminder failed for ${candidate.email} on ${opp.id}: ${errorText}`,
      );
      return 'failed';
    }
    return 'sent';
  }

  private notificationMessage(
    title: string,
    deadline: ReportDeadline,
    started: boolean,
    progress: ReportProgress | null,
  ): string {
    const state = started
      ? `Your report is ${progress?.progress_pct ?? 0}% filled (${progress?.sections_complete ?? 0} of ${progress?.sections_total ?? 10} sections).`
      : 'Your report has not been started yet.';
    const when =
      deadline.phase === 'reporting_window' &&
      deadline.days_left_to_report != null
        ? `The project has ended and ${deadline.days_left_to_report} day${deadline.days_left_to_report === 1 ? '' : 's'} remain in the reporting window${deadline.reporting_close_date ? ` (closes ${deadline.reporting_close_date})` : ''}.`
        : 'Keep logging hours and evidence as you go, and submit as soon as the project ends.';
    return `"${title}": ${state} ${when} Open My Reports to continue.`;
  }
}

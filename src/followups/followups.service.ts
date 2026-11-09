import {
  BadRequestException,
  ConflictException,
  GoneException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Brackets, In, Repository } from 'typeorm';
import { StudentReport } from '../reports/entities/student-report.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AiService } from '../ai/ai.service';
import {
  FOLLOW_UP_ACTIVE_STATUSES,
  ReportFollowUp,
  type FollowUpStatus,
} from './entities/report-follow-up.entity';
import {
  FollowUpQuestion,
  type FollowUpQuestionOrigin,
} from './entities/follow-up-question.entity';
import {
  FollowUpDispatch,
  type FollowUpDispatchKind,
} from './entities/follow-up-dispatch.entity';
import { FollowUpAnswer } from './entities/follow-up-answer.entity';
import {
  FollowUpOptOut,
  type FollowUpOptOutSource,
} from './entities/follow-up-opt-out.entity';
import {
  addDaysIso,
  buildProjectReference,
  csvCell,
  decideDispatch,
  isIsoDate,
  summarizeOutcomes,
  type FollowUpOutcomeSummary,
  type NormalizedMailEvent,
  followUpIntervalLabel,
  followUpIntro,
  followUpSubject,
  generateFollowUpQuestions,
  normalizeIsoDate,
  hashFollowUpToken,
  karachiToday,
  MAX_FOLLOWUP_QUESTIONS,
  newFollowUpToken,
  resolveFollowUpDueDate,
  resolveProjectEndDate,
  tokenLooksValid,
  type GeneratedFollowUpQuestion,
} from './followup.util';
import type {
  AdminActivateFollowUpDto,
  AdminFollowUpListQueryDto,
  AdminFollowUpQuestionsDto,
  FollowUpPreviewDto,
  SubmitFollowUpResponseDto,
} from './dto/follow-up.dto';

type Actor = { id?: string; name?: string; email?: string } | null | undefined;

/** CIEL PK's own recipient / date for a follow-up (9.5 "Not decided yet", or a replaced contact). */
type ActivationOverrides = {
  recipientName?: string;
  recipientEmail?: string;
  recipientRole?: string;
  dueDate?: string;
};

export type FollowUpTrackerRow = {
  id: string;
  reportId: string;
  reportPublicId: string;
  projectTitle: string;
  studentName: string;
  studentEmail: string;
  recipientName: string;
  recipientEmail: string;
  recipientRole: string;
  status: FollowUpStatus;
  decidedByAdmin: boolean;
  dueDate: string;
  intervalLabel: string;
  emailsSent: number;
  lastSentAt: Date | null;
  lastDelivery: string;
  respondedAt: Date | null;
  respondentName: string;
  declinedAt: Date | null;
  reviewedAt: Date | null;
  lastError: string;
  outcome: FollowUpOutcomeSummary;
  activatedAt: Date | null;
};
type Rec = Record<string, unknown>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Trimmed string of a saved wizard field; anything that is not a string reads as blank. */
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const MAX_SEND_ATTEMPTS = 3;
/** A pending dispatch older than this belongs to a worker that died; it may be claimed again. */
const STALE_CLAIM_MS = 15 * 60_000;
/** Published states in which a follow-up may still be mailed. */
const PUBLISHED_REPORT_STATUSES = new Set(['verified', 'paid']);

export type FollowUpDispatchRunResult = {
  enabled: boolean;
  today: string;
  scanned: number;
  sent: number;
  failed: number;
  expired: number;
  cancelled: number;
  skipped: number;
};

@Injectable()
export class FollowUpsService {
  private readonly logger = new Logger(FollowUpsService.name);

  constructor(
    @InjectRepository(ReportFollowUp)
    private readonly followUps: Repository<ReportFollowUp>,
    @InjectRepository(FollowUpQuestion)
    private readonly questions: Repository<FollowUpQuestion>,
    @InjectRepository(FollowUpDispatch)
    private readonly dispatches: Repository<FollowUpDispatch>,
    @InjectRepository(FollowUpAnswer)
    private readonly answers: Repository<FollowUpAnswer>,
    @InjectRepository(StudentReport)
    private readonly reports: Repository<StudentReport>,
    @InjectRepository(FollowUpOptOut)
    private readonly optOuts: Repository<FollowUpOptOut>,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly auditLogs?: AuditLogsService,
    @Optional() private readonly aiService?: AiService,
  ) {}

  // ---------------------------------------------------------------- settings

  private intEnv(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = Number(this.configService.get<string>(key));
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  }

  private reminderDays(): { reminder1Days: number; reminder2Days: number } {
    const reminder1Days = this.intEnv('FOLLOWUP_REMINDER1_DAYS', 7, 1, 60);
    const reminder2Days = Math.max(
      reminder1Days + 1,
      this.intEnv('FOLLOWUP_REMINDER2_DAYS', 14, 2, 90),
    );
    return { reminder1Days, reminder2Days };
  }

  private tokenTtlDays(): number {
    return this.intEnv('FOLLOWUP_TOKEN_TTL_DAYS', 60, 7, 365);
  }

  dispatchEnabled(): boolean {
    return (
      String(
        this.configService.get<string>('FOLLOWUP_DISPATCH_ENABLED') ?? 'true',
      )
        .trim()
        .toLowerCase() !== 'false'
    );
  }

  private aiQuestionsEnabled(): boolean {
    return (
      String(this.configService.get<string>('FOLLOWUP_AI_QUESTIONS') ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  private frontendBase(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') || 'https://cielpk.com'
    ).replace(/\/+$/, '');
  }

  private reviewLink(token: string): string {
    return `${this.frontendBase()}/verify/follow-up?token=${encodeURIComponent(token)}`;
  }

  private declineLink(token: string): string {
    return `${this.reviewLink(token)}&action=decline`;
  }

  private async audit(
    action: string,
    actor: Actor,
    target: string,
    details: Rec,
  ): Promise<void> {
    if (!this.auditLogs) return;
    try {
      await this.auditLogs.recordMutation({
        action,
        user: actor?.name || actor?.id || null,
        user_email: actor?.email || null,
        target,
        target_type: 'report_follow_up',
        details,
      });
    } catch (err) {
      this.logger.warn(
        `Follow-up audit write failed: ${(err as Error)?.message}`,
      );
    }
  }

  // ---------------------------------------------------------------- activation (admin approve)

  private loadReport(reportId: string): Promise<StudentReport | null> {
    return this.reports.findOne({
      where: { id: reportId },
      relations: ['opportunity', 'opportunity.organization'],
    });
  }

  /** Emails already sent in the follow-up's current recipient cycle. */
  private sentDispatches(
    followUpId: string,
    cycle: number,
  ): Promise<FollowUpDispatch[]> {
    return this.dispatches.find({
      where: { followUpId, status: 'sent', cycle },
      select: ['id', 'kind', 'sentAt', 'scheduledFor'],
      order: { sentAt: 'ASC' },
    });
  }

  /** Kinds already mailed in the follow-up's current recipient cycle. */
  private async sentKinds(
    followUpId: string,
    cycle: number,
  ): Promise<Set<FollowUpDispatchKind>> {
    const rows = await this.sentDispatches(followUpId, cycle);
    return new Set(rows.map((r) => r.kind));
  }

  /**
   * Called when CIEL PK publishes a report. Idempotent: a second approve refreshes a not-yet-mailed
   * follow-up, leaves a mailed one alone and never duplicates. A report whose student answered
   * "No" / "Not decided yet" gets nothing (and any earlier scheduled follow-up is cancelled).
   */
  async activateForReport(
    reportId: string,
    actor?: Actor,
    overrides?: ActivationOverrides,
  ): Promise<ReportFollowUp | null> {
    const report = await this.loadReport(reportId);
    if (!report) return null;
    const s10 = ((report.section10 || {}) as unknown as Rec) ?? {};
    const plan = str(s10.followup_plan);
    const existing = await this.followUps.findOne({ where: { reportId } });
    const adminDecided = Boolean(overrides && str(overrides.recipientEmail));

    if (plan !== 'yes' && !adminDecided && !existing?.decidedByAdmin) {
      if (existing && FOLLOW_UP_ACTIVE_STATUSES.includes(existing.status)) {
        await this.cancel(existing, 'student_chose_no_followup', actor);
      }
      return null;
    }
    // Answered: nothing to redo. Declined / expired: only CIEL PK naming a new contact reopens it.
    if (
      existing &&
      (existing.status === 'responded' ||
        ((existing.status === 'declined' || existing.status === 'expired') &&
          !adminDecided))
    ) {
      return existing;
    }

    // Admin-supplied recipient / date win; otherwise the student's 9.5 answers (or, when CIEL PK
    // decided this follow-up earlier, what is already stored on it).
    const keepStored = Boolean(existing?.decidedByAdmin) && !adminDecided;
    const recipientEmail = adminDecided
      ? str(overrides?.recipientEmail).toLowerCase()
      : keepStored
        ? existing!.recipientEmail
        : str(s10.followup_owner_email).toLowerCase();
    const recipientName = adminDecided
      ? str(overrides?.recipientName)
      : keepStored
        ? existing!.recipientName
        : str(s10.followup_owner_name);
    const recipientRole = adminDecided
      ? str(overrides?.recipientRole)
      : keepStored
        ? existing!.recipientRole
        : str(s10.followup_owner_role);
    const projectEndDate = resolveProjectEndDate(report.opportunity);
    const today = karachiToday();
    let dueDate = isIsoDate(overrides?.dueDate)
      ? overrides.dueDate
      : keepStored && existing!.dueDate
        ? existing!.dueDate
        : resolveFollowUpDueDate(s10, projectEndDate) ||
          (adminDecided ? today : '');
    const problems: string[] = [];
    if (!EMAIL_RE.test(recipientEmail))
      problems.push('Recipient email is missing or invalid');
    else if (await this.isOptedOut(recipientEmail))
      problems.push(
        'This address opted out of CIEL PK follow-up emails (or bounced); choose another contact',
      );
    if (!dueDate) problems.push('No follow-up date could be determined');
    // A date already in the past (late approval) means "send on the next run".
    if (dueDate && dueDate < today) dueDate = today;

    const fu = existing ?? this.followUps.create({ reportId });
    if (!fu.cycle) fu.cycle = 1;
    const sent = existing
      ? await this.sentKinds(existing.id, existing.cycle || 1)
      : new Set<FollowUpDispatchKind>();
    let alreadyMailed = sent.size > 0;
    // A new contact after mail already went out starts a fresh cycle: the new person gets the
    // initial email (never a "reminder"), on the next run unless CIEL PK picked a date.
    const retarget =
      adminDecided &&
      Boolean(existing?.recipientEmail) &&
      existing!.recipientEmail.toLowerCase() !== recipientEmail;
    const reopening =
      Boolean(existing) &&
      (existing!.status === 'declined' || existing!.status === 'expired');
    if (retarget && (alreadyMailed || reopening)) {
      fu.cycle += 1;
      sent.clear();
      alreadyMailed = false;
      if (!isIsoDate(overrides?.dueDate)) dueDate = today;
      // The previous contact's links must stop working for the new person's follow-up.
      fu.tokenHash = hashFollowUpToken(newFollowUpToken());
      fu.previousTokenHashes = [];
      fu.tokenExpiresAt = null;
      fu.declinedAt = null;
      fu.declineReason = '';
    }
    const { reminder1Days, reminder2Days } = this.reminderDays();

    fu.opportunityId = report.opportunityId || null;
    fu.studentId = report.studentId || null;
    fu.projectRef = buildProjectReference(
      report as unknown as Rec,
      report.opportunity,
    );
    fu.checkFocus = [s10.followup_check, s10.followup_check_notes]
      .map(str)
      .filter(Boolean)
      .join(' — ');
    fu.activatedAt = new Date();
    fu.activatedBy = actor?.name || actor?.id || null;
    if (adminDecided) fu.decidedByAdmin = true;
    if (!alreadyMailed || adminDecided) {
      // Nothing went out yet (or CIEL PK re-targeted it): the latest recipient / date wins.
      fu.recipientEmail = recipientEmail;
      fu.recipientName = recipientName;
      fu.recipientRole = recipientRole;
      fu.dueDate = dueDate;
      fu.projectEndDate = projectEndDate;
      fu.intervalLabel = adminDecided
        ? 'date set by CIEL PK'
        : keepStored
          ? existing!.intervalLabel
          : followUpIntervalLabel(s10);
      fu.reminder1Days = reminder1Days;
      fu.reminder2Days = reminder2Days;
    }
    if (!fu.tokenHash) {
      fu.tokenHash = hashFollowUpToken(newFollowUpToken());
      fu.previousTokenHashes = [];
    }
    // Link validity starts when the first email actually goes out (set in sendDispatch), so a
    // follow-up that was never mailed can never "expire".
    if (problems.length) {
      fu.status = 'needs_attention';
      fu.lastError = problems.join('; ');
    } else {
      fu.lastError = '';
      fu.status = alreadyMailed
        ? sent.has('reminder1') || sent.has('reminder2')
          ? 'reminded'
          : 'sent'
        : 'scheduled';
      fu.cancelledAt = null;
      fu.cancelReason = '';
    }
    const saved = await this.followUps.save(fu);

    const questionCount = await this.questions.count({
      where: { followUpId: saved.id },
    });
    if (questionCount === 0 || (!saved.questionsEditedAt && !alreadyMailed)) {
      await this.replaceQuestions(
        saved,
        await this.generateQuestions(report, saved),
      );
    }

    await this.audit('REPORT_FOLLOWUP_ACTIVATED', actor, saved.id, {
      reportId,
      status: saved.status,
      dueDate: saved.dueDate,
      recipientEmail: saved.recipientEmail,
      problems,
    });
    return saved;
  }

  private async generateQuestions(
    report: StudentReport,
    fu: ReportFollowUp,
  ): Promise<
    Array<
      GeneratedFollowUpQuestion & { generatedBy: 'rules' | 'ai' | 'student' }
    >
  > {
    const data = report as unknown as Rec;
    // The student may have reviewed / edited the questions on 9.5; an included set wins.
    const studentSet = this.studentQuestions(data);
    if (studentSet.length) return studentSet;
    if (this.aiQuestionsEnabled() && this.aiService) {
      try {
        const s4 = (data.section4 || {}) as Rec;
        const s5 = (data.section5 || {}) as Rec;
        const ai = await this.aiService.generateFollowUpQuestionDraft({
          projectRef: (fu.projectRef || {}) as unknown as Rec,
          activities: Array.isArray(s4.activity_blocks)
            ? s4.activity_blocks
            : [],
          outcomes: Array.isArray(s5.measurable_outcomes)
            ? s5.measurable_outcomes
            : [],
          sustainability: (data.section10 || {}) as Rec,
          maxQuestions: MAX_FOLLOWUP_QUESTIONS,
        });
        // The model's activity ids are only trusted when they name a real Section 4 block.
        const knownIds = new Set(
          (Array.isArray(s4.activity_blocks) ? s4.activity_blocks : [])
            .map((b, i) => str((b as Rec)?.id) || `activity-${i + 1}`)
            .filter(Boolean),
        );
        if (ai.length)
          return ai.map((q) => ({
            ...q,
            activityId:
              q.activityId && knownIds.has(q.activityId) ? q.activityId : null,
            generatedBy: 'ai' as const,
          }));
      } catch (err) {
        this.logger.warn(
          `AI follow-up questions unavailable for report ${report.id}; using rules: ${(err as Error)?.message}`,
        );
      }
    }
    return generateFollowUpQuestions(data).map((q) => ({
      ...q,
      generatedBy: 'rules' as const,
    }));
  }

  /** Questions the student kept / wrote on 9.5 (included, non-empty), in their order, max 10. */
  private studentQuestions(
    data: Rec,
  ): Array<GeneratedFollowUpQuestion & { generatedBy: 'student' }> {
    const s10 = (data.section10 || {}) as Rec;
    const raw = Array.isArray(s10.followup_questions)
      ? (s10.followup_questions as unknown[])
      : [];
    const s4 = (data.section4 || {}) as Rec;
    const blocks = Array.isArray(s4.activity_blocks)
      ? (s4.activity_blocks as unknown[])
      : [];
    const knownIds = new Set(
      blocks.map((b, i) => str((b as Rec)?.id) || `activity-${i + 1}`),
    );
    const out: Array<GeneratedFollowUpQuestion & { generatedBy: 'student' }> =
      [];
    for (const item of raw) {
      const q = (item && typeof item === 'object' ? item : {}) as Rec;
      if (q.include === false) continue;
      const questionText = str(q.questionText).slice(0, 600);
      if (questionText.length < 5) continue;
      const activityId = str(q.activityId);
      out.push({
        activityId: activityId && knownIds.has(activityId) ? activityId : null,
        activityTitle: (str(q.activityTitle) || 'Project activity').slice(
          0,
          240,
        ),
        questionText,
        countLabel: str(q.countLabel) ? str(q.countLabel).slice(0, 160) : null,
        sourceFieldIds: ['section10.followup_questions'],
        reason:
          q.source === 'student'
            ? 'Written by the student on 9.5'
            : 'Suggested question kept by the student on 9.5',
        generatedBy: 'student',
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  private async replaceQuestions(
    fu: ReportFollowUp,
    generated: Array<
      GeneratedFollowUpQuestion & { generatedBy: FollowUpQuestionOrigin }
    >,
  ): Promise<void> {
    await this.questions.delete({ followUpId: fu.id });
    await this.questions.save(
      generated.map((q, i) =>
        this.questions.create({
          followUpId: fu.id,
          activityId: q.activityId,
          activityTitle: q.activityTitle.slice(0, 240),
          questionText: q.questionText,
          countLabel: q.countLabel ? q.countLabel.slice(0, 160) : null,
          sourceFieldIds: q.sourceFieldIds,
          reason: q.reason,
          include: true,
          displayOrder: i,
          generatedBy: q.generatedBy,
        }),
      ),
    );
  }

  private async cancel(
    fu: ReportFollowUp,
    reason: string,
    actor?: Actor,
  ): Promise<ReportFollowUp> {
    fu.status = 'cancelled';
    fu.cancelledAt = new Date();
    fu.cancelReason = reason;
    const saved = await this.followUps.save(fu);
    await this.audit('REPORT_FOLLOWUP_CANCELLED', actor, fu.id, {
      reportId: fu.reportId,
      reason,
    });
    return saved;
  }

  /** Report sent back / unlocked / closed: nothing more goes out until it is published again. */
  async cancelForReport(
    reportId: string,
    reason: string,
    actor?: Actor,
  ): Promise<void> {
    const fu = await this.followUps.findOne({ where: { reportId } });
    if (!fu) return;
    if (
      !FOLLOW_UP_ACTIVE_STATUSES.includes(fu.status) &&
      fu.status !== 'needs_attention'
    )
      return;
    await this.cancel(fu, reason, actor);
  }

  // ---------------------------------------------------------------- scheduler

  /** Nightly: send whatever is due today (Asia/Karachi), exactly once per follow-up + kind. */
  async dispatchDue(
    now: Date = new Date(),
  ): Promise<FollowUpDispatchRunResult> {
    const today = karachiToday(now);
    const result: FollowUpDispatchRunResult = {
      enabled: this.dispatchEnabled(),
      today,
      scanned: 0,
      sent: 0,
      failed: 0,
      expired: 0,
      cancelled: 0,
      skipped: 0,
    };
    if (!result.enabled) return result;

    const rows = await this.followUps.find({
      where: { status: In(FOLLOW_UP_ACTIVE_STATUSES) },
      order: { dueDate: 'ASC' },
    });
    for (const fu of rows) {
      result.scanned += 1;
      try {
        const report = await this.reports.findOne({
          where: { id: fu.reportId },
          select: ['id', 'status', 'admin_status'],
        });
        const published =
          !!report &&
          (PUBLISHED_REPORT_STATUSES.has(
            String(report.status || '').toLowerCase(),
          ) ||
            String(report.admin_status || '').toLowerCase() === 'approved');
        if (!published) {
          await this.cancel(fu, 'report_not_published');
          result.cancelled += 1;
          continue;
        }
        const sentRows = await this.sentDispatches(fu.id, fu.cycle);
        const sent = new Set(sentRows.map((r) => r.kind));
        const initial = sentRows.find((r) => r.kind === 'initial');
        // Only a follow-up that was actually asked can run out of time ("no response").
        if (
          initial &&
          fu.tokenExpiresAt &&
          now.getTime() > fu.tokenExpiresAt.getTime()
        ) {
          fu.status = 'expired';
          await this.followUps.save(fu);
          result.expired += 1;
          continue;
        }
        const kind = decideDispatch({
          today,
          dueDate: fu.dueDate,
          reminder1Days: fu.reminder1Days,
          reminder2Days: fu.reminder2Days,
          sent,
          // The Karachi run-date that sent the initial email (sentAt is the wall clock).
          initialSentOn: initial
            ? initial.scheduledFor ||
              (initial.sentAt ? karachiToday(initial.sentAt) : undefined)
            : undefined,
        });
        if (!kind) {
          result.skipped += 1;
          continue;
        }
        const outcome = await this.sendDispatch(fu, kind, today);
        if (outcome === 'sent') result.sent += 1;
        else if (outcome === 'failed') result.failed += 1;
        else result.skipped += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.error(
          `Follow-up ${fu.id} dispatch error: ${(err as Error)?.message}`,
          (err as Error)?.stack,
        );
      }
    }
    return result;
  }

  /**
   * One email. The dispatch row (unique idempotency key) is claimed before sending, so overlapping
   * workers cannot both mail; a failed send is retried on later runs up to MAX_SEND_ATTEMPTS.
   */
  private async sendDispatch(
    fu: ReportFollowUp,
    kind: FollowUpDispatchKind,
    scheduledFor: string,
    actor?: Actor,
  ): Promise<'sent' | 'failed' | 'skipped'> {
    // Opt-out / bounce list wins over any schedule: park the follow-up for the admin instead.
    if (await this.isOptedOut(fu.recipientEmail)) {
      fu.status = 'needs_attention';
      fu.lastError = `${fu.recipientEmail} opted out of CIEL PK follow-up emails or bounced; choose another contact`;
      await this.followUps.save(fu);
      await this.audit('REPORT_FOLLOWUP_SEND_BLOCKED', actor, fu.id, {
        reportId: fu.reportId,
        kind,
        to: fu.recipientEmail,
        reason: 'opted_out',
      });
      return 'failed';
    }
    const cycle = fu.cycle || 1;
    const key =
      kind === 'manual'
        ? `${fu.id}:c${cycle}:manual:${Date.now()}`
        : `${fu.id}:c${cycle}:${kind}`;
    // Claim the send atomically: a new row (unique key) or a conditional UPDATE of a failed /
    // stale-pending row. Two workers (second cron instance, admin "send now") can never both win.
    let row = await this.dispatches.findOne({ where: { idempotencyKey: key } });
    if (row?.status === 'sent') return 'skipped';
    if (row && row.attempts >= MAX_SEND_ATTEMPTS) return 'skipped';
    if (!row) {
      try {
        row = await this.dispatches.save(
          this.dispatches.create({
            followUpId: fu.id,
            kind,
            cycle,
            idempotencyKey: key,
            scheduledFor,
            status: 'pending',
            attempts: 1,
            claimedAt: new Date(),
            recipientEmail: fu.recipientEmail,
          }),
        );
      } catch {
        // Unique-key race with another worker: it owns this send.
        return 'skipped';
      }
    } else {
      const stale = new Date(Date.now() - STALE_CLAIM_MS);
      const claim = await this.dispatches
        .createQueryBuilder()
        .update(FollowUpDispatch)
        .set({
          status: 'pending',
          attempts: () => '"attempts" + 1',
          claimedAt: new Date(),
          recipientEmail: fu.recipientEmail,
        })
        .where(
          '"idempotencyKey" = :key AND ("status" = :failed OR ("status" = :pending AND ("claimedAt" IS NULL OR "claimedAt" < :stale)))',
          { key, failed: 'failed', pending: 'pending', stale },
        )
        .execute();
      if (!claim.affected) return 'skipped';
      row = await this.dispatches.findOneOrFail({
        where: { idempotencyKey: key },
      });
    }

    const questions = await this.questions.find({
      where: { followUpId: fu.id, include: true },
      order: { displayOrder: 'ASC' },
    });
    if (!questions.length || !fu.projectRef) {
      row.status = 'failed';
      row.error = 'No questions to send';
      await this.dispatches.save(row);
      fu.lastError = row.error;
      await this.followUps.save(fu);
      return 'failed';
    }

    // Fresh token per email; earlier emails' links stay valid through previousTokenHashes.
    const token = newFollowUpToken();
    const previous = Array.isArray(fu.previousTokenHashes)
      ? fu.previousTokenHashes
      : [];
    if (fu.tokenHash)
      fu.previousTokenHashes = [...previous.slice(-9), fu.tokenHash];
    fu.tokenHash = hashFollowUpToken(token);
    // Links stay valid for TTL days counted from the initial email (the first send of a cycle).
    if (!fu.tokenExpiresAt || kind === 'initial') {
      fu.tokenExpiresAt = new Date(
        `${addDaysIso(scheduledFor, this.tokenTtlDays())}T23:59:59+05:00`,
      );
    }
    await this.followUps.save(fu);

    try {
      const { messageId } = await this.mailService.sendFollowUpVerification({
        to: fu.recipientEmail,
        recipientName: fu.recipientName,
        kind,
        intro: followUpIntro(kind, fu.intervalLabel || 'scheduled'),
        subject: followUpSubject(
          kind,
          fu.projectRef.projectId,
          fu.projectRef.title,
        ),
        projectRef: fu.projectRef,
        questions: questions.map((q) => ({
          activityTitle: q.activityTitle,
          questionText: q.questionText,
          countLabel: q.countLabel,
        })),
        reviewLink: this.reviewLink(token),
        declineLink: this.declineLink(token),
        dueDate: fu.dueDate,
      });
      row.status = 'sent';
      row.sentAt = new Date();
      row.providerMessageId = messageId;
      row.error = '';
      await this.dispatches.save(row);
      fu.status =
        kind === 'reminder1' || kind === 'reminder2'
          ? 'reminded'
          : fu.status === 'reminded'
            ? 'reminded'
            : 'sent';
      fu.lastError = '';
      await this.followUps.save(fu);
      await this.audit('REPORT_FOLLOWUP_EMAIL_SENT', actor, fu.id, {
        reportId: fu.reportId,
        kind,
        to: fu.recipientEmail,
        scheduledFor,
      });
      return 'sent';
    } catch (err) {
      row.status = 'failed';
      row.error = String((err as Error)?.message || err).slice(0, 1000);
      await this.dispatches.save(row);
      fu.lastError = `Email ${kind} failed: ${row.error}`;
      await this.followUps.save(fu);
      this.logger.error(
        `Follow-up ${fu.id} ${kind} email failed: ${row.error}`,
      );
      return 'failed';
    }
  }

  // ---------------------------------------------------------------- partner (no login)

  private async findByToken(token: unknown): Promise<ReportFollowUp> {
    if (!tokenLooksValid(token)) {
      throw new NotFoundException('This follow-up link is not valid.');
    }
    const hash = hashFollowUpToken(token);
    const fu = await this.followUps
      .createQueryBuilder('f')
      .where('f.tokenHash = :hash', { hash })
      .orWhere('f.previousTokenHashes @> :arr', { arr: JSON.stringify([hash]) })
      .getOne();
    if (!fu) throw new NotFoundException('This follow-up link is not valid.');
    // An answered follow-up keeps showing its thank-you page even after the link's deadline.
    if (fu.status === 'responded') return fu;
    if (fu.status === 'cancelled') {
      throw new GoneException(
        'This follow-up was withdrawn by CIEL PK. No action is needed.',
      );
    }
    if (
      fu.status === 'expired' ||
      (fu.tokenExpiresAt && Date.now() > fu.tokenExpiresAt.getTime())
    ) {
      throw new GoneException('This follow-up link has expired.');
    }
    return fu;
  }

  private publicQuestions(followUpId: string): Promise<FollowUpQuestion[]> {
    return this.questions.find({
      where: { followUpId, include: true },
      order: { displayOrder: 'ASC' },
    });
  }

  async getPublicByToken(token: unknown) {
    const fu = await this.findByToken(token);
    const questions = await this.publicQuestions(fu.id);
    const answers =
      fu.status === 'responded'
        ? await this.answers.find({ where: { followUpId: fu.id } })
        : [];
    return {
      status: fu.status,
      recipientName: fu.recipientName,
      recipientRole: fu.recipientRole,
      dueDate: fu.dueDate,
      intervalLabel: fu.intervalLabel,
      // Anyone holding the link sees the project, never the students' names.
      projectRef: fu.projectRef ? { ...fu.projectRef, studentTeam: '' } : null,
      checkFocus: fu.checkFocus,
      respondedAt: fu.respondedAt,
      respondentName: fu.respondentName,
      declinedAt: fu.declinedAt,
      questions: questions.map((q) => ({
        id: q.id,
        activityTitle: q.activityTitle,
        questionText: q.questionText,
        countLabel: q.countLabel,
      })),
      answers: answers.map((a) => ({
        questionId: a.questionId,
        choice: a.choice,
        numericValue: a.numericValue,
        note: a.note,
      })),
    };
  }

  async submitResponse(token: unknown, dto: SubmitFollowUpResponseDto) {
    const fu = await this.findByToken(token);
    if (fu.status === 'responded') {
      throw new ConflictException(
        'A response for this follow-up was already recorded. Thank you.',
      );
    }
    if (fu.status === 'declined') {
      throw new ConflictException(
        'This follow-up was declined earlier. Contact CIEL PK to reopen it.',
      );
    }
    const questions = await this.publicQuestions(fu.id);
    const byId = new Map(questions.map((q) => [q.id, q]));
    const seen = new Set<string>();
    for (const a of dto.answers) {
      if (!byId.has(a.questionId)) {
        throw new BadRequestException(
          'One of the answers does not belong to this follow-up.',
        );
      }
      if (seen.has(a.questionId)) {
        throw new BadRequestException(
          'Each question can only be answered once.',
        );
      }
      seen.add(a.questionId);
    }
    const missing = questions.filter((q) => !seen.has(q.id));
    if (missing.length) {
      throw new BadRequestException(
        `Please answer every question (choose "Unable to verify" if you cannot check it): ${missing
          .map((q) => q.activityTitle)
          .join(', ')}.`,
      );
    }
    await this.answers.delete({ followUpId: fu.id });
    await this.answers.save(
      dto.answers.map((a) =>
        this.answers.create({
          followUpId: fu.id,
          questionId: a.questionId,
          choice: a.choice,
          numericValue:
            typeof a.numericValue === 'number' &&
            Number.isFinite(a.numericValue)
              ? String(a.numericValue)
              : null,
          note: (a.note || '').trim().slice(0, 1000),
          verificationMethod: 'partner_reported',
        }),
      ),
    );
    fu.status = 'responded';
    fu.respondedAt = new Date();
    fu.respondentName = dto.representativeName.trim().slice(0, 160);
    fu.generalComment = (dto.generalComment || '').trim().slice(0, 2000);
    await this.followUps.save(fu);
    await this.audit(
      'REPORT_FOLLOWUP_RESPONDED',
      { name: fu.respondentName },
      fu.id,
      {
        reportId: fu.reportId,
        answers: dto.answers.length,
      },
    );
    if (this.notificationsService && fu.studentId) {
      await this.notificationsService
        .createNotification(fu.studentId, {
          type: 'update',
          title: 'Follow-up response received',
          message: `${fu.respondentName} answered the sustainability follow-up for "${fu.projectRef?.title || 'your project'}". CIEL PK will review it and share the result with you.`,
        })
        .catch((err: Error) =>
          this.logger.warn(`Follow-up notification failed: ${err.message}`),
        );
    }
    return { ok: true, respondedAt: fu.respondedAt };
  }

  async decline(token: unknown, reason?: string, optOut?: boolean) {
    const fu = await this.findByToken(token);
    if (fu.status === 'responded') {
      throw new ConflictException(
        'A response was already recorded for this follow-up.',
      );
    }
    if (fu.status !== 'declined') {
      fu.status = 'declined';
      fu.declinedAt = new Date();
      fu.declineReason = (reason || '').trim().slice(0, 500);
      await this.followUps.save(fu);
      await this.audit('REPORT_FOLLOWUP_DECLINED', null, fu.id, {
        reportId: fu.reportId,
        reason: fu.declineReason,
        optOut: Boolean(optOut),
      });
    }
    if (optOut && fu.recipientEmail) {
      await this.addOptOut(
        fu.recipientEmail,
        'partner_opt_out',
        fu.declineReason || 'Asked to stop follow-up emails',
        fu.id,
      );
    }
    return { ok: true, declinedAt: fu.declinedAt, optedOut: Boolean(optOut) };
  }

  // ---------------------------------------------------------------- opt-outs & delivery (Phase 3)

  async isOptedOut(email: string): Promise<boolean> {
    const key = str(email).toLowerCase();
    if (!key) return false;
    return (await this.optOuts.count({ where: { email: key } })) > 0;
  }

  async addOptOut(
    email: string,
    source: FollowUpOptOutSource,
    reason: string,
    followUpId: string | null = null,
  ): Promise<void> {
    const key = str(email).toLowerCase();
    if (!EMAIL_RE.test(key)) return;
    const existing = await this.optOuts.findOne({ where: { email: key } });
    if (existing) return;
    try {
      await this.optOuts.save(
        this.optOuts.create({
          email: key,
          source,
          reason: reason.slice(0, 500),
          followUpId,
        }),
      );
    } catch {
      // unique race: already listed
    }
    await this.audit('REPORT_FOLLOWUP_OPT_OUT', null, followUpId || key, {
      email: key,
      source,
      reason,
    });
  }

  /**
   * Mail provider webhook (delivered / deferred / bounced / complained). Events are matched to a
   * dispatch by provider message id, else by recipient address. A bounce or complaint lists the
   * address and parks every still-active follow-up to it as needs_attention; nothing is sent to
   * that address again until an admin re-targets it.
   */
  async recordMailEvents(events: NormalizedMailEvent[]) {
    const result = {
      received: events.length,
      matched: 0,
      bounced: 0,
      ignored: 0,
    };
    for (const ev of events) {
      let row: FollowUpDispatch | null = null;
      if (ev.messageId) {
        row = await this.dispatches.findOne({
          where: { providerMessageId: ev.messageId },
        });
      }
      if (!row && ev.email) {
        row = await this.dispatches.findOne({
          where: { recipientEmail: ev.email, status: 'sent' },
          order: { sentAt: 'DESC' },
        });
      }
      if (!row) {
        result.ignored += 1;
        continue;
      }
      result.matched += 1;
      row.deliveryStatus = ev.type;
      row.deliveryDetail = ev.detail;
      row.deliveryUpdatedAt = new Date();
      await this.dispatches.save(row);
      if (ev.type !== 'bounced' && ev.type !== 'complained') continue;

      result.bounced += 1;
      const email = ev.email || row.recipientEmail;
      await this.addOptOut(
        email,
        ev.type === 'bounced' ? 'webhook_bounce' : 'webhook_complaint',
        ev.detail || ev.type,
        row.followUpId,
      );
      const affected = await this.followUps.find({
        where: { recipientEmail: email, status: In(FOLLOW_UP_ACTIVE_STATUSES) },
      });
      for (const fu of affected) {
        fu.status = 'needs_attention';
        fu.lastError =
          ev.type === 'bounced'
            ? `Email to ${email} bounced (${ev.detail || 'no detail'}); choose another contact and re-activate`
            : `${email} marked the follow-up as spam; choose another contact and re-activate`;
        await this.followUps.save(fu);
        await this.audit('REPORT_FOLLOWUP_DELIVERY_FAILED', null, fu.id, {
          reportId: fu.reportId,
          email,
          type: ev.type,
          detail: ev.detail,
          messageId: ev.messageId,
        });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- admin

  private async requireForReport(reportId: string): Promise<ReportFollowUp> {
    const fu = await this.followUps.findOne({ where: { reportId } });
    if (!fu)
      throw new NotFoundException('No follow-up exists for this report yet.');
    return fu;
  }

  async getForAdmin(reportId: string) {
    const report = await this.reports.findOne({
      where: { id: reportId },
      select: ['id', 'status', 'admin_status', 'section10'],
    });
    if (!report) throw new NotFoundException('Report not found');
    const s10 = ((report.section10 || {}) as unknown as Rec) ?? {};
    const fu = await this.followUps.findOne({ where: { reportId } });
    const plan = str(s10.followup_plan);
    const published =
      PUBLISHED_REPORT_STATUSES.has(
        String(report.status || '').toLowerCase(),
      ) || String(report.admin_status || '').toLowerCase() === 'approved';
    if (!fu) {
      return {
        followUp: null,
        plan,
        canActivate: plan === 'yes' && published,
        dispatchEnabled: this.dispatchEnabled(),
      };
    }
    const [questions, dispatches, answers] = await Promise.all([
      this.questions.find({
        where: { followUpId: fu.id },
        order: { displayOrder: 'ASC' },
      }),
      this.dispatches.find({
        where: { followUpId: fu.id },
        order: { createdAt: 'ASC' },
      }),
      this.answers.find({ where: { followUpId: fu.id } }),
    ]);
    return {
      followUp: this.serialize(fu),
      plan,
      canActivate: plan === 'yes' && published,
      dispatchEnabled: this.dispatchEnabled(),
      questions,
      dispatches: dispatches.map((d) => ({
        id: d.id,
        kind: d.kind,
        status: d.status,
        attempts: d.attempts,
        scheduledFor: d.scheduledFor,
        sentAt: d.sentAt,
        recipientEmail: d.recipientEmail,
        error: d.error,
        deliveryStatus: d.deliveryStatus,
        deliveryDetail: d.deliveryDetail,
        deliveryUpdatedAt: d.deliveryUpdatedAt,
      })),
      answers,
      schedule: fu.dueDate
        ? {
            initial: fu.dueDate,
            reminder1: addDaysIso(fu.dueDate, fu.reminder1Days),
            reminder2: addDaysIso(fu.dueDate, fu.reminder2Days),
          }
        : null,
    };
  }

  private serialize(fu: ReportFollowUp) {
    const { tokenHash: _hash, previousTokenHashes: _prev, ...rest } = fu;
    void _hash;
    void _prev;
    return rest;
  }

  async updateQuestions(
    reportId: string,
    dto: AdminFollowUpQuestionsDto,
    actor?: Actor,
  ) {
    const fu = await this.requireForReport(reportId);
    if (fu.status === 'responded' || fu.status === 'declined') {
      throw new BadRequestException(
        'The partner already answered; questions can no longer change.',
      );
    }
    const existing = await this.questions.find({
      where: { followUpId: fu.id },
    });
    const byId = new Map(existing.map((q) => [q.id, q]));
    const keep = new Set<string>();
    const rows: FollowUpQuestion[] = [];
    dto.questions.forEach((q, i) => {
      const row =
        (q.id && byId.get(q.id)) ||
        this.questions.create({
          followUpId: fu.id,
          generatedBy: 'admin',
          activityId: null,
          sourceFieldIds: [],
          reason: 'Added by CIEL PK admin',
        });
      row.questionText = q.questionText.trim();
      if (q.activityTitle !== undefined)
        row.activityTitle = q.activityTitle.trim().slice(0, 240);
      if (!row.activityTitle) row.activityTitle = 'Project activity';
      row.countLabel = q.countLabel?.trim()
        ? q.countLabel.trim().slice(0, 160)
        : null;
      row.include = q.include !== false;
      row.displayOrder = i;
      if (row.id) keep.add(row.id);
      rows.push(row);
    });
    if (!rows.some((r) => r.include)) {
      throw new BadRequestException('Keep at least one question in the email.');
    }
    const remove = existing.filter((q) => !keep.has(q.id));
    if (remove.length) await this.questions.delete(remove.map((q) => q.id));
    await this.questions.save(rows);
    fu.questionsEditedAt = new Date();
    fu.questionSetVersion += 1;
    await this.followUps.save(fu);
    await this.audit('REPORT_FOLLOWUP_QUESTIONS_EDITED', actor, fu.id, {
      reportId,
      version: fu.questionSetVersion,
      count: rows.length,
    });
    return this.getForAdmin(reportId);
  }

  async regenerateQuestions(reportId: string, actor?: Actor) {
    const fu = await this.requireForReport(reportId);
    if (fu.status === 'responded' || fu.status === 'declined') {
      throw new BadRequestException(
        'The partner already answered; questions can no longer change.',
      );
    }
    const report = await this.loadReport(reportId);
    if (!report) throw new NotFoundException('Report not found');
    await this.replaceQuestions(fu, await this.generateQuestions(report, fu));
    fu.questionsEditedAt = null;
    fu.questionSetVersion += 1;
    await this.followUps.save(fu);
    await this.audit('REPORT_FOLLOWUP_QUESTIONS_REGENERATED', actor, fu.id, {
      reportId,
    });
    return this.getForAdmin(reportId);
  }

  /** Manual activation for reports published before this feature existed, or after fixing 9.5. */
  async activateByAdmin(
    reportId: string,
    actor?: Actor,
    dto?: AdminActivateFollowUpDto,
  ) {
    const report = await this.reports.findOne({
      where: { id: reportId },
      select: ['id', 'status', 'admin_status', 'section10'],
    });
    if (!report) throw new NotFoundException('Report not found');
    const published =
      PUBLISHED_REPORT_STATUSES.has(
        String(report.status || '').toLowerCase(),
      ) || String(report.admin_status || '').toLowerCase() === 'approved';
    if (!published) {
      throw new BadRequestException(
        'Only a published (approved) report can have a follow-up.',
      );
    }
    const s10 = ((report.section10 || {}) as unknown as Rec) ?? {};
    const existing = await this.followUps.findOne({ where: { reportId } });
    const overrides: ActivationOverrides | undefined = dto
      ? {
          recipientName: str(dto.recipientName),
          recipientEmail: str(dto.recipientEmail).toLowerCase(),
          recipientRole: str(dto.recipientRole),
          dueDate: str(dto.dueDate),
        }
      : undefined;
    const adminDecided = Boolean(overrides?.recipientEmail);
    if (adminDecided) {
      if (!EMAIL_RE.test(overrides!.recipientEmail!)) {
        throw new BadRequestException('Enter a valid recipient email.');
      }
      if (!overrides!.recipientName) {
        throw new BadRequestException("Enter the responsible person's name.");
      }
      if (overrides!.dueDate && !isIsoDate(overrides!.dueDate)) {
        throw new BadRequestException('The follow-up date must be yyyy-mm-dd.');
      }
      if (await this.isOptedOut(overrides!.recipientEmail!)) {
        throw new BadRequestException(
          'That address opted out of CIEL PK follow-up emails or bounced. Choose another contact.',
        );
      }
    } else {
      if (overrides?.dueDate && !isIsoDate(overrides.dueDate)) {
        throw new BadRequestException('The follow-up date must be yyyy-mm-dd.');
      }
      if (str(s10.followup_plan) !== 'yes' && !existing?.decidedByAdmin) {
        throw new BadRequestException(
          str(s10.followup_plan) === 'later'
            ? 'The student left the decision to CIEL PK: enter the responsible person and a date to start the follow-up.'
            : 'The student did not plan a follow-up check (9.5) for this report. Enter a recipient to start one anyway.',
        );
      }
      if (
        existing &&
        (existing.status === 'declined' || existing.status === 'expired')
      ) {
        throw new BadRequestException(
          `This follow-up was ${existing.status === 'declined' ? 'declined by the contact' : 'left unanswered'}. Enter a new responsible person to reopen it.`,
        );
      }
      if (
        existing?.status === 'needs_attention' &&
        existing.recipientEmail &&
        (await this.isOptedOut(existing.recipientEmail))
      ) {
        throw new BadRequestException(
          `${existing.recipientEmail} opted out or bounced. Enter another responsible person to continue.`,
        );
      }
    }
    // A date-only change is allowed for a not-yet-mailed follow-up; a recipient starts / re-targets.
    const effective: ActivationOverrides | undefined = adminDecided
      ? overrides
      : overrides?.dueDate
        ? { dueDate: overrides.dueDate }
        : undefined;
    await this.activateForReport(reportId, actor, effective);
    return this.getForAdmin(reportId);
  }

  /** Do-not-email list (asked to stop, hard bounce, complaint, admin). */
  async listOptOuts() {
    return this.optOuts.find({ order: { createdAt: 'DESC' }, take: 500 });
  }

  /** Admin removes an address from the list (the person confirmed they want follow-ups again). */
  async removeOptOut(email: string, actor?: Actor) {
    const key = str(email).toLowerCase();
    const row = await this.optOuts.findOne({ where: { email: key } });
    if (!row) throw new NotFoundException('That address is not on the list.');
    await this.optOuts.delete({ id: row.id });
    await this.audit('REPORT_FOLLOWUP_OPT_OUT_REMOVED', actor, key, {
      email: key,
      source: row.source,
    });
    return { ok: true, email: key };
  }

  // ---------------------------------------------------------------- tracker (Phase 4)

  /** Outcome per follow-up from its answers (partner-reported; never "stopped" for no response). */
  private async outcomesFor(
    followUpIds: string[],
  ): Promise<Map<string, FollowUpOutcomeSummary>> {
    const map = new Map<string, FollowUpOutcomeSummary>();
    if (!followUpIds.length) return map;
    const rows = await this.answers.find({
      where: { followUpId: In(followUpIds) },
      select: ['followUpId', 'choice'],
    });
    const grouped = new Map<string, string[]>();
    for (const r of rows) {
      grouped.set(r.followUpId, [
        ...(grouped.get(r.followUpId) || []),
        r.choice,
      ]);
    }
    for (const id of followUpIds) {
      map.set(id, summarizeOutcomes(grouped.get(id) || []));
    }
    return map;
  }

  private trackerQuery(query: AdminFollowUpListQueryDto) {
    const qb = this.followUps
      .createQueryBuilder('f')
      .leftJoinAndSelect('f.report', 'report')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('report.student', 'student');
    const status = str(query.status);
    if (status === 'awaiting') {
      qb.andWhere('f.status IN (:...awaiting)', {
        awaiting: ['sent', 'reminded'],
      });
    } else if (status && status !== 'all') {
      qb.andWhere('f.status = :status', { status });
    }
    const q = str(query.q);
    if (q) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('f.recipientEmail ILIKE :q', { q: `%${q}%` })
            .orWhere('f.recipientName ILIKE :q', { q: `%${q}%` })
            .orWhere('opportunity.title ILIKE :q', { q: `%${q}%` })
            .orWhere('student.name ILIKE :q', { q: `%${q}%` })
            .orWhere('student.email ILIKE :q', { q: `%${q}%` })
            .orWhere('report.publicId ILIKE :q', { q: `%${q}%` });
        }),
      );
    }
    return qb.orderBy('f.dueDate', 'ASC').addOrderBy('f.createdAt', 'DESC');
  }

  private async trackerRows(
    fus: ReportFollowUp[],
  ): Promise<FollowUpTrackerRow[]> {
    const ids = fus.map((f) => f.id);
    const [outcomes, dispatches] = await Promise.all([
      this.outcomesFor(ids),
      ids.length
        ? this.dispatches.find({
            where: { followUpId: In(ids), status: 'sent' },
            order: { sentAt: 'ASC' },
          })
        : Promise.resolve([] as FollowUpDispatch[]),
    ]);
    const sentBy = new Map<string, FollowUpDispatch[]>();
    for (const d of dispatches) {
      sentBy.set(d.followUpId, [...(sentBy.get(d.followUpId) || []), d]);
    }
    return fus.map((f) => {
      const report = (f.report || {}) as Partial<StudentReport>;
      const opportunity = (report.opportunity || {}) as Partial<{
        title: string;
      }>;
      const studentRec = (report.student || {}) as Partial<{
        name: string;
        email: string;
      }>;
      const sent = sentBy.get(f.id) || [];
      const last = sent[sent.length - 1];
      return {
        id: f.id,
        reportId: f.reportId,
        reportPublicId: String(report.publicId || ''),
        projectTitle: f.projectRef?.title || opportunity.title || '',
        studentName: studentRec.name || '',
        studentEmail: studentRec.email || '',
        recipientName: f.recipientName,
        recipientEmail: f.recipientEmail,
        recipientRole: f.recipientRole,
        status: f.status,
        decidedByAdmin: f.decidedByAdmin,
        dueDate: f.dueDate,
        intervalLabel: f.intervalLabel,
        emailsSent: sent.length,
        lastSentAt: last?.sentAt || null,
        lastDelivery: last?.deliveryStatus || 'unknown',
        respondedAt: f.respondedAt,
        respondentName: f.respondentName,
        declinedAt: f.declinedAt,
        reviewedAt: f.reviewedAt,
        lastError: f.lastError,
        outcome: outcomes.get(f.id) || summarizeOutcomes([]),
        activatedAt: f.activatedAt,
      };
    });
  }

  /** Published reports whose student answered "Not decided yet" and that have no follow-up yet. */
  async pendingDecisions(limit = 100) {
    const rows = await this.reports
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('report.student', 'student')
      .leftJoin(ReportFollowUp, 'f', 'f.reportId = report.id')
      .where('f.id IS NULL')
      .andWhere("report.section10 ->> 'followup_plan' = 'later'")
      .andWhere(
        new Brackets((w) => {
          w.where('LOWER(report.status) IN (:...published)', {
            published: [...PUBLISHED_REPORT_STATUSES],
          }).orWhere("LOWER(report.admin_status) = 'approved'");
        }),
      )
      .orderBy('report.adminApprovedAt', 'DESC')
      .take(limit)
      .getMany();
    return rows.map((r) => {
      const s10 = ((r.section10 || {}) as unknown as Rec) ?? {};
      return {
        reportId: r.id,
        reportPublicId: r.publicId || '',
        projectTitle: r.opportunity?.title || '',
        studentName: r.student?.name || '',
        decisionOwner: str(s10.followup_decision_owner) || 'faculty',
        publishedAt: r.adminApprovedAt || null,
      };
    });
  }

  async listForAdmin(query: AdminFollowUpListQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(5, Number(query.limit) || 25));
    const [fus, total] = await this.trackerQuery(query)
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const rows = await this.trackerRows(fus);

    const byStatusRaw = await this.followUps
      .createQueryBuilder('f')
      .select('f.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('f.status')
      .getRawMany<{ status: string; count: string }>();
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRaw) byStatus[r.status] = Number(r.count);
    const responded = await this.followUps.find({
      where: { status: 'responded' },
      select: ['id'],
    });
    const outcomes = await this.outcomesFor(responded.map((r) => r.id));
    const byOutcome: Record<string, number> = {};
    for (const o of outcomes.values()) {
      byOutcome[o.bucket] = (byOutcome[o.bucket] || 0) + 1;
    }
    const pending = await this.pendingDecisions();
    const optOuts = await this.listOptOuts();
    return {
      rows,
      total,
      page,
      limit,
      stats: {
        byStatus,
        byOutcome,
        awaiting: (byStatus.sent || 0) + (byStatus.reminded || 0),
        pendingDecisions: pending.length,
        optOuts: optOuts.length,
        dispatchEnabled: this.dispatchEnabled(),
      },
      pendingDecisions: pending,
      optOuts,
    };
  }

  async exportCsv(query: AdminFollowUpListQueryDto): Promise<string> {
    const fus = await this.trackerQuery(query).take(5000).getMany();
    const rows = await this.trackerRows(fus);
    const header = [
      'Report ID',
      'Project',
      'Student',
      'Recipient',
      'Recipient email',
      'Recipient role',
      'Decided by',
      'Status',
      'Due date',
      'Emails sent',
      'Last sent',
      'Last delivery',
      'Responded',
      'Respondent',
      'Outcome',
      'Yes',
      'Partially',
      'No',
      'Unable to verify',
      'Reviewed',
      'Note',
    ];
    const lines = rows.map((r) =>
      [
        r.reportPublicId || r.reportId,
        r.projectTitle,
        r.studentName,
        r.recipientName,
        r.recipientEmail,
        r.recipientRole,
        r.decidedByAdmin ? 'CIEL PK' : 'Student (9.5)',
        r.status,
        r.dueDate,
        r.emailsSent,
        r.lastSentAt ? r.lastSentAt.toISOString() : '',
        r.lastDelivery,
        r.respondedAt ? r.respondedAt.toISOString() : '',
        r.respondentName,
        r.outcome.bucket,
        r.outcome.yes,
        r.outcome.partially,
        r.outcome.no,
        r.outcome.unable,
        r.reviewedAt ? r.reviewedAt.toISOString() : '',
        r.lastError,
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
  }

  /** Everything the audit log holds for this follow-up (activation, mails, answers, edits). */
  async auditTrail(reportId: string) {
    const fu = await this.requireForReport(reportId);
    if (!this.auditLogs) return { logs: [] };
    const page = await this.auditLogs.findPaginated(1, 100, { search: fu.id });
    return { logs: page.logs };
  }

  async sendNow(reportId: string, actor?: Actor) {
    const fu = await this.requireForReport(reportId);
    if (!FOLLOW_UP_ACTIVE_STATUSES.includes(fu.status)) {
      throw new BadRequestException(
        `A follow-up in status "${fu.status}" cannot be mailed.`,
      );
    }
    if (!EMAIL_RE.test(fu.recipientEmail)) {
      throw new BadRequestException(
        'The follow-up has no valid recipient email.',
      );
    }
    const sent = await this.sentKinds(fu.id, fu.cycle);
    const kind: FollowUpDispatchKind = sent.has('initial')
      ? 'manual'
      : 'initial';
    const outcome = await this.sendDispatch(fu, kind, karachiToday(), actor);
    if (outcome === 'failed') {
      throw new BadRequestException(
        fu.lastError || 'The email could not be sent.',
      );
    }
    return this.getForAdmin(reportId);
  }

  async cancelByAdmin(
    reportId: string,
    reason: string | undefined,
    actor?: Actor,
  ) {
    const fu = await this.requireForReport(reportId);
    if (fu.status === 'responded') {
      throw new BadRequestException(
        'The partner already answered; there is nothing to cancel.',
      );
    }
    await this.cancel(
      fu,
      (reason || 'cancelled_by_admin').trim().slice(0, 500),
      actor,
    );
    return this.getForAdmin(reportId);
  }

  async markReviewed(reportId: string, actor?: Actor) {
    const fu = await this.requireForReport(reportId);
    if (fu.status !== 'responded') {
      throw new BadRequestException(
        'Only an answered follow-up can be marked as reviewed.',
      );
    }
    fu.reviewedAt = new Date();
    fu.reviewedBy = actor?.name || actor?.id || null;
    await this.followUps.save(fu);
    await this.audit('REPORT_FOLLOWUP_REVIEWED', actor, fu.id, { reportId });
    if (this.notificationsService && fu.studentId) {
      await this.notificationsService
        .createNotification(fu.studentId, {
          type: 'update',
          title: 'Follow-up result available',
          message: `CIEL PK reviewed the partner's sustainability follow-up for "${fu.projectRef?.title || 'your project'}". Open the report's Section 9 to see what continued.`,
        })
        .catch((err: Error) =>
          this.logger.warn(`Follow-up notification failed: ${err.message}`),
        );
    }
    return this.getForAdmin(reportId);
  }

  // ---------------------------------------------------------------- student preview (9.5)

  /**
   * What the student sees on 9.5 as soon as they pick "Yes": the schedule and the draft questions
   * built from the answers currently on screen. Nothing is stored or sent; CIEL PK may still edit
   * the questions after publication.
   */
  previewForStudent(dto: FollowUpPreviewDto) {
    const s10 = (dto.section10 || {}) as Rec;
    const projectEndDate = normalizeIsoDate(dto.projectEndDate);
    const dueDate = resolveFollowUpDueDate(s10, projectEndDate);
    const { reminder1Days, reminder2Days } = this.reminderDays();
    const questions = generateFollowUpQuestions({
      section4: dto.section4 || {},
      section5: dto.section5 || {},
      section10: s10,
    });
    const intervalLabel = followUpIntervalLabel(s10);
    return {
      dueDate,
      reminder1: dueDate ? addDaysIso(dueDate, reminder1Days) : '',
      reminder2: dueDate ? addDaysIso(dueDate, reminder2Days) : '',
      linkValidDays: this.tokenTtlDays(),
      intervalLabel,
      subject: followUpSubject(
        'initial',
        'PROJECT-ID',
        str(dto.projectTitle) || 'your project',
      ),
      intro: followUpIntro('initial', intervalLabel),
      questions: questions.map((q, i) => ({
        order: i + 1,
        activityTitle: q.activityTitle,
        questionText: q.questionText,
        countLabel: q.countLabel,
        reason: q.reason,
      })),
      aiEnabled: this.aiQuestionsEnabled(),
    };
  }

  // ---------------------------------------------------------------- student

  /** The report owner's read-only view; partner answers appear only after CIEL PK reviewed them. */
  async getForStudent(reportId: string, userId: string, role: string) {
    const report = await this.reports.findOne({
      where: { id: reportId },
      select: ['id', 'studentId'],
    });
    if (!report) throw new NotFoundException('Report not found');
    if (role !== 'admin' && report.studentId !== userId) {
      throw new ForbiddenException(
        'Only the report owner can see its follow-up.',
      );
    }
    const fu = await this.followUps.findOne({ where: { reportId } });
    if (!fu) return { followUp: null };
    const [questions, dispatches] = await Promise.all([
      this.questions.find({
        where: { followUpId: fu.id, include: true },
        order: { displayOrder: 'ASC' },
      }),
      this.dispatches.find({
        where: { followUpId: fu.id, status: 'sent' },
        order: { sentAt: 'ASC' },
      }),
    ]);
    const answers = fu.reviewedAt
      ? await this.answers.find({ where: { followUpId: fu.id } })
      : [];
    const studentVisibleStatus: FollowUpStatus = fu.status;
    return {
      followUp: {
        status: studentVisibleStatus,
        dueDate: fu.dueDate,
        intervalLabel: fu.intervalLabel,
        recipientName: fu.recipientName,
        recipientRole: fu.recipientRole,
        firstSentAt: dispatches[0]?.sentAt || null,
        lastSentAt: dispatches[dispatches.length - 1]?.sentAt || null,
        emailsSent: dispatches.length,
        respondedAt: fu.respondedAt,
        declinedAt: fu.declinedAt,
        reviewedAt: fu.reviewedAt,
        lastError: fu.status === 'needs_attention' ? fu.lastError : '',
        questions: questions.map((q) => ({
          id: q.id,
          activityTitle: q.activityTitle,
          questionText: q.questionText,
          countLabel: q.countLabel,
        })),
        answers: answers.map((a) => ({
          questionId: a.questionId,
          choice: a.choice,
          numericValue: a.numericValue,
          note: a.note,
        })),
        generalComment: fu.reviewedAt ? fu.generalComment : '',
        respondentName: fu.reviewedAt ? fu.respondentName : '',
      },
    };
  }
}

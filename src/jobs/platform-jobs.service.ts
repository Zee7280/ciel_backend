import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AttendanceSlaService } from '../engagement/attendance-sla.service';
import { ParticipationReconcileService } from '../engagement/participation-reconcile.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

export const NIGHTLY_JOBS_AUDIT_ACTION = 'PLATFORM_NIGHTLY_JOBS_RUN';

export type NightlyJobsRunResult = {
  success: boolean;
  trigger: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  attendance_sla: {
    reminders_sent: number;
    escalated: number;
    scanned: number;
  } | null;
  enrollment_reconcile: {
    display_names_backfilled: number;
    duplicate_leads_normalized: number;
    scanned_teams: number;
  } | null;
  error: string | null;
};

/**
 * Whether the in-process `@Cron` timer should run. On Vercel Functions there is no long-lived
 * process, so the timer only fires if a warm instance happens to exist at 02:00 — it is not a
 * schedule. There, Vercel Cron calls `/api/v1/internal/jobs/nightly` instead (vercel.json).
 */
export function inProcessCronEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.DISABLE_PLATFORM_CRON === 'true') return false;
  if (env.VERCEL) return false;
  return true;
}

@Injectable()
export class PlatformJobsService {
  private readonly logger = new Logger(PlatformJobsService.name);

  constructor(
    private readonly attendanceSlaService: AttendanceSlaService,
    private readonly participationReconcileService: ParticipationReconcileService,
    @Optional() private readonly auditLogs?: AuditLogsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyJobs() {
    if (!inProcessCronEnabled(process.env)) {
      return;
    }
    await this.runNightlyJobsNow('in-process-cron');
  }

  /**
   * Runs both nightly jobs once and records the outcome in the audit log (action
   * PLATFORM_NIGHTLY_JOBS_RUN) so production execution can be confirmed from the admin audit page
   * and from function logs, not inferred.
   */
  async runNightlyJobsNow(trigger: string): Promise<NightlyJobsRunResult> {
    const startedAt = new Date();
    this.logger.log(`Starting nightly platform jobs (trigger=${trigger})`);
    const result: NightlyJobsRunResult = {
      success: false,
      trigger,
      started_at: startedAt.toISOString(),
      finished_at: startedAt.toISOString(),
      duration_ms: 0,
      attendance_sla: null,
      enrollment_reconcile: null,
      error: null,
    };
    try {
      result.attendance_sla =
        await this.attendanceSlaService.processPartnerAttendanceSla();
      result.enrollment_reconcile =
        await this.participationReconcileService.reconcileEnrollmentMetadata();
      result.success = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Nightly platform jobs failed: ${result.error}`);
    }
    const finishedAt = new Date();
    result.finished_at = finishedAt.toISOString();
    result.duration_ms = finishedAt.getTime() - startedAt.getTime();
    this.logger.log(
      `Finished nightly platform jobs (trigger=${trigger}, success=${result.success}, duration_ms=${result.duration_ms})`,
    );
    await this.auditLogs?.recordMutation({
      action: NIGHTLY_JOBS_AUDIT_ACTION,
      user: `system:${trigger}`,
      target: 'nightly',
      target_type: 'scheduled_job',
      details: { ...result },
    });
    return result;
  }

  async runAttendanceSlaNow() {
    return this.attendanceSlaService.processPartnerAttendanceSla();
  }

  async runEnrollmentReconcileNow() {
    return this.participationReconcileService.reconcileEnrollmentMetadata();
  }
}

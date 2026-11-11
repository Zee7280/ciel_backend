import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { CourseProjectEntry } from '../paths/entities/course-project-entry.entity';
import { FypEntry } from '../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../paths/entities/venture-entry.entity';
import {
  CII_SECTION_MAX_BY_KEY,
  CiiSectionBreakdownKey,
} from '../reports/cii-section-weights.constants';
import {
  ventureCompletenessPercent,
  VENTURE_VISIBILITY_THRESHOLD,
} from '../paths/venture-completeness.constants';
import { computeVentureGates } from '../paths/venture-gates.util';
import { StudentReportsService } from '../reports/student-reports.service';

const WORKING_PARTICIPATION_STATUSES = [
  'approved',
  'verified',
  'paid',
  'accepted',
] as const;

/** Community Service stages per engagement (dashboard progress bar + overall completion). */
const CS_STAGE_PENDING = 10;
const CS_STAGE_JOINED = 25;
const CS_STAGE_LOGGING = 50;
const CS_STAGE_SUBMITTED = 75;
const CS_STAGE_APPROVED = 100;

/** Reports this student belongs to (lead or teammate), grouped by project. */
type ReportProjects = { approved: Set<string>; submitted: Set<string> };

/** Must match the frontend Course Project wizard's STEPS.length (course-project/[id]/page.tsx). */
const COURSE_PROJECT_TOTAL_STEPS = 8;

/** Must match the frontend FYP/Thesis wizard's STEPS.length (fyp-thesis/page.tsx). */
const FYP_TOTAL_STEPS = 9;

/** Must match the frontend Enterprise Path wizard's STEPS.length (startup-business/page.tsx). */
const VENTURE_TOTAL_STEPS = 8;

export type PathState = 'not_started' | 'active' | 'complete';

export interface PathStatusEntry {
  state: PathState;
  needsAction: boolean;
  /** 0-100, drives the progress bar on the dashboard's "Your paths" grid. */
  progress: number;
  /** One-line human summary, e.g. "2/4 steps complete". */
  detail: string;
}

@Injectable()
export class ImpactSummaryService {
  constructor(
    @InjectRepository(AttendanceLog)
    private readonly attendanceLogRepo: Repository<AttendanceLog>,
    @InjectRepository(Participation)
    private readonly participationRepo: Repository<Participation>,
    @InjectRepository(StudentReport)
    private readonly studentReportRepo: Repository<StudentReport>,
    @InjectRepository(CourseProjectEntry)
    private readonly courseProjectRepo: Repository<CourseProjectEntry>,
    @InjectRepository(FypEntry)
    private readonly fypRepo: Repository<FypEntry>,
    @InjectRepository(VentureEntry)
    private readonly ventureRepo: Repository<VentureEntry>,
    private readonly studentReportsService: StudentReportsService,
  ) {}

  async getSummary(userId: string) {
    const reportProjects = await this.reportProjectsForStudent(userId);
    const [
      { verifiedHours, pendingHours },
      activeEngagements,
      compositeScore,
      pathsStatus,
    ] = await Promise.all([
      this.sumHours(userId, reportProjects.approved),
      this.participationRepo.count({
        where: {
          studentId: userId,
          status: In([...WORKING_PARTICIPATION_STATUSES]),
        },
      }),
      this.averageReportScore(userId),
      this.getPathsStatus(userId, reportProjects),
    ]);

    return {
      compositeScore,
      band: this.band(compositeScore),
      rubric: this.rubricFromComposite(compositeScore),
      verifiedHours,
      pendingHours,
      activeEngagements,
      pathsStatus,
    };
  }

  /**
   * Admin-approved (verified / paid) reports and other submitted reports this student is on —
   * as lead or as a teammate — keyed by project id. Best effort: a lookup failure only means
   * hours and progress fall back to the attendance-only figures.
   */
  private async reportProjectsForStudent(
    userId: string,
  ): Promise<ReportProjects> {
    const approved = new Set<string>();
    const submitted = new Set<string>();
    let reports: StudentReport[] = [];
    try {
      reports =
        await this.studentReportsService.getMergedReportsForParticipant(userId);
    } catch {
      reports = [];
    }
    for (const report of reports) {
      const key = String(
        report.opportunityId || report.project_id || '',
      ).trim();
      if (!key) continue;
      if (
        report.admin_status === 'approved' &&
        report.faculty_status !== 'rejected' &&
        ['verified', 'paid'].includes(String(report.status))
      ) {
        approved.add(key);
      } else if (report.status && report.status !== 'draft') {
        submitted.add(key);
      }
    }
    for (const key of approved) submitted.delete(key);
    return { approved, submitted };
  }

  /**
   * Verified hours: sessions faculty verified, plus every non-rejected session on a project whose
   * report CIEL PK approved (approving the report verifies its logged hours — the same total the
   * certificate shows). Pending hours: the rest still waiting, rejected sessions excluded.
   */
  private async sumHours(
    userId: string,
    approvedProjectIds: Set<string>,
  ): Promise<{ verifiedHours: number; pendingHours: number }> {
    const approvedIds = [...approvedProjectIds];
    const inApproved = approvedIds.length
      ? `(log.projectId IN (:...approvedIds) AND COALESCE(log.approvalStatus, '') <> 'rejected')`
      : 'FALSE';
    const raw = await this.attendanceLogRepo
      .createQueryBuilder('log')
      .innerJoin('log.participant', 'p')
      .where('p.studentId = :userId', { userId })
      .select(
        `SUM(CASE WHEN log.entryStatus = 'verified' OR ${inApproved} THEN log.sessionHours ELSE 0 END)`,
        'verified',
      )
      .addSelect(
        `SUM(CASE WHEN log.entryStatus = 'pending' AND NOT (${inApproved}) AND COALESCE(log.approvalStatus, '') <> 'rejected' THEN log.sessionHours ELSE 0 END)`,
        'pending',
      )
      .setParameters(approvedIds.length ? { approvedIds } : {})
      .getRawOne<{ verified: string | null; pending: string | null }>();
    return {
      verifiedHours: Number(raw?.verified ?? 0) || 0,
      pendingHours: Number(raw?.pending ?? 0) || 0,
    };
  }

  /**
   * Community Service progress: each engagement counts by stage (awaiting approval 10, joined 25,
   * hours logged 50, report submitted 75, report approved 100); the path shows their average.
   */
  private communityServicePathStatus(
    participations: Array<Pick<Participation, 'id' | 'projectId' | 'status'>>,
    loggedParticipationIds: Set<string>,
    reports: ReportProjects,
    unsentAttendanceCount: number,
  ): PathStatusEntry {
    const live = participations.filter((p) => p.status !== 'rejected');
    if (live.length === 0) {
      return {
        state: 'not_started',
        needsAction: unsentAttendanceCount > 0,
        progress: 0,
        detail: 'No engagements yet',
      };
    }
    // One stage per project: a student can hold sibling seats on the same project.
    const stageByProject = new Map<string, number>();
    for (const p of live) {
      const project = String(p.projectId || p.id);
      const working =
        (WORKING_PARTICIPATION_STATUSES as readonly string[]).includes(
          p.status,
        ) || p.status === 'finalized';
      const stage = reports.approved.has(project)
        ? CS_STAGE_APPROVED
        : reports.submitted.has(project)
          ? CS_STAGE_SUBMITTED
          : loggedParticipationIds.has(p.id)
            ? CS_STAGE_LOGGING
            : working
              ? CS_STAGE_JOINED
              : CS_STAGE_PENDING;
      stageByProject.set(
        project,
        Math.max(stageByProject.get(project) ?? 0, stage),
      );
    }
    const stages = [...stageByProject.values()];
    const progress = Math.round(
      stages.reduce((sum, stage) => sum + stage, 0) / stages.length,
    );
    const approvedCount = stages.filter((s) => s === CS_STAGE_APPROVED).length;
    const activeCount = stages.length - approvedCount;
    const plural = (n: number, word: string) =>
      `${n} ${word}${n === 1 ? '' : 's'}`;
    return {
      state: activeCount === 0 ? 'complete' : 'active',
      needsAction: unsentAttendanceCount > 0,
      progress,
      detail:
        approvedCount && activeCount
          ? `${plural(approvedCount, 'approved report')} · ${plural(activeCount, 'active engagement')}`
          : approvedCount
            ? plural(approvedCount, 'approved report')
            : plural(activeCount, 'active engagement'),
    };
  }

  private async averageReportScore(userId: string): Promise<number> {
    // Only fully verified (or paid, which implies verified) reports — an abandoned draft or a
    // rejected report's stale AI score must not drag down a student's composite score.
    const reports = await this.studentReportRepo.find({
      where: {
        studentId: userId,
        status: In(['verified', 'paid']),
        admin_status: 'approved',
      },
    });
    const scores: number[] = [];
    for (const report of reports) {
      const s11 = (report.section11 ?? {}) as Record<string, unknown>;
      const score =
        this.readNumeric(s11.ai_generated_impact_score) ??
        this.readNumeric(
          (s11.cii_index as Record<string, unknown>)?.totalScore,
        ) ??
        this.readNumeric(
          (s11.cii_index as Record<string, unknown>)?.total_score,
        );
      if (score != null) scores.push(score);
    }
    if (!scores.length) return 0;
    return Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
  }

  private readNumeric(value: unknown): number | null {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Best-effort per-section rubric: the backend does not persist a strict 10-section
   * breakdown, so this distributes the composite score proportionally across each
   * section's max weight — a coherent approximation since the composite is itself a
   * weighted sum of these sections.
   */
  private rubricFromComposite(
    compositeScore: number,
  ): Record<CiiSectionBreakdownKey, number> {
    const ratio = Math.max(0, Math.min(1, compositeScore / 100));
    const out = {} as Record<CiiSectionBreakdownKey, number>;
    (Object.keys(CII_SECTION_MAX_BY_KEY) as CiiSectionBreakdownKey[]).forEach(
      (key) => {
        out[key] = Math.round(CII_SECTION_MAX_BY_KEY[key] * ratio);
      },
    );
    return out;
  }

  private band(score: number): string {
    if (score >= 85) return 'Excellent';
    if (score >= 70) return 'Strong';
    if (score >= 50) return 'Developing';
    if (score >= 25) return 'Getting started';
    return 'Not started';
  }

  private async getPathsStatus(
    userId: string,
    reports: ReportProjects,
  ): Promise<Record<string, PathStatusEntry>> {
    const [
      participations,
      loggedRows,
      unsentAttendanceCount,
      courseProjects,
      fyp,
      venture,
    ] = await Promise.all([
      this.participationRepo.find({
        where: { studentId: userId },
        select: ['id', 'projectId', 'status'],
      }),
      this.attendanceLogRepo
        .createQueryBuilder('log')
        .innerJoin('log.participant', 'p')
        .where('p.studentId = :userId', { userId })
        .andWhere("COALESCE(log.approvalStatus, '') <> 'rejected'")
        .select('log.participantId', 'participantId')
        .groupBy('log.participantId')
        .getRawMany<{ participantId: string }>(),
      this.attendanceLogRepo
        .createQueryBuilder('log')
        .innerJoin('log.participant', 'p')
        .where('p.studentId = :userId', { userId })
        .andWhere('log.approvalStatus IS NULL')
        .andWhere("log.entryStatus = 'pending'")
        .getCount(),
      this.courseProjectRepo.find({
        where: { userId },
        order: { updatedAt: 'DESC' },
      }),
      this.fypRepo.findOne({ where: { userId } }),
      this.ventureRepo.findOne({
        where: { userId },
        order: { updatedAt: 'DESC' },
      }),
    ]);

    return {
      communityService: this.communityServicePathStatus(
        participations,
        new Set(loggedRows.map((row) => String(row.participantId))),
        reports,
        unsentAttendanceCount,
      ),
      courseProject: this.courseProjectPathStatus(courseProjects),
      fypThesis: this.fypThesisPathStatus(fyp),
      startupBusiness: this.startupBusinessPathStatus(venture),
    };
  }

  /** Driven by the 8-step guided wizard's gates once it's been used at all — the legacy
   * completeness checklist (description/materialUrls) is no longer fully populated by it,
   * so it's kept only as a fallback for entries that predate the wizard. */
  private startupBusinessPathStatus(
    venture: VentureEntry | null,
  ): PathStatusEntry {
    if (!venture) {
      return {
        state: 'not_started',
        needsAction: false,
        progress: 0,
        detail: 'Not started',
      };
    }
    const usesWizard =
      venture.stepCompleted > 0 || venture.status === 'submitted';
    if (!usesWizard) {
      const ventureCompleteness = ventureCompletenessPercent(venture);
      return {
        state: venture.isVisible ? 'complete' : 'active',
        needsAction:
          !venture.isVisible &&
          ventureCompleteness >= VENTURE_VISIBILITY_THRESHOLD,
        progress: ventureCompleteness,
        detail: `${ventureCompleteness}% profile complete`,
      };
    }
    const gates = computeVentureGates(venture);
    return {
      state: gates.showcaseOk ? 'complete' : 'active',
      needsAction:
        venture.status !== 'submitted' &&
        venture.stepCompleted < VENTURE_TOTAL_STEPS,
      progress: Math.round((venture.stepCompleted / VENTURE_TOTAL_STEPS) * 100),
      detail:
        venture.status === 'submitted'
          ? gates.investmentReadyOk
            ? 'Investment Ready'
            : gates.showcaseOk
              ? 'Showcase Ready'
              : 'Submitted for review'
          : `Step ${venture.stepCompleted}/${VENTURE_TOTAL_STEPS} complete`,
    };
  }

  /** Driven by the 9-step guided wizard's stepCompleted/status — the legacy milestone timeline is no longer edited by the frontend. */
  private fypThesisPathStatus(fyp: FypEntry | null): PathStatusEntry {
    if (!fyp) {
      return {
        state: 'not_started',
        needsAction: false,
        progress: 0,
        detail: 'Not started',
      };
    }
    const stepCompleted = fyp.stepCompleted ?? 0;
    const isSubmitted = fyp.status === 'submitted';
    return {
      state: isSubmitted ? 'complete' : 'active',
      needsAction: !isSubmitted && stepCompleted < FYP_TOTAL_STEPS,
      progress: Math.round(
        ((isSubmitted ? FYP_TOTAL_STEPS : stepCompleted) / FYP_TOTAL_STEPS) *
          100,
      ),
      detail: isSubmitted
        ? 'Submitted for sign-off'
        : `Step ${stepCompleted}/${FYP_TOTAL_STEPS} complete`,
    };
  }

  /** A student can hold a whole deck of coursework reports now, not just one — summarize across all of them. */
  private courseProjectPathStatus(
    entries: CourseProjectEntry[],
  ): PathStatusEntry {
    if (entries.length === 0) {
      return {
        state: 'not_started',
        needsAction: false,
        progress: 0,
        detail: 'Not started',
      };
    }
    const submittedCount = entries.filter(
      (e) => e.status === 'submitted',
    ).length;
    const draftCount = entries.length - submittedCount;
    // entries is ordered updatedAt DESC, so this is whichever draft the student touched most recently.
    const latestDraft = entries.find((e) => e.status !== 'submitted');
    return {
      // Matches fypThesisPathStatus/startupBusinessPathStatus: 'complete' once nothing is left
      // in draft — previously hardcoded 'active' even when every report had been submitted.
      state: draftCount > 0 ? 'active' : 'complete',
      needsAction:
        !!latestDraft && latestDraft.stepCompleted < COURSE_PROJECT_TOTAL_STEPS,
      progress: Math.round(
        ((latestDraft?.stepCompleted ?? COURSE_PROJECT_TOTAL_STEPS) /
          COURSE_PROJECT_TOTAL_STEPS) *
          100,
      ),
      detail:
        draftCount > 0
          ? `${submittedCount} verified · ${draftCount} in progress`
          : `${submittedCount} verified report${submittedCount === 1 ? '' : 's'}`,
    };
  }
}

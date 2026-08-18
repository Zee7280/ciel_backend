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

const WORKING_PARTICIPATION_STATUSES = [
  'approved',
  'verified',
  'paid',
  'accepted',
] as const;

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
  ) {}

  async getSummary(userId: string) {
    const [
      verifiedHours,
      pendingHours,
      activeEngagements,
      compositeScore,
      pathsStatus,
    ] = await Promise.all([
      this.sumHoursByStatus(userId, 'verified'),
      this.sumHoursByStatus(userId, 'pending'),
      this.participationRepo.count({
        where: {
          studentId: userId,
          status: In([...WORKING_PARTICIPATION_STATUSES]),
        },
      }),
      this.averageReportScore(userId),
      this.getPathsStatus(userId),
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

  private async sumHoursByStatus(
    userId: string,
    entryStatus: 'verified' | 'pending',
  ) {
    const raw = await this.attendanceLogRepo
      .createQueryBuilder('log')
      .innerJoin('log.participant', 'p')
      .where('p.studentId = :userId', { userId })
      .andWhere('log.entryStatus = :entryStatus', { entryStatus })
      .select('SUM(log.sessionHours)', 'total')
      .getRawOne<{ total: string | null }>();
    return Number(raw?.total ?? 0);
  }

  private async averageReportScore(userId: string): Promise<number> {
    const reports = await this.studentReportRepo.find({
      where: { studentId: userId },
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
  ): Promise<Record<string, PathStatusEntry>> {
    const [
      communityServiceCount,
      unsentAttendanceCount,
      courseProjects,
      fyp,
      venture,
    ] = await Promise.all([
      this.participationRepo.count({ where: { studentId: userId } }),
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
      this.ventureRepo.findOne({ where: { userId } }),
    ]);

    return {
      communityService: {
        state: communityServiceCount > 0 ? 'active' : 'not_started',
        needsAction: unsentAttendanceCount > 0,
        progress: Math.min(100, communityServiceCount * 25),
        detail:
          communityServiceCount > 0
            ? `${communityServiceCount} active engagement${communityServiceCount === 1 ? '' : 's'}`
            : 'No engagements yet',
      },
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
      return { state: 'not_started', needsAction: false, progress: 0, detail: 'Not started' };
    }
    const usesWizard = venture.stepCompleted > 0 || venture.status === 'submitted';
    if (!usesWizard) {
      const ventureCompleteness = ventureCompletenessPercent(venture);
      return {
        state: venture.isVisible ? 'complete' : 'active',
        needsAction: !venture.isVisible && ventureCompleteness >= VENTURE_VISIBILITY_THRESHOLD,
        progress: ventureCompleteness,
        detail: `${ventureCompleteness}% profile complete`,
      };
    }
    const gates = computeVentureGates(venture);
    return {
      state: gates.showcaseOk ? 'complete' : 'active',
      needsAction: venture.status !== 'submitted' && venture.stepCompleted < VENTURE_TOTAL_STEPS,
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
      state: 'active',
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

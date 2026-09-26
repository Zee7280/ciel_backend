import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  In,
  Repository,
  SelectQueryBuilder,
  WhereExpressionBuilder,
} from 'typeorm';
import * as crypto from 'crypto';
import { StudentReport } from './entities/student-report.entity';
import { StudentReportsService } from './student-reports.service';
import { FacultyService } from '../faculty/faculty.service';
import { AiService } from '../ai/ai.service';
import { computeCiiV2Result } from './cii-v2.constants';
import { buildCielPkAiEvaluationPayload } from './build-ciel-pk-ai-evaluation-payload.util';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import {
  resolveReportFlashEvidence,
  resolveReportFlashHours,
} from './community-award.util';

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** List-card CII fields only — never mutates scores or lock state. */
export function mapFacultyListCii(report: {
  ciiV2?: unknown;
  ciiV2Lock?: { locked?: unknown } | null;
}): {
  cii_analyser_run: boolean;
  cii_provisional: number | null;
  cii_locked: boolean;
  cii_level_name: string | null;
  cii_numeric_level: number | null;
} {
  const ciiV2 =
    report.ciiV2 && typeof report.ciiV2 === 'object'
      ? (report.ciiV2 as Record<string, unknown>)
      : null;
  const finalNum = finiteNumber(ciiV2?.final);
  const ciiFinal = finalNum == null ? null : Math.round(finalNum * 10) / 10;
  const level =
    ciiV2?.level && typeof ciiV2.level === 'object'
      ? (ciiV2.level as { name?: unknown; level?: unknown })
      : null;
  const lockedRaw = report.ciiV2Lock?.locked;
  const levelName =
    typeof level?.name === 'string' && level.name.trim() ? level.name : null;
  return {
    cii_analyser_run: ciiFinal != null,
    cii_provisional: ciiFinal,
    cii_locked: lockedRaw === true || lockedRaw === 'true',
    cii_level_name: levelName,
    cii_numeric_level:
      finiteNumber(ciiV2?.numericLevel) ?? finiteNumber(level?.level),
  };
}

function pickListNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function pickListString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function mapFacultyListPackage(
  report: StudentReport,
  liveHours = 0,
): {
  university: string | null;
  faculty_name: string | null;
  story: string | null;
  evidence_count: number;
  participation_type: string;
  member_hours: Array<{ name: string; hours: number; required: number }>;
  required_hours: number;
} {
  const s1 = report.section1 as StudentReport['section1'] | null;
  const s2 = report.section2 as StudentReport['section2'] | null;
  const lead = s1?.team_lead;
  const members = Array.isArray(s1?.team_members) ? s1.team_members : [];
  const required =
    Number(
      (report.opportunity?.timeline as { expected_hours?: unknown } | undefined)
        ?.expected_hours,
    ) || 16;
  const flashHours = resolveReportFlashHours(report.section1, liveHours);
  const memberHours = [
    lead
      ? {
          name: pickListString(lead.name, report.student?.name) || 'Student',
          hours: pickListNumber(lead.hours) || (members.length ? 0 : flashHours),
          required,
        }
      : {
          name: report.student?.name || 'Student',
          hours: flashHours,
          required,
        },
    ...members.map((member) => ({
      name: pickListString(member.name) || 'Member',
      hours: pickListNumber(member.hours),
      required,
    })),
  ];
  const supervision =
    report.opportunity?.supervision &&
    typeof report.opportunity.supervision === 'object'
      ? (report.opportunity.supervision as Record<string, unknown>)
      : {};
  return {
    university:
      pickListString(
        lead?.university,
        report.student?.university,
        report.student?.institution,
      ) || null,
    faculty_name:
      pickListString(
        (s1 as { faculty_supervisor_name?: string } | null)
          ?.faculty_supervisor_name,
        report.faculty?.name,
        supervision.supervisor_name,
        supervision.supervisorName,
      ) || null,
    story:
      pickListString(s2?.summary_text, s2?.problem_statement) || null,
    evidence_count: resolveReportFlashEvidence(report),
    participation_type: s1?.participation_type || 'individual',
    member_hours: memberHours,
    required_hours: required,
  };
}

@Injectable()
export class FacultyReportsService {
  constructor(
    @InjectRepository(StudentReport)
    private studentReportsRepository: Repository<StudentReport>,
    private readonly studentReportsService: StudentReportsService,
    private readonly facultyService: FacultyService,
    private readonly aiService: AiService,
    private readonly facultyUniversityScopeService: FacultyUniversityScopeService,
    @InjectRepository(AttendanceLog)
    private readonly attendanceLogsRepository: Repository<AttendanceLog>,
  ) {}

  private normalizeFacultyEmail(facultyEmail: string): string {
    return (facultyEmail || '').trim().toLowerCase();
  }

  /**
   * Align report visibility with faculty dashboard / approvals scope:
   * UUID assignment, scoped opportunities, supervision emails, applications, participations.
   */
  private applyFacultyAccessFilter(
    qb: WhereExpressionBuilder,
    facultyId: string,
    facultyEmail: string,
    scopedOpportunityIds: string[],
  ) {
    const fe = this.normalizeFacultyEmail(facultyEmail);

    qb.where('report.facultyId = :facultyId', { facultyId }).orWhere(
      'opportunity.facultyId = :facultyId',
      { facultyId },
    );

    if (scopedOpportunityIds.length > 0) {
      qb.orWhere('report."opportunityId"::text IN (:...scopedOppIds)', {
        scopedOppIds: scopedOpportunityIds,
      }).orWhere(
        `TRIM(COALESCE(report.project_id, '')) IN (:...scopedOppIds)`,
        {
          scopedOppIds: scopedOpportunityIds,
        },
      );
    }

    if (!fe) {
      return;
    }

    qb.orWhere(
      `LOWER(TRIM(COALESCE(report.section1->>'faculty_supervisor_email', ''))) = :fe`,
      { fe },
    )
      .orWhere(
        `LOWER(TRIM(COALESCE(opportunity.supervision->>'contact', ''))) = :fe`,
        { fe },
      )
      .orWhere(
        `LOWER(TRIM(COALESCE(opportunity.supervision->>'official_email', ''))) = :fe`,
        { fe },
      )
      .orWhere(
        `LOWER(TRIM(COALESCE(opportunity.partner_organization->>'official_email', ''))) = :fe`,
        { fe },
      )
      .orWhere(
        `EXISTS (
                    SELECT 1 FROM participations p
                    WHERE (
                        p.project_id::text = report."opportunityId"::text
                        OR p.project_id::text = TRIM(COALESCE(report.project_id, ''))
                    )
                    AND (
                        LOWER(TRIM(COALESCE(p."facultySupervisorEmail", ''))) = :fe
                        OR LOWER(TRIM(COALESCE(p."primaryFacultyEmail", ''))) = :fe
                        OR LOWER(TRIM(COALESCE(p."secondaryFacultyEmail", ''))) = :fe
                    )
                )`,
        { fe },
      )
      .orWhere(
        `EXISTS (
                    SELECT 1 FROM opportunity_applications app
                    WHERE app.opportunity_id::text = report."opportunityId"::text
                    AND app.withdrawn_at IS NULL
                    AND (
                        LOWER(TRIM(COALESCE(app.primary_faculty_email, ''))) = :fe
                        OR LOWER(TRIM(COALESCE(app.secondary_faculty_email, ''))) = :fe
                    )
                )`,
        { fe },
      );
  }

  private baseReportQuery(): SelectQueryBuilder<StudentReport> {
    return this.studentReportsRepository
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.student', 'student')
      .leftJoinAndSelect('report.faculty', 'faculty')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('opportunity.organization', 'organization');
  }

  async listAssignedReports(facultyId: string, facultyEmail: string) {
    const scopedOpportunityIds =
      await this.facultyService.getScopedOpportunityIds(
        facultyId,
        facultyEmail,
      );

    const reports = await this.baseReportQuery()
      .where(
        new Brackets((qb) =>
          this.applyFacultyAccessFilter(
            qb,
            facultyId,
            facultyEmail,
            scopedOpportunityIds,
          ),
        ),
      )
      // Faculty is the sole *first* report approver (see verifyReport()'s admin-approve
      // gate, which itself requires faculty_status === 'approved') — so faculty must see a
      // report as soon as the student submits it, not only after Admin has already approved.
      // Requiring admin_status = 'approved' here made every report unreachable by anyone:
      // Admin can't approve until Faculty has, and Faculty couldn't see it until Admin had.
      .andWhere("report.status != 'draft'")
      .orderBy('report.submission_date', 'DESC')
      .getMany();

    return reports;
  }

  /** Same submit bar: rejected sessions do not count; pending sessions do. */
  private loggedHoursForProject(
    logs: Pick<AttendanceLog, 'approvalStatus' | 'sessionHours'>[],
  ): number {
    return logs.reduce((sum, log) => {
      if (String(log.approvalStatus || '').toLowerCase() === 'rejected') return sum;
      return sum + (Number(log.sessionHours) || 0);
    }, 0);
  }

  async findAll(facultyId: string, facultyEmail: string) {
    const reports = await this.listAssignedReports(facultyId, facultyEmail);
    const projectIds = [
      ...new Set(
        reports
          .map((r) => (r.opportunityId || r.project_id || '').trim())
          .filter(Boolean),
      ),
    ];
    const logs = projectIds.length
      ? await this.attendanceLogsRepository.find({
          where: { projectId: In(projectIds) },
        })
      : [];
    const hoursByProject = new Map<string, number>();
    for (const projectId of projectIds) {
      hoursByProject.set(
        projectId,
        this.loggedHoursForProject(logs.filter((log) => log.projectId === projectId)),
      );
    }

    return {
      success: true,
      data: reports.map((r) => ({
        id: r.id,
        student_name: r.student?.name || 'Unknown',
        student_email: r.student?.email || null,
        project_title: r.opportunity?.title || r.project_id,
        organization_name: r.opportunity?.organization?.name || 'N/A',
        status: r.status,
        faculty_status: r.faculty_status,
        project_id: r.opportunityId || r.project_id || null,
        hours: resolveReportFlashHours(
          r.section1,
          hoursByProject.get((r.opportunityId || r.project_id || '').trim()) || 0,
        ),
        submission_date: r.submission_date,
        report_submitted_at: r.reportSubmittedAt,
        partner_approved_at: r.partnerApprovedAt,
        admin_approved_at: r.adminApprovedAt,
        updated_at: r.updatedAt,
        metrics: r.section1?.metrics,
        ...mapFacultyListCii(r),
        ...mapFacultyListPackage(
          r,
          hoursByProject.get((r.opportunityId || r.project_id || '').trim()) || 0,
        ),
      })),
    };
  }

  async findOne(id: string, facultyId: string, facultyEmail: string) {
    const scopedOpportunityIds =
      await this.facultyService.getScopedOpportunityIds(
        facultyId,
        facultyEmail,
      );

    const report = await this.baseReportQuery()
      .where('report.id = :id', { id })
      .andWhere(
        new Brackets((qb) =>
          this.applyFacultyAccessFilter(
            qb,
            facultyId,
            facultyEmail,
            scopedOpportunityIds,
          ),
        ),
      )
      .andWhere("report.status != 'draft'")
      .getOne();

    if (!report) {
      throw new NotFoundException(
        'Report not found, not assigned to you, or not yet submitted',
      );
    }

    return this.studentReportsService.buildDetailResponse(report);
  }

  /** Shared lookup for faculty-scoped mutations (decision actions, CII v2 analyse/approve). */
  private async findAssignedReportForAction(
    id: string,
    facultyId: string,
    facultyEmail: string,
  ): Promise<StudentReport> {
    const scopedOpportunityIds =
      await this.facultyService.getScopedOpportunityIds(
        facultyId,
        facultyEmail,
      );

    const report = await this.studentReportsRepository
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('report.student', 'student')
      .where('report.id = :id', { id })
      .andWhere(
        new Brackets((qb) =>
          this.applyFacultyAccessFilter(
            qb,
            facultyId,
            facultyEmail,
            scopedOpportunityIds,
          ),
        ),
      )
      .andWhere("report.status != 'draft'")
      .getOne();

    if (!report) {
      throw new NotFoundException(
        'Report not found, not assigned to you, or not yet submitted',
      );
    }

    return report;
  }

  async updateAction(
    id: string,
    facultyId: string,
    facultyEmail: string,
    status: 'approved' | 'rejected',
    remarks?: string,
  ) {
    const report = await this.findAssignedReportForAction(
      id,
      facultyId,
      facultyEmail,
    );

    if (status === 'rejected' && !remarks?.trim()) {
      throw new BadRequestException(
        'A reason is required when rejecting a report.',
      );
    }

    // Once the CII v2 record is locked the review decision is final — mirrors the
    // lock checks in runCiiV2Analysis/approveCiiV2 so faculty_status can't be flipped
    // afterwards into a state contradicting the locked score.
    if (report.ciiV2Lock?.locked) {
      throw new BadRequestException(
        "This report's CII v2 analysis is locked; further review actions are not permitted.",
      );
    }

    // A targeted column update — not repository.save(report) — so this can never clobber
    // ciiV2/ciiV2Lock with the stale values this method's own read happened to see, if a
    // concurrent CII v2 analysis/approval writes those columns in between.
    await this.studentReportsRepository.update(
      { id: report.id },
      {
        faculty_status: status,
        ...(remarks ? { faculty_remarks: remarks } : {}),
      },
    );

    return {
      success: true,
      message: `Report ${status} successfully.`,
      data: {
        id: report.id,
        faculty_status: status,
      },
    };
  }

  /** Runs the CII v2 AI evaluation and persists a server-recomputed score snapshot. Re-runnable while unlocked. */
  async runCiiV2Analysis(id: string, facultyId: string, facultyEmail: string) {
    const report = await this.findAssignedReportForAction(
      id,
      facultyId,
      facultyEmail,
    );

    if (report.ciiV2Lock?.locked) {
      throw new BadRequestException(
        "This report's CII v2 score is already locked and cannot be re-analysed.",
      );
    }

    // Reuse the canonical, security-reviewed payload builder (strips CNIC, legacy scores and
    // other sensitive/internal fields) instead of forwarding raw section JSON to the AI vendor.
    const payload = buildCielPkAiEvaluationPayload(report);

    const { ciiV2 } = await this.aiService.summarize(
      'cii_v2_evaluation',
      payload,
    );
    if (!ciiV2) {
      throw new BadRequestException(
        'The AI did not return a readable CII v2 evaluation. Please retry.',
      );
    }

    const result = computeCiiV2Result({
      sections: ciiV2.sections,
      bonus: ciiV2.bonus,
      integrityPenalty: ciiV2.integrityPenalty,
      evidence: ciiV2.evidence,
    });

    const nextCiiV2 = {
      ...result,
      bonusWhy: ciiV2.bonusWhy,
      integrityWhy: ciiV2.integrityWhy,
      redFlags: ciiV2.redFlags,
      needsAdminReview: ciiV2.needsAdminReview,
      studentFeedback: ciiV2.studentFeedback,
      frameworkVersion: ciiV2.frameworkVersion,
      computedAt: new Date().toISOString(),
    };

    // Targeted, guarded update: only touches the ciiV2 column (never ciiV2Lock or any other
    // field this method didn't read/intend to change), and re-checks "not locked" at write
    // time in case the AI call above raced with a concurrent approve.
    const updateResult = await this.studentReportsRepository
      .createQueryBuilder()
      .update(StudentReport)
      .set({ ciiV2: nextCiiV2 })
      .where('id = :id', { id: report.id })
      .andWhere(
        `("ciiV2Lock" IS NULL OR ("ciiV2Lock"->>'locked') IS DISTINCT FROM 'true')`,
      )
      .execute();

    if (!updateResult.affected) {
      throw new BadRequestException(
        "This report's CII v2 score is already locked and cannot be re-analysed.",
      );
    }

    return { success: true, data: nextCiiV2 };
  }

  /**
   * Phase 2: Approves and hash-locks the CII v2 score with audit trail.
   *
   * Recomputes the final score from the stored per-criterion anchors (never trusts a
   * client-sent score) before hashing the decision.
   *
   * If faculty adjusts the score, the system stores both:
   * - AI Recommended Score (original)
   * - Faculty Approved Score (adjusted)
   * - Score Adjustment Reason (audit trail)
   * - Per-criterion overrides (if any)
   */
  async approveCiiV2(
    id: string,
    facultyId: string,
    facultyEmail: string,
    note?: string,
    facultyAdjustedScore?: number,
    scoreAdjustmentReason?: string,
    criteriaOverrides?: Record<
      string,
      { aiAnchor: number; facultyAnchor: number; reason: string }
    >,
  ) {
    const report = await this.findAssignedReportForAction(
      id,
      facultyId,
      facultyEmail,
    );

    const stored = report.ciiV2 as
      | {
          sections: Array<{
            id: number;
            good?: string;
            limit?: string;
            criteria: Array<{ key: string; anchor: number; note?: string }>;
          }>;
          bonus: { effort: number; resources: number; partners: number };
          integrityPenalty: number;
          evidence?: unknown[];
          computedAt?: string;
          final?: number;
        }
      | null
      | undefined;

    if (!stored) {
      throw new BadRequestException(
        'Run the CII v2 analysis before approving.',
      );
    }
    if (report.ciiV2Lock?.locked) {
      throw new BadRequestException(
        "This report's CII v2 score is already locked.",
      );
    }

    // Compute the AI-recommended score from stored anchors
    const aiResult = computeCiiV2Result({
      sections: stored.sections.map((s) => ({
        id: s.id,
        good: s.good,
        limit: s.limit,
        criteria: s.criteria.map((c) => ({
          key: c.key,
          anchor: c.anchor,
          note: c.note,
        })),
      })),
      bonus: stored.bonus,
      integrityPenalty: stored.integrityPenalty,
      evidence: (stored.evidence as any) || [],
    });

    const aiRecommendedScore = aiResult.final;

    // Determine the faculty-approved score
    // If faculty provided an adjusted score, use it; otherwise use AI score
    const hasFacultyAdjustment =
      facultyAdjustedScore !== undefined &&
      Math.round(facultyAdjustedScore) !== Math.round(aiRecommendedScore);

    // Require reason when faculty adjusts the score
    if (hasFacultyAdjustment && !scoreAdjustmentReason?.trim()) {
      throw new BadRequestException(
        'A reason is required when adjusting the AI-recommended score.',
      );
    }

    const facultyApprovedScore = hasFacultyAdjustment
      ? Math.round(Math.min(100, Math.max(0, facultyAdjustedScore)))
      : aiRecommendedScore;

    // Use the same AI-computed level structure, but note the score adjustment
    // Level is still determined by the AI anchors (not the override score)
    // to maintain consistency with the rubric
    const finalResult = aiResult;

    const approvedAt = new Date().toISOString();

    // Build the audit-ready decision record
    const decisionRecord = {
      reportId: report.id,
      aiRecommendedScore,
      facultyApprovedScore,
      scoreWasAdjusted: hasFacultyAdjustment,
      scoreAdjustmentReason: hasFacultyAdjustment
        ? scoreAdjustmentReason
        : null,
      criteriaOverrides: criteriaOverrides || null,
      level: finalResult.level.level,
      badge: finalResult.level.name,
      facultyId,
      approvedAt,
      note: note || '',
    };

    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(decisionRecord))
      .digest('hex');

    const nextCiiV2 = {
      ...(report.ciiV2 as Record<string, unknown>),
      ...finalResult,
      // Store both scores for audit trail
      aiRecommendedScore,
      facultyApprovedScore,
      final: facultyApprovedScore, // The final score is what faculty approved
      computedAt: stored.computedAt || approvedAt,
    };

    const nextCiiV2Lock = {
      locked: true,
      hash,
      lockedAt: approvedAt,
      lockedByFacultyId: facultyId,
      facultyNote: note,
      // Phase 2: Audit trail fields
      aiRecommendedScore,
      facultyApprovedScore,
      scoreWasAdjusted: hasFacultyAdjustment,
      scoreAdjustmentReason: hasFacultyAdjustment
        ? scoreAdjustmentReason
        : null,
      criteriaOverrides: criteriaOverrides || null,
    };

    // Atomic compare-and-swap: the WHERE guard re-checks "not already locked" at write time
    // (not just at the read above), so two concurrent approve requests can't both win the lock —
    // the second one's UPDATE affects 0 rows instead of silently overwriting the first's decision.
    const updateResult = await this.studentReportsRepository
      .createQueryBuilder()
      .update(StudentReport)
      .set({
        ciiV2: nextCiiV2,
        ciiV2Lock: nextCiiV2Lock as StudentReport['ciiV2Lock'],
        faculty_status: 'approved',
      })
      .where('id = :id', { id: report.id })
      .andWhere(
        `("ciiV2Lock" IS NULL OR ("ciiV2Lock"->>'locked') IS DISTINCT FROM 'true')`,
      )
      .execute();

    if (!updateResult.affected) {
      throw new BadRequestException(
        "This report's CII v2 score is already locked.",
      );
    }

    return {
      success: true,
      data: { ciiV2: nextCiiV2, ciiV2Lock: nextCiiV2Lock },
    };
  }

  /** Scoping for runIndependentAiAnalysis, split out by caller role — previously this method
   * took no scope at all (any faculty could run it against any report id, university/ciel_admin
   * had no route yet). Faculty reuses the same assignment-based scope as runCiiV2Analysis;
   * university is restricted to reports whose student's profile matches the caller's university
   * org (same rule FacultyUniversityScopeService uses elsewhere); ciel_admin/CIEL PK has no scope
   * restriction, matching SUPER_ADMIN's usual platform-wide access. */
  private async findReportForIndependentAnalysis(
    reportId: string,
    userId: string,
    userRole: 'faculty' | 'university' | 'ciel_admin',
    scope?: { facultyEmail?: string; universityOrganizationName?: string },
  ): Promise<StudentReport> {
    if (userRole === 'faculty') {
      return this.findAssignedReportForAction(
        reportId,
        userId,
        scope?.facultyEmail || '',
      );
    }

    const report = await this.studentReportsRepository.findOne({
      where: { id: reportId },
      relations: ['student'],
    });
    if (!report) {
      throw new NotFoundException('Report not found.');
    }

    if (userRole === 'university') {
      const orgNameNorm = this.facultyUniversityScopeService.normalizeOrgName(
        scope?.universityOrganizationName || '',
      );
      const matches =
        !!orgNameNorm &&
        this.facultyUniversityScopeService.studentProfileMatchesOrganization(
          report.student,
          orgNameNorm,
        );
      if (!matches) {
        throw new NotFoundException(
          'Report not found, or not from a student at your university.',
        );
      }
    }

    return report;
  }

  /**
   * Phase 4: Run Independent AI Analysis from My Impact Wall.
   *
   * This is for authorized stakeholders (Faculty, University, CIEL PK) to run
   * additional AI analysis on an already-approved record WITHOUT overwriting
   * the faculty-approved score.
   *
   * - Uses the same approved formula/rubric
   * - Results stored in `independentAiAnalyses` array
   * - Creates an audit trail with who ran it and when
   * - The faculty-approved record remains unchanged
   * - Scoped per caller role — see findReportForIndependentAnalysis.
   */
  async runIndependentAiAnalysis(
    reportId: string,
    userId: string,
    userRole: 'faculty' | 'university' | 'ciel_admin',
    userName?: string,
    note?: string,
    scope?: { facultyEmail?: string; universityOrganizationName?: string },
  ) {
    const report = await this.findReportForIndependentAnalysis(
      reportId,
      userId,
      userRole,
      scope,
    );

    // Only allow independent analysis on locked (approved) records
    if (!report.ciiV2Lock?.locked) {
      throw new BadRequestException(
        'Independent AI analysis can only be run on faculty-approved records.',
      );
    }

    // Build the AI evaluation payload (same as faculty stage)
    const aiPayload = buildCielPkAiEvaluationPayload(report);

    // Run the AI analysis using the same method as runCiiV2Analysis
    const { ciiV2 } = await this.aiService.summarize(
      'cii_v2_evaluation',
      aiPayload,
    );

    if (!ciiV2) {
      throw new BadRequestException(
        'AI analysis failed. Please try again later.',
      );
    }

    // Compute the CII v2 result using the same formula/rubric
    const ciiResult = computeCiiV2Result({
      sections: ciiV2.sections,
      bonus: ciiV2.bonus,
      integrityPenalty: ciiV2.integrityPenalty,
      evidence: ciiV2.evidence || [],
    });

    // Build the independent analysis record
    const analysisId = crypto.randomUUID();
    const runAt = new Date().toISOString();

    const independentAnalysis = {
      id: analysisId,
      runAt,
      runByUserId: userId,
      runByRole: userRole,
      runByName: userName,
      score: ciiResult.final,
      level: ciiResult.level,
      sections: ciiResult.sections.map((s) => ({
        id: s.id,
        title: s.title,
        score: s.score,
        weight: s.weight,
        good: s.good,
        limit: s.limit,
      })),
      bonus: ciiResult.bonus,
      integrityPenalty: ciiResult.integrityPenalty,
      feedback: ciiV2.studentFeedback || undefined,
      note: note || undefined,
    };

    // Append to the existing array (don't overwrite)
    const existingAnalyses = report.independentAiAnalyses || [];
    const updatedAnalyses = [...existingAnalyses, independentAnalysis];

    // Update the report with the new analysis
    await this.studentReportsRepository.update(report.id, {
      independentAiAnalyses:
        updatedAnalyses as StudentReport['independentAiAnalyses'],
    });

    return {
      success: true,
      data: {
        analysis: independentAnalysis,
        // Also return the original faculty-approved score for comparison
        facultyApprovedScore:
          report.ciiV2Lock?.facultyApprovedScore ??
          (report.ciiV2 as Record<string, unknown> | null)?.final ??
          null,
        aiRecommendedScore:
          report.ciiV2Lock?.aiRecommendedScore ??
          (report.ciiV2 as Record<string, unknown> | null)
            ?.aiRecommendedScore ??
          null,
      },
    };
  }

  /** Batch counterpart to runIndependentAiAnalysis — the actual "run for the whole batch" action
   * a faculty/university/CIEL PK caller triggers from their Community Service pool. Each report
   * runs the identical per-report method (same scoping, same lock requirement, same audit-trail
   * append), so a fresh, dated entry lands in that student's own `independentAiAnalyses` history —
   * this per-report history IS the "trend" surfaced on My Impact Wall; there is no separate trend
   * store to keep in sync. Runs sequentially and never throws for an individual failure (a locked
   * report elsewhere in the batch, one outside the caller's scope, a transient AI error) so one bad
   * id can't abort everyone else's update — each outcome is reported back instead. */
  private static readonly MAX_BATCH_SIZE = 100;

  async runIndependentAiAnalysisBatch(
    reportIds: string[],
    userId: string,
    userRole: 'faculty' | 'university' | 'ciel_admin',
    userName?: string,
    note?: string,
    scope?: { facultyEmail?: string; universityOrganizationName?: string },
  ) {
    const ids = Array.from(new Set((reportIds || []).filter(Boolean)));
    if (ids.length === 0) {
      throw new BadRequestException('reportIds must include at least one report id.');
    }
    if (ids.length > FacultyReportsService.MAX_BATCH_SIZE) {
      throw new BadRequestException(
        `A single batch run is limited to ${FacultyReportsService.MAX_BATCH_SIZE} reports at a time — split this into more than one run.`,
      );
    }

    const results: Array<{
      reportId: string;
      success: boolean;
      score?: number;
      error?: string;
    }> = [];

    for (const reportId of ids) {
      try {
        const result = await this.runIndependentAiAnalysis(
          reportId,
          userId,
          userRole,
          userName,
          note,
          scope,
        );
        results.push({
          reportId,
          success: true,
          score: result.data.analysis.score,
        });
      } catch (err) {
        results.push({
          reportId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return {
      success: true,
      data: {
        total: ids.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      },
    };
  }
}

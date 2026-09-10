import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
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

@Injectable()
export class FacultyReportsService {
  constructor(
    @InjectRepository(StudentReport)
    private studentReportsRepository: Repository<StudentReport>,
    private readonly studentReportsService: StudentReportsService,
    private readonly facultyService: FacultyService,
    private readonly aiService: AiService,
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

  async findAll(facultyId: string, facultyEmail: string) {
    const reports = await this.listAssignedReports(facultyId, facultyEmail);

    return {
      success: true,
      data: reports.map((r) => ({
        id: r.id,
        student_name: r.student?.name || 'Unknown',
        student_email: r.student?.email || 'Unknown',
        project_title: r.opportunity?.title || r.project_id,
        organization_name: r.opportunity?.organization?.name || 'N/A',
        status: r.status,
        faculty_status: r.faculty_status,
        hours: Number(r.section1?.metrics?.total_verified_hours ?? 0) || 0,
        submission_date: r.submission_date,
        report_submitted_at: r.reportSubmittedAt,
        partner_approved_at: r.partnerApprovedAt,
        admin_approved_at: r.adminApprovedAt,
        metrics: r.section1?.metrics,
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
   * Approves and hash-locks the CII v2 score. Recomputes the final score from the stored
   * per-criterion anchors (never trusts a client-sent score) before hashing the decision.
   */
  async approveCiiV2(
    id: string,
    facultyId: string,
    facultyEmail: string,
    note?: string,
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

    const result = computeCiiV2Result({
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

    const approvedAt = new Date().toISOString();
    const decisionRecord = {
      reportId: report.id,
      final: result.final,
      level: result.level.level,
      badge: result.level.name,
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
      ...result,
      computedAt: stored.computedAt || approvedAt,
    };
    const nextCiiV2Lock = {
      locked: true,
      hash,
      lockedAt: approvedAt,
      lockedByFacultyId: facultyId,
      facultyNote: note,
    };

    // Atomic compare-and-swap: the WHERE guard re-checks "not already locked" at write time
    // (not just at the read above), so two concurrent approve requests can't both win the lock —
    // the second one's UPDATE affects 0 rows instead of silently overwriting the first's decision.
    const updateResult = await this.studentReportsRepository
      .createQueryBuilder()
      .update(StudentReport)
      .set({
        ciiV2: nextCiiV2,
        ciiV2Lock: nextCiiV2Lock,
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
}

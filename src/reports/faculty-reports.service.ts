import {
  BadRequestException,
  ConflictException,
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
import { AiService, EvidenceInspection } from '../ai/ai.service';
import { computeReportProgress } from './report-progress.util';
import {
  buildCielPkAiEvaluationPayloadV45,
  computeCiiV45InputFingerprint,
  CielPkAiEvaluationPayloadV45,
} from './build-ciel-pk-ai-evaluation-payload.util';
import {
  applyAdminEvidenceAssessment,
  computeCiiV45Result,
  normalizeCiiV5AiPayload,
  resolveBadgeForScore,
  CII_V45_EVIDENCE_DIMENSION,
  CiiV45Anchor,
  CiiV45EvaluatorPayload,
  CiiV45Result,
  CiiV45ValidationError,
} from './cii-v4-5.constants';
import {
  pickCiiV45DisplayBadge,
  pickCiiV45DisplayScore,
} from './cii-v4-5-display.util';
import { S3Service } from '../common/s3.service';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  resolveReportFlashEvidence,
  resolveReportFlashHours,
} from './community-award.util';
import { isPrivateCandidateOpportunity, reviewRouteForOpportunity } from '../opportunities/private-candidate.util';
import { composeFacultyReportRemarks } from './faculty-report-remarks.util';
import { trackingOrganizationName } from './tracking-org-name.util';

/** List-card CII fields only — never mutates scores or lock state. */
export function mapFacultyListCii(report: {
  ciiV45?: unknown;
  ciiV45Lock?: { locked?: unknown; adminApprovedScore?: unknown } | null;
}): {
  cii_analyser_run: boolean;
  cii_provisional: number | null;
  cii_locked: boolean;
  cii_level_name: string | null;
  cii_numeric_level: number | null;
} {
  const score = pickCiiV45DisplayScore(report.ciiV45, report.ciiV45Lock);
  const ciiFinal = score == null ? null : Math.round(score * 10) / 10;
  const lockedRaw = report.ciiV45Lock?.locked;
  const locked = lockedRaw === true || lockedRaw === 'true';
  // Don't advertise a /100 badge from the /85 mix while Admin evidence is still pending.
  const badge =
    ciiFinal != null || locked ? pickCiiV45DisplayBadge(report.ciiV45, report.ciiV45Lock) : null;
  const stored =
    report.ciiV45 && typeof report.ciiV45 === 'object' && !Array.isArray(report.ciiV45)
      ? (report.ciiV45 as { aiReportScore?: unknown })
      : undefined;
  return {
    cii_analyser_run: ciiFinal != null || stored?.aiReportScore != null,
    cii_provisional: ciiFinal,
    cii_locked: locked,
    cii_level_name: badge?.name ?? null,
    cii_numeric_level: badge?.level ?? null,
  };
}

function lockedAdminEvidenceCriteria(locked: CiiV45Result | null): {
  assessorId: string;
  assessedAt: string;
  criteria: Array<{
    criterion: string;
    anchor: Exclude<CiiV45Anchor, 'P'>;
    reasoningSummary: string;
    evidenceIds?: string[];
  }>;
} | null {
  if (!locked) return null;
  const assessed = locked.adminEvidenceAssessment;
  if (
    assessed?.status === 'ASSESSED' &&
    Array.isArray(assessed.criteria) &&
    assessed.criteria.length === CII_V45_EVIDENCE_DIMENSION.criteria.length &&
    assessed.criteria.every((c) => c && c.anchor !== 'P' && typeof c.reasoningSummary === 'string')
  ) {
    return {
      assessorId: assessed.assessorId || 'locked-admin',
      assessedAt: assessed.assessedAt || new Date().toISOString(),
      criteria: assessed.criteria.map((c) => ({
        criterion: c.criterion,
        anchor: c.anchor,
        reasoningSummary: c.reasoningSummary,
        evidenceIds: c.evidenceIds,
      })),
    };
  }
  const dim7 = locked.sectionScores?.find((s) => s.dimension === '7');
  const rows = dim7?.criterionScores ?? [];
  if (
    rows.length !== CII_V45_EVIDENCE_DIMENSION.criteria.length ||
    rows.some((c) => !c || c.anchor === 'P')
  ) {
    return null;
  }
  return {
    assessorId: 'locked-admin',
    assessedAt: new Date().toISOString(),
    criteria: rows.map((c) => ({
      criterion: c.criterion,
      anchor: c.anchor as Exclude<CiiV45Anchor, 'P'>,
      reasoningSummary: c.reasoningSummary?.trim() || 'Locked Admin evidence assessment.',
      evidenceIds: c.evidenceIds,
    })),
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

/** Assigned seats faculty can monitor (not pending join, not rejected). */
const TRACKING_SEAT_STATUSES = [
  'accepted',
  'approved',
  'verified',
  'paid',
  'pending_ciel_approval',
  'pending_faculty_approval',
  'pending_payment_approval',
  'finalized',
] as const;

function isPrivateStudentPathway(opp: Opportunity | null | undefined): boolean {
  const ctx = opp?.executing_context;
  if (!ctx || typeof ctx !== 'object') return false;
  return (
    String((ctx as { student_pathway?: unknown }).student_pathway || '')
      .trim()
      .toLowerCase() === 'private'
  );
}

function isRejectedOpportunity(opp: Opportunity): boolean {
  const status = String(opp.status || '')
    .trim()
    .toLowerCase();
  const stage = String(opp.workflowStage || '')
    .trim()
    .toLowerCase();
  return status === 'rejected' || stage === 'rejected';
}

function latestActivityIso(
  values: Array<Date | string | null | undefined>,
): string | undefined {
  let max = 0;
  for (const value of values) {
    if (!value) continue;
    const ms =
      value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max > 0 ? new Date(max).toISOString() : undefined;
}

export function mapFacultyListPackage(
  report: StudentReport,
  /** null/undefined = no live attendance-log data for this project (fall back to the stored
   * blob); a number (including 0, e.g. every logged session was rejected) is the real live
   * total and must win outright — it must never be conflated with "no live data yet". */
  liveHours: number | null = null,
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
  // Live non-rejected project logs are the source of truth when present (team, not lead-only
  // blob) — including a genuine live total of 0 (e.g. every session was rejected), which must
  // not fall back to a stale stored value. Only the absence of live data (null) falls back.
  const flashHours =
    liveHours != null ? liveHours : resolveReportFlashHours(report.section1);
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
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    @InjectRepository(Participation)
    private readonly participationRepository: Repository<Participation>,
    @InjectRepository(Opportunity)
    private readonly opportunitiesRepository: Repository<Opportunity>,
    private readonly s3Service: S3Service,
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
      // Faculty is the first *report* approver after submit for university-supervised
      // work. Private-candidate rows are excluded below; they stay on the fee gateway
      // until CIEL PK. Leftover university payment_pending rows are reviewable here
      // while the university fee is paused (Dr Moeed).
      .andWhere("report.status NOT IN ('draft', 'continue')")
      .andWhere(
        `COALESCE(opportunity.faculty_verification_status, '') <> 'not_required'`,
      )
      .andWhere(
        `COALESCE(opportunity.executing_context->>'student_pathway', '') <> 'private'`,
      )
      .orderBy('report.submission_date', 'DESC')
      .getMany();

    return reports;
  }

  /**
   * Reports still being written by students in this faculty's scope: progress only (no answers,
   * no scores). Opening a report stays blocked until submit (see findOne's 'not yet submitted').
   */
  async listDraftProgress(facultyId: string, facultyEmail: string) {
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
      .andWhere("report.status IN ('draft', 'continue')")
      .andWhere('report.reportSubmittedAt IS NULL')
      .andWhere(
        `COALESCE(opportunity.executing_context->>'student_pathway', '') <> 'private'`,
      )
      .orderBy('report.updatedAt', 'DESC')
      .getMany();
    return {
      success: true,
      data: reports.map((r) => ({
        id: r.id,
        student_name: r.student?.name || 'Unknown',
        project_title: r.opportunity?.title || r.project_id,
        project_id: r.opportunityId || r.project_id || null,
        organization_name: trackingOrganizationName(r.opportunity),
        status: r.status,
        hours: resolveReportFlashHours(r.section1),
        updated_at: r.updatedAt,
        draft_locked: true,
        ...computeReportProgress(r),
      })),
    };
  }

  /**
   * Assigned students on this faculty's opportunities: live hours + report progress.
   * Source of truth for Community Service Projects monitoring — not submitted-reports-only.
   * Never returns student phone numbers.
   */
  async listProjectTracking(facultyId: string, facultyEmail: string) {
    const scopedOpportunityIds =
      await this.facultyService.getScopedOpportunityIds(
        facultyId,
        facultyEmail,
      );
    if (scopedOpportunityIds.length === 0) {
      return { success: true, data: [] as Record<string, unknown>[] };
    }

    const [opportunities, participants, reports, logs] = await Promise.all([
      this.opportunitiesRepository.find({
        where: { id: In(scopedOpportunityIds) },
        relations: ['organization'],
      }),
      this.participationRepository.find({
        where: {
          projectId: In(scopedOpportunityIds),
          status: In([...TRACKING_SEAT_STATUSES]),
        },
        relations: ['student'],
      }),
      this.baseReportQuery()
        .where('report."opportunityId"::text IN (:...scopedOppIds)', {
          scopedOppIds: scopedOpportunityIds,
        })
        .orWhere(`TRIM(COALESCE(report.project_id, '')) IN (:...scopedOppIds)`, {
          scopedOppIds: scopedOpportunityIds,
        })
        .orderBy('report.updatedAt', 'DESC')
        .getMany(),
      this.attendanceLogsRepository.find({
        where: { projectId: In(scopedOpportunityIds) },
      }),
    ]);

    const oppById = new Map(
      opportunities
        .filter((opp) => !isRejectedOpportunity(opp) && !isPrivateStudentPathway(opp))
        .map((opp) => [opp.id, opp]),
    );
    const allowedIds = new Set(oppById.keys());

    const logsByParticipant = new Map<string, AttendanceLog[]>();
    const logsByProject = new Map<string, AttendanceLog[]>();
    for (const log of logs) {
      if (!allowedIds.has(log.projectId)) continue;
      const byP = logsByParticipant.get(log.participantId) ?? [];
      byP.push(log);
      logsByParticipant.set(log.participantId, byP);
      const byProj = logsByProject.get(log.projectId) ?? [];
      byProj.push(log);
      logsByProject.set(log.projectId, byProj);
    }

    const reportsForProject = (projectId: string) =>
      reports.filter((r) => {
        const key = String(r.opportunityId || r.project_id || '').trim();
        return key === projectId && allowedIds.has(projectId);
      });

    const matchReport = (
      projectId: string,
      studentId: string,
      email: string,
    ): StudentReport | undefined => {
      const pool = reportsForProject(projectId);
      const sid = studentId.trim();
      const em = email.trim().toLowerCase();
      return (
        pool.find((r) => sid && String(r.studentId || r.student?.id || '') === sid) ||
        pool.find(
          (r) =>
            em &&
            String(r.student?.email || '')
              .trim()
              .toLowerCase() === em,
        )
      );
    };

    const usedReportIds = new Set<string>();
    const data: Record<string, unknown>[] = [];

    for (const seat of participants) {
      const opp = oppById.get(seat.projectId);
      if (!opp) continue;
      const email = pickListString(seat.student?.email, seat.email);
      const report = matchReport(
        seat.projectId,
        String(seat.studentId || seat.student?.id || ''),
        email,
      );
      if (report?.id) usedReportIds.add(report.id);
      const seatLogs = logsByParticipant.get(seat.id) ?? [];
      const liveHours = this.loggedHoursForProject(seatLogs);
      const required =
        Number(
          (opp.timeline as { expected_hours?: unknown } | undefined)
            ?.expected_hours,
        ) ||
        Number(opp.requiredHours) ||
        16;
      const progress = report ? computeReportProgress(report) : null;
      const submitted = progress?.is_submitted === true;
      const hoursPct =
        required > 0
          ? Math.min(100, Math.round((liveHours / required) * 100))
          : 0;
      const lastActivity = latestActivityIso([
        ...seatLogs.map((l) => l.updatedAt),
        ...seatLogs.map((l) => l.createdAt),
        ...seatLogs.map((l) => l.dateOfEngagement),
        report?.updatedAt,
        report?.reportSubmittedAt,
        seat.updatedAt,
        seat.createdAt,
      ]);
      data.push({
        id: report?.id || `track:${seat.id}`,
        participation_id: seat.id,
        report_id: report?.id || null,
        student_name:
          pickListString(seat.student?.name, seat.fullName) || 'Student',
        student_email: email && email.includes('@') ? email : null,
        project_title: opp.title || 'Project',
        project_id: seat.projectId,
        organization_name: trackingOrganizationName(opp),
        hours: Math.round(liveHours * 10) / 10,
        required_hours: required,
        hours_progress_pct: hoursPct,
        progress_pct: submitted
          ? 100
          : progress
            ? progress.progress_pct
            : hoursPct,
        sections_complete: progress?.sections_complete,
        sections_total: progress?.sections_total ?? 10,
        status: report?.status || 'assigned',
        faculty_status: report?.faculty_status || null,
        submission_date: report?.submission_date || null,
        report_submitted_at: report?.reportSubmittedAt || null,
        updated_at: lastActivity || report?.updatedAt || seat.updatedAt,
        last_activity_at: lastActivity || null,
        draft_locked: !submitted,
        member_hours: [
          {
            name: pickListString(seat.student?.name, seat.fullName) || 'Student',
            hours: Math.round(liveHours * 10) / 10,
            required,
          },
        ],
      });
    }

    for (const report of reports) {
      if (usedReportIds.has(report.id)) continue;
      const projectId = String(report.opportunityId || report.project_id || '').trim();
      const opp = oppById.get(projectId);
      if (!opp) continue;
      const projectLogs = logsByProject.get(projectId) ?? [];
      const liveHours = projectLogs.length
        ? this.loggedHoursForProject(projectLogs)
        : resolveReportFlashHours(report.section1);
      const required =
        Number(
          (opp.timeline as { expected_hours?: unknown } | undefined)
            ?.expected_hours,
        ) || 16;
      const progress = computeReportProgress(report);
      const email = pickListString(report.student?.email);
      data.push({
        id: report.id,
        participation_id: null,
        report_id: report.id,
        student_name: report.student?.name || 'Unknown',
        student_email: email && email.includes('@') ? email : null,
        project_title: opp.title || report.project_id,
        project_id: projectId || null,
        organization_name: trackingOrganizationName(opp),
        hours: Math.round(liveHours * 10) / 10,
        required_hours: required,
        hours_progress_pct:
          required > 0 ? Math.min(100, Math.round((liveHours / required) * 100)) : 0,
        ...progress,
        status: report.status,
        faculty_status: report.faculty_status,
        submission_date: report.submission_date,
        report_submitted_at: report.reportSubmittedAt,
        updated_at: report.updatedAt,
        last_activity_at: latestActivityIso([report.updatedAt, report.reportSubmittedAt]) || null,
        draft_locked: !progress.is_submitted,
        member_hours: [
          {
            name: report.student?.name || 'Student',
            hours: Math.round(liveHours * 10) / 10,
            required,
          },
        ],
      });
    }

    data.sort((a, b) => {
      const ta = Date.parse(String(a.last_activity_at || a.updated_at || '')) || 0;
      const tb = Date.parse(String(b.last_activity_at || b.updated_at || '')) || 0;
      return tb - ta;
    });

    return { success: true, data };
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
    // null = no attendance logs exist yet for this project (fall back to the stored blob); a
    // number (including 0, e.g. every logged session was rejected) is the real live total.
    const hoursByProject = new Map<string, number | null>();
    for (const projectId of projectIds) {
      const projectLogs = logs.filter((log) => log.projectId === projectId);
      hoursByProject.set(
        projectId,
        projectLogs.length ? this.loggedHoursForProject(projectLogs) : null,
      );
    }

    return {
      success: true,
      data: reports.map((r) => {
        const liveHours =
          hoursByProject.get((r.opportunityId || r.project_id || '').trim()) ??
          null;
        return {
          id: r.id,
          student_name: r.student?.name || 'Unknown',
          student_email: r.student?.email || null,
          project_title: r.opportunity?.title || r.project_id,
          organization_name: r.opportunity?.organization?.name || 'N/A',
          status: r.status,
          faculty_status: r.faculty_status,
          private_candidate: isPrivateCandidateOpportunity(r.opportunity),
          review_route: reviewRouteForOpportunity(r.opportunity),
          project_id: r.opportunityId || r.project_id || null,
          hours:
            liveHours != null
              ? liveHours
              : resolveReportFlashHours(r.section1),
          submission_date: r.submission_date,
          report_submitted_at: r.reportSubmittedAt,
          partner_approved_at: r.partnerApprovedAt,
          admin_approved_at: r.adminApprovedAt,
          updated_at: r.updatedAt,
          metrics: r.section1?.metrics,
          ...mapFacultyListCii(r),
          ...mapFacultyListPackage(r, liveHours),
        };
      }),
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
      .andWhere("report.status NOT IN ('draft', 'continue')")
      .getOne();

    if (!report) {
      throw new NotFoundException(
        'Report not found, not assigned to you, or not yet submitted',
      );
    }

    return StudentReportsService.withholdAnalysisForFacultyUntilApproved(
      await this.studentReportsService.buildDetailResponse(report, undefined, {
        allProjectAttendance: true,
        evidenceViewer: 'faculty',
      }),
    );
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
      .andWhere("report.status NOT IN ('draft', 'continue')")
      .getOne();

    if (!report) {
      throw new NotFoundException(
        'Report not found, not assigned to you, or not yet submitted',
      );
    }

    return report;
  }

  private assertFeeClearedForCii(report: StudentReport) {
    if (!isPrivateCandidateOpportunity(report.opportunity)) return;
    const reportStatus = String(report.status || '').toLowerCase();
    if (
      reportStatus === 'draft' ||
      reportStatus === 'payment_pending' ||
      reportStatus === 'pending_payment' ||
      reportStatus === 'payment_under_review'
    ) {
      throw new BadRequestException(
        'Reporting fee must be approved before CII analysis can run.',
      );
    }
  }

  /**
   * CIEL PK Admin CII analyse/approve — platform-wide.
   * Faculty login is read-only; Admin owns Analyzer + CII lock for every CS report
   * (private-candidate and regular faculty-linked routes).
   */
  private async findReportForAdminCii(id: string): Promise<StudentReport> {
    const report = await this.studentReportsRepository.findOne({
      where: { id },
      relations: ['opportunity', 'student'],
    });
    if (!report) {
      throw new NotFoundException('Report not found.');
    }
    this.assertFeeClearedForCii(report);
    return report;
  }

  /** Reports whose CII v4.5 AI analysis is running right now (double click / two admins). */
  private static readonly ciiV45RunsInFlight = new Set<string>();

  /**
   * Runs the CII v4.5 AI evaluation and persists a server-recomputed score snapshot. Admin-only
   * (there is no faculty entrypoint, matching the live product: faculty report review is
   * read-only everywhere else). This method only ever writes `ciiV45`/`ciiV45Lock`.
   */
  async runCiiV45AnalysisForAdmin(id: string) {
    const report = await this.findReportForAdminCii(id);
    return this.persistCiiV45Analysis(report, { adminRescore: true });
  }

  /** Runs the CII v5.0 Hybrid AI call (report-quality /85 only) and validates
   * the structural shape `computeCiiV45Result` requires. Evidence originals are
   * never sent to the model — Admin scores Dimension 7 separately. */
  private async evaluateCiiV45(
    payload: CielPkAiEvaluationPayloadV45,
    reportId: string,
  ): Promise<{
    result: CiiV45Result;
    ciiV45: CiiV45EvaluatorPayload;
    evidenceInspection?: EvidenceInspection;
    model?: string;
  }> {
    const { ciiV45, evidenceInspection, model } = await this.aiService.summarize(
      'cii_v4_5_evaluation',
      payload,
      { skipEvidenceImages: true },
    );
    if (!ciiV45) {
      throw new BadRequestException(
        'The AI did not return a readable CII v5.0 evaluation. Please retry.',
      );
    }
    try {
      const normalized = normalizeCiiV5AiPayload(ciiV45 as CiiV45EvaluatorPayload);
      const result = computeCiiV45Result(normalized);
      return { result, ciiV45: normalized, evidenceInspection, model };
    } catch (error) {
      if (!(error instanceof CiiV45ValidationError)) throw error;
      console.error(
        `CII v5.0 validation failed for report ${reportId}: ${error.message}`,
        JSON.stringify((ciiV45 as CiiV45EvaluatorPayload).sectionScores),
      );
      throw new BadRequestException(
        `The AI returned an invalid CII v5.0 evaluation (${error.message}). Please retry.`,
      );
    }
  }

  private async persistCiiV45Analysis(
    report: StudentReport,
    opts: { adminRescore?: boolean } = {},
  ) {
    if (!opts.adminRescore && report.ciiV45Lock?.locked) {
      throw new BadRequestException(
        "This report's CII v4.5 score is already locked and cannot be re-analysed.",
      );
    }
    if (FacultyReportsService.ciiV45RunsInFlight.has(report.id)) {
      throw new ConflictException(
        'An analysis is already running for this report. Wait for it to finish, then refresh.',
      );
    }
    FacultyReportsService.ciiV45RunsInFlight.add(report.id);
    try {
      return await this.runAndStoreCiiV45Analysis(report, opts);
    } finally {
      FacultyReportsService.ciiV45RunsInFlight.delete(report.id);
    }
  }

  private async runAndStoreCiiV45Analysis(
    report: StudentReport,
    opts: { adminRescore?: boolean } = {},
  ) {
    const payload = await buildCielPkAiEvaluationPayloadV45(report, this.s3Service);

    const { result, evidenceInspection, model } = await this.evaluateCiiV45(payload, report.id);

    const nextCiiV45 = {
      ...result,
      evidenceInspection,
      computedAt: new Date().toISOString(),
      runHistory: [
        ...(((report.ciiV45 as Record<string, unknown> | null)?.runHistory as unknown[]) ?? []).slice(-19),
        {
          score: result.diagnosticCII ?? result.aiReportScore ?? pickCiiV45DisplayScore(result, null),
          status: result.scoreStatus,
          at: new Date().toISOString(),
          model: model ?? null,
          inspectedImages: evidenceInspection?.inspected.length ?? 0,
          notInspectedFiles: evidenceInspection?.notInspected.length ?? 0,
        },
      ],
    };

    // Same guarded CAS pattern as the v2 path: faculty writes would be blocked while locked;
    // admin rescore clears the lock in the same write.
    const qb = this.studentReportsRepository
      .createQueryBuilder()
      .update(StudentReport)
      .set(
        (opts.adminRescore
          ? { ciiV45: nextCiiV45, ciiV45Lock: () => 'NULL' }
          : { ciiV45: nextCiiV45 }) as unknown as import('typeorm').QueryDeepPartialEntity<StudentReport>,
      )
      .where('id = :id', { id: report.id });
    if (!opts.adminRescore) {
      qb.andWhere(
        `("ciiV45Lock" IS NULL OR ("ciiV45Lock"->>'locked') IS DISTINCT FROM 'true')`,
      );
    }
    const updateResult = await qb.execute();

    if (!updateResult.affected) {
      throw new BadRequestException(
        "This report's CII v4.5 score is already locked and cannot be re-analysed.",
      );
    }

    return { success: true, data: nextCiiV45 };
  }

  /**
   * Approves and hash-locks the CII v5.0 Hybrid score. Admin-only, same as the run step.
   * `RESUBMISSION_REQUIRED` / `ADMIN_REVIEW_REQUIRED` are warnings for the analyser UI — Admin
   * may still publish the displayed score. A v5.0 run with Dimension 7 still pending must
   * include the Admin evidence assessment in this same request. The report's live data must
   * still hash to the same `inputFingerprint` the analysis ran against.
   */
  async approveCiiV45ForAdmin(
    id: string,
    adminId: string,
    note?: string,
    adminAdjustedScore?: number,
    scoreModerationReason?: string,
    evidenceCriteria?: Array<{
      criterion: string;
      anchor: 0 | 1 | 2 | 3 | 4;
      reasoningSummary: string;
      evidenceIds?: string[];
    }>,
    exceptionalFeatureAdminVerified?: boolean,
  ) {
    const report = await this.findReportForAdminCii(id);
    return this.persistCiiV45Approval(
      report,
      adminId,
      note,
      adminAdjustedScore,
      scoreModerationReason,
      evidenceCriteria,
      exceptionalFeatureAdminVerified,
    );
  }

  private async persistCiiV45Approval(
    report: StudentReport,
    adminId: string,
    note?: string,
    adminAdjustedScore?: number,
    scoreModerationReason?: string,
    evidenceCriteria?: Array<{
      criterion: string;
      anchor: 0 | 1 | 2 | 3 | 4;
      reasoningSummary: string;
      evidenceIds?: string[];
    }>,
    exceptionalFeatureAdminVerified?: boolean,
  ) {
    const storedRaw = report.ciiV45 as unknown as CiiV45Result | null | undefined;

    if (!storedRaw) {
      throw new BadRequestException('Run the CII v4.5 analysis before approving.');
    }
    if (report.ciiV45Lock?.locked) {
      throw new BadRequestException("This report's CII v4.5 score is already locked.");
    }

    let stored = storedRaw;
    const evidenceStatus = stored.adminEvidenceAssessment?.status;
    const isV5Pending =
      stored.frameworkVersion === '5.0' || evidenceStatus === 'PENDING';
    if (isV5Pending && evidenceStatus !== 'ASSESSED') {
      if (!evidenceCriteria?.length) {
        throw new BadRequestException(
          'Score Dimension 7 (evidence) before confirming the CII.',
        );
      }
      const exceptional = stored.exceptionalFeature
        ? {
            ...stored.exceptionalFeature,
            adminVerified: exceptionalFeatureAdminVerified === true,
          }
        : stored.exceptionalFeature;
      try {
        stored = computeCiiV45Result(
          applyAdminEvidenceAssessment(stored, {
            assessorId: adminId,
            assessedAt: new Date().toISOString(),
            criteria: evidenceCriteria,
            exceptionalFeature: exceptional,
          }),
        );
      } catch (error) {
        if (error instanceof CiiV45ValidationError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    }

    const aiRecommendedScore = pickCiiV45DisplayScore(stored, report.ciiV45Lock);
    if (aiRecommendedScore == null) {
      throw new BadRequestException('Run the CII v4.5 analysis before approving.');
    }

    // Recompute the fingerprint fresh from the report's CURRENT live data — the same protective
    // role the v2 path's fresh-integrity-holds recheck plays, but via content hash: if a section
    // was edited or an evidence file changed since the analysis ran, the fingerprint will not
    // match the stored one and the stale evaluation must not be published.
    const liveFingerprint = computeCiiV45InputFingerprint(
      report,
      (await buildCielPkAiEvaluationPayloadV45(report, this.s3Service)).uploaded_evidence_files,
    );
    if (liveFingerprint !== stored.inputFingerprint) {
      throw new BadRequestException(
        'This report has changed since the analysis ran. Re-run the analysis before approving.',
      );
    }

    const hasModeration =
      adminAdjustedScore !== undefined &&
      Math.round(adminAdjustedScore * 10) / 10 !== Math.round(aiRecommendedScore * 10) / 10;
    if (hasModeration && !scoreModerationReason?.trim()) {
      throw new BadRequestException('A reason is required when moderating the AI-recommended score.');
    }
    const adminApprovedScore = hasModeration
      ? Math.round(Math.min(100, Math.max(0, adminAdjustedScore!)) * 10) / 10
      : aiRecommendedScore;

    // Moderation changes only the published number — it can never invent a badge the quality
    // gates don't support. Re-derive the badge from the SAME gate results the calculator already
    // computed (never hand-roll a second gate-walk), just against the (possibly moderated) score.
    const finalBadge = resolveBadgeForScore(adminApprovedScore, stored.qualityGates);

    const approvedAt = new Date().toISOString();
    const decisionRecord = {
      reportId: report.id,
      inputFingerprint: stored.inputFingerprint,
      aiRecommendedScore,
      adminApprovedScore,
      scoreWasModerated: hasModeration,
      scoreModerationReason: hasModeration ? scoreModerationReason : null,
      badge: finalBadge?.name ?? null,
      adminId,
      approvedAt,
      note: note || '',
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(decisionRecord)).digest('hex');

    const nextCiiV45 = {
      ...(stored as unknown as Record<string, unknown>),
      finalCII: adminApprovedScore,
      finalBadge,
    };
    const nextCiiV45Lock: StudentReport['ciiV45Lock'] = {
      locked: true,
      hash,
      lockedAt: approvedAt,
      lockedByAdminId: adminId,
      adminNote: note,
      inputFingerprint: stored.inputFingerprint,
      scoreStatusAtLock: 'FINAL',
      aiRecommendedScore,
      adminApprovedScore,
      scoreWasModerated: hasModeration,
      scoreModerationReason: hasModeration ? scoreModerationReason : undefined,
      finalBadge,
    };

    const updateResult = await this.studentReportsRepository
      .createQueryBuilder()
      .update(StudentReport)
      .set({
        ciiV45: nextCiiV45,
        ciiV45Lock: nextCiiV45Lock,
        admin_status: 'approved',
      } as unknown as import('typeorm').QueryDeepPartialEntity<StudentReport>)
      .where('id = :id', { id: report.id })
      .andWhere(`("ciiV45Lock" IS NULL OR ("ciiV45Lock"->>'locked') IS DISTINCT FROM 'true')`)
      .execute();

    if (!updateResult.affected) {
      throw new BadRequestException("This report's CII v4.5 score is already locked.");
    }

    await this.approveAttendanceLogsOnFlashCardLock(report, adminId);

    return {
      success: true,
      data: { ciiV45: nextCiiV45, ciiV45Lock: nextCiiV45Lock },
    };
  }

  /** Confirm pending attendance when Faculty / CIEL PK locks the flash-card score. */
  private async approveAttendanceLogsOnFlashCardLock(
    report: StudentReport,
    actorId: string,
  ): Promise<void> {
    const projectId = String(
      report.opportunityId || report.project_id || '',
    ).trim();
    if (!projectId) return;

    const studentId = String(report.studentId || report.student?.id || '').trim();
    let logs: AttendanceLog[] = [];
    try {
      logs = await this.attendanceLogsRepository.find({
        where: { projectId },
        relations: ['participant'],
      });
    } catch {
      return;
    }

    const seed = logs.find((log) => log.participant?.studentId === studentId)
      ?.participant;
    const now = new Date();
    const toApprove = logs.filter((log) => {
      const status = String(log.approvalStatus || '')
        .trim()
        .toLowerCase();
      if (status === 'approved' || status === 'rejected') return false;
      if (studentId && log.participant?.studentId === studentId) return true;
      if (
        seed?.isTeamLead &&
        seed.applicationId &&
        log.participant?.applicationId === seed.applicationId
      ) {
        return true;
      }
      if (
        seed?.isTeamLead &&
        seed.teamId &&
        log.participant?.teamId === seed.teamId
      ) {
        return true;
      }
      return !studentId && (status === 'pending' || status === '');
    });
    if (!toApprove.length) return;

    for (const log of toApprove) {
      log.approvalStatus = 'approved';
      log.entryStatus = 'verified';
      log.approvalActorUserId = actorId;
      log.approvalActionAt = now;
      log.approvalActionReason =
        'Approved with faculty flash-card score lock';
    }
    try {
      await this.attendanceLogsRepository.save(toApprove);
    } catch {
      // Flash-card lock already persisted — do not fail CII confirm if hours write lags.
    }
  }

  /** Scoping for runIndependentAiAnalysis, split out by caller role — previously this method
   * took no scope at all (any faculty could run it against any report id, university/ciel_admin
   * had no route yet). Faculty reuses the same assignment-based scope as the admin CII run;
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
   * Independent re-runs score report quality only. Re-apply the locked Admin Dim 7
   * so the stored wall score is the combined /100 CII, not the /85 AI mix.
   */
  private combineIndependentAnalysisWithLockedEvidence(
    independentPayload: CiiV45EvaluatorPayload,
    locked: CiiV45Result | null,
  ): CiiV45Result {
    const criteria = lockedAdminEvidenceCriteria(locked);
    if (!criteria) return computeCiiV45Result(independentPayload);
    try {
      return computeCiiV45Result(
        applyAdminEvidenceAssessment(independentPayload, {
          assessorId: criteria.assessorId,
          assessedAt: criteria.assessedAt,
          criteria: criteria.criteria,
          extraMile: locked?.extraMileUplift,
          exceptionalFeature: locked?.exceptionalFeature,
        }),
      );
    } catch {
      return computeCiiV45Result(independentPayload);
    }
  }

  /**
   * Run Independent AI Analysis from My Impact Wall.
   *
   * This is for authorized stakeholders (Faculty, University, CIEL PK) to run
   * additional AI analysis on an already-approved record WITHOUT overwriting
   * the admin-approved score.
   *
   * - Uses the same CII v4.5 rubric/calculator as the admin run
   * - Results stored in `independentAiAnalyses` array
   * - Creates an audit trail with who ran it and when
   * - The admin-approved record remains unchanged
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
    if (!report.ciiV45Lock?.locked) {
      throw new BadRequestException(
        'Independent AI analysis can only be run on admin-approved records.',
      );
    }

    // Build the AI evaluation payload (same as the admin run)
    const aiPayload = await buildCielPkAiEvaluationPayloadV45(report, this.s3Service);

    // Same evaluate-with-one-fallback-attempt flow as the admin run.
    // Reuse locked Admin Dim 7 so the stored score is comparable /100, not the /85 mix.
    const { ciiV45 } = await this.evaluateCiiV45(aiPayload, report.id);
    const ciiResult = this.combineIndependentAnalysisWithLockedEvidence(
      ciiV45,
      report.ciiV45 as unknown as CiiV45Result | null,
    );

    // Build the independent analysis record
    const analysisId = crypto.randomUUID();
    const runAt = new Date().toISOString();

    const independentAnalysis = {
      id: analysisId,
      runAt,
      runByUserId: userId,
      runByRole: userRole,
      runByName: userName,
      score: pickCiiV45DisplayScore(ciiResult, null) ?? ciiResult.aiReportScore,
      badge: ciiResult.recommendedBadge ?? ciiResult.diagnosticBadge,
      sections: ciiResult.sectionScores.map((s) => ({
        dimension: s.dimension,
        name: s.name,
        maximumPoints: s.maximumPoints,
        score: s.score,
      })),
      extraMileUplift: { total: ciiResult.extraMileUplift.total },
      integrityPenalty: ciiResult.integrityPenalty.points,
      feedback: ciiV45.studentFeedback || undefined,
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
        // Also return the original admin-approved score for comparison
        adminApprovedScore:
          report.ciiV45Lock?.adminApprovedScore ??
          pickCiiV45DisplayScore(report.ciiV45, report.ciiV45Lock) ??
          null,
        aiRecommendedScore:
          report.ciiV45Lock?.aiRecommendedScore ??
          pickCiiV45DisplayScore(report.ciiV45, report.ciiV45Lock) ??
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
          score: result.data.analysis.score ?? undefined,
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

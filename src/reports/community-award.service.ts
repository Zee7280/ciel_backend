import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, SelectQueryBuilder } from 'typeorm';
import { StudentReport } from './entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { NotifyCommunityAwardDto } from './dto/notify-community-award.dto';
import {
  awardBadgeLabel,
  awardTopN,
  scoreCommunityAward,
  communityAwardInputsFromReport,
  resolveDisplayCii,
  resolveReportFlashOutcomes,
  isCommunityAwardMedalReport,
  communityServiceLevel,
  type CommunityAwardKind,
  type CommunityServiceLevel,
} from './community-award.util';
import {
  redactCiiV2Fields,
  type RedactedCiiV2,
  type RedactedCiiV2Lock,
} from './cii-v2-redaction.util';
import { buildImpactVerifyUrl } from './certificate-verification-code.util';

export type CommunityAwardCard = {
  id: string;
  studentId: string;
  student_name: string;
  project_title: string;
  organization_name: string;
  university: string;
  department: string;
  faculty_name: string;
  hours: number;
  sdg: string;
  evidenceCount: number;
  story: string;
  change: string;
  semester: string;
  year: string;
  month: string;
  teamSize: number;
  faculty_status: string;
  status: string;
  cii: number | null;
  pts: number[];
  total: number;
  level: CommunityServiceLevel;
  awardBadges: NonNullable<StudentReport['awardBadges']>;
  awardBadgeHistory: NonNullable<StudentReport['awardBadgeHistory']>;
  impact_verify_url: string | null;
};

@Injectable()
export class CommunityAwardService {
  private readonly logger = new Logger(CommunityAwardService.name);

  constructor(
    @InjectRepository(StudentReport)
    private readonly reports: Repository<StudentReport>,
    @InjectRepository(Organization)
    private readonly orgs: Repository<Organization>,
    private readonly notifications: NotificationsService,
  ) {}

  toCard(report: StudentReport): CommunityAwardCard {
    const s1 = report.section1 as StudentReport['section1'] | null;
    const s2 = report.section2 as StudentReport['section2'] | null;
    const s3 = report.section3 as StudentReport['section3'] | null;
    const s5 = report.section5 as StudentReport['section5'] | null;
    const lead = s1?.team_lead;
    const scoredInput = communityAwardInputsFromReport(report);
    const hours = scoredInput.hours;
    const evidenceCount = scoredInput.evidenceCount;
    const scored = scoreCommunityAward(scoredInput);
    const { baseline, endline, change } = resolveReportFlashOutcomes(s5);
    const arrow = baseline && endline ? `${baseline} → ${endline}` : '';
    const changeLine =
      change && arrow && change.includes(arrow)
        ? change
        : [arrow, change].filter(Boolean).join(' · ');
    const submitted =
      report.reportSubmittedAt || report.submission_date || report.createdAt;
    const dt = submitted ? new Date(submitted) : null;
    const sdgNum = s3?.primary_sdg?.goal_number ?? report.primary_sdg_goal;
    const members = Array.isArray(s1?.team_members)
      ? s1.team_members.length
      : 0;
    return {
      id: report.id,
      studentId: report.studentId,
      student_name: report.student?.name || lead?.name || 'Student',
      project_title:
        report.opportunity?.title || report.project_id || 'Community service',
      organization_name: report.opportunity?.organization?.name || 'Partner',
      university:
        lead?.university ||
        report.student?.university ||
        report.student?.institution ||
        '—',
      department: lead?.degree || report.student?.department || '—',
      faculty_name:
        String(
          (s1 as { faculty_supervisor_name?: string } | null)
            ?.faculty_supervisor_name || '',
        ).trim() || 'Faculty',
      hours,
      sdg: sdgNum ? `SDG ${sdgNum}` : '—',
      evidenceCount,
      story: (
        s2?.summary_text ||
        s2?.problem_statement ||
        report.summary_text_generated ||
        ''
      ).trim(),
      change: changeLine,
      semester: String(lead?.year || '').trim() || '—',
      year: dt ? String(dt.getFullYear()) : '',
      month: dt
        ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
        : '',
      teamSize: 1 + members,
      faculty_status: report.faculty_status,
      status: report.status,
      cii: resolveDisplayCii(report),
      pts: scored.pts,
      total: scored.total,
      level: communityServiceLevel(scored.total),
      awardBadges: report.awardBadges ?? [],
      awardBadgeHistory: report.awardBadgeHistory ?? [],
      impact_verify_url: buildImpactVerifyUrl(report.verificationPublicSlug),
    };
  }

  private facultyApproved(report: StudentReport) {
    return isCommunityAwardMedalReport({
      status: report.status,
      faculty_status: report.faculty_status,
      admin_status: report.admin_status,
    });
  }

  cardsFrom(
    reports: StudentReport[],
    approvedOnly = true,
  ): CommunityAwardCard[] {
    return reports
      .filter((r) => (approvedOnly ? this.facultyApproved(r) : true))
      .map((r) => this.toCard(r));
  }

  private applyLiveDeckWhere(qb: SelectQueryBuilder<StudentReport>) {
    qb.andWhere(
      `LOWER(TRIM(COALESCE(report.status, ''))) NOT IN (:...blockedStatus)`,
      {
        blockedStatus: ['draft', 'rejected', 'declined'],
      },
    )
      .andWhere(
        `LOWER(TRIM(COALESCE(report.faculty_status, ''))) IN (:...liveFaculty)`,
        {
          liveFaculty: ['approved', 'verified'],
        },
      )
      .andWhere(
        new Brackets((q) => {
          q.where(
            `LOWER(TRIM(COALESCE(report.admin_status, ''))) IN (:...liveAdmin)`,
            {
              liveAdmin: ['approved', 'verified'],
            },
          ).orWhere(
            `LOWER(TRIM(COALESCE(report.status, ''))) IN (:...liveStatus)`,
            {
              liveStatus: ['approved', 'verified'],
            },
          );
        }),
      );
  }

  async listForPartnerOrg(
    organizationId: string,
  ): Promise<CommunityAwardCard[]> {
    if (!organizationId) return [];
    const qb = this.reports
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.student', 'student')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('opportunity.organization', 'organization')
      .where('opportunity.organizationId = :oid', { oid: organizationId });
    this.applyLiveDeckWhere(qb);
    const rows = await qb.orderBy('report.submission_date', 'DESC').getMany();
    return rows
      .filter((r) => this.facultyApproved(r))
      .map((r) => this.toCard(r));
  }

  async listForUniversity(
    organizationId: string,
  ): Promise<CommunityAwardCard[]> {
    if (!organizationId) return [];
    const org = await this.orgs.findOne({ where: { id: organizationId } });
    const name = (org?.name || '').trim().toLowerCase();
    const qb = this.reports
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.student', 'student')
      .leftJoin('student.organization', 'studentOrg')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('opportunity.organization', 'organization')
      .where(
        new Brackets((q) => {
          q.where('studentOrg.id = :oid', { oid: organizationId }).orWhere(
            'opportunity.organizationId = :oid',
            { oid: organizationId },
          );
          if (name) {
            q.orWhere(
              "LOWER(TRIM(COALESCE(student.university, student.institution, ''))) = :n",
              {
                n: name,
              },
            ).orWhere(
              `LOWER(TRIM(COALESCE(report.section1->'team_lead'->>'university', ''))) = :n`,
              {
                n: name,
              },
            );
          }
        }),
      );
    this.applyLiveDeckWhere(qb);
    const rows = await qb.orderBy('report.submission_date', 'DESC').getMany();
    return rows
      .filter((r) => this.facultyApproved(r))
      .map((r) => this.toCard(r));
  }

  async listForAdmin(): Promise<CommunityAwardCard[]> {
    const qb = this.reports
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.student', 'student')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('opportunity.organization', 'organization');
    this.applyLiveDeckWhere(qb);
    const rows = await qb.orderBy('report.submission_date', 'DESC').getMany();
    return rows
      .filter((r) => this.facultyApproved(r))
      .map((r) => this.toCard(r));
  }

  /** Same org-scoping WHERE clause as listForPartnerOrg/listForUniversity, narrowed to one
   * report id — backs the read-only CII v2 breakdown endpoint so a partner/NGO/university can
   * never fetch a report outside their own scope just by guessing its id. */
  private async findScopedReport(
    reportId: string,
    organizationId: string,
    isUni: boolean,
  ): Promise<StudentReport | null> {
    if (!reportId || !organizationId) return null;
    const qb = this.reports
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.student', 'student')
      .leftJoinAndSelect('report.opportunity', 'opportunity')
      .leftJoinAndSelect('opportunity.organization', 'organization')
      .where('report.id = :rid', { rid: reportId });
    if (isUni) {
      qb.leftJoin('student.organization', 'studentOrg');
      const org = await this.orgs.findOne({ where: { id: organizationId } });
      const name = (org?.name || '').trim().toLowerCase();
      qb.andWhere(
        new Brackets((q) => {
          q.where('studentOrg.id = :oid', { oid: organizationId }).orWhere(
            'opportunity.organizationId = :oid',
            { oid: organizationId },
          );
          if (name) {
            q.orWhere(
              "LOWER(TRIM(COALESCE(student.university, student.institution, ''))) = :n",
              { n: name },
            ).orWhere(
              `LOWER(TRIM(COALESCE(report.section1->'team_lead'->>'university', ''))) = :n`,
              { n: name },
            );
          }
        }),
      );
    } else {
      qb.andWhere('opportunity.organizationId = :oid', { oid: organizationId });
    }
    return qb.getOne();
  }

  /** Read-only CII v2 breakdown (sections/bonus/evidence — never per-criterion detail) for a
   * report this org can see, or null when the report doesn't exist, isn't in scope, or Faculty
   * hasn't approved/locked it yet. Same redaction whitelist the student flashcard already uses. */
  async getCiiV2BreakdownForOrg(
    reportId: string,
    organizationId: string,
    isUni: boolean,
  ): Promise<{ ciiV2: RedactedCiiV2; ciiV2Lock: RedactedCiiV2Lock } | null> {
    const report = await this.findScopedReport(reportId, organizationId, isUni);
    if (!report || !this.facultyApproved(report)) return null;
    const { ciiV2, ciiV2Lock } = redactCiiV2Fields(
      report.ciiV2 as Record<string, unknown> | null,
      report.ciiV2Lock,
    );
    if (!ciiV2 || !ciiV2Lock) return null;
    return { ciiV2, ciiV2Lock };
  }

  /** Same as getCiiV2BreakdownForOrg but unrestricted (Super Admin — platform-wide). */
  async getCiiV2BreakdownForAdmin(
    reportId: string,
  ): Promise<{ ciiV2: RedactedCiiV2; ciiV2Lock: RedactedCiiV2Lock } | null> {
    if (!reportId) return null;
    const report = await this.reports.findOne({ where: { id: reportId } });
    if (!report || !this.facultyApproved(report)) return null;
    const { ciiV2, ciiV2Lock } = redactCiiV2Fields(
      report.ciiV2 as Record<string, unknown> | null,
      report.ciiV2Lock,
    );
    if (!ciiV2 || !ciiV2Lock) return null;
    return { ciiV2, ciiV2Lock };
  }

  async notifyFromPool(
    pool: CommunityAwardCard[],
    dto: NotifyCommunityAwardDto,
    actorName?: string,
  ) {
    const kind = dto.kind as CommunityAwardKind;
    const allowed = new Set(pool.map((c) => c.id));
    const scope = (dto.scopeLabel || 'this ranking').trim();
    const topN = awardTopN(kind);
    // CIEL PK national ranking publishes the whole reviewed cohort. Faculty, partner
    // and university awards stay capped at their top-N medal.
    const picks = (
      dto.picks?.length
        ? dto.picks
        : (dto.reportIds || []).map((reportId, i) => ({
            reportId,
            rank: i + 1,
            of: pool.length,
            total: undefined as number | undefined,
          }))
    )
      .filter((p) => p.reportId && allowed.has(p.reportId))
      .slice(0, kind === 'ciel' ? undefined : topN);
    const label = awardBadgeLabel(kind, scope);
    const seen = new Set<string>();
    let sent = 0;
    for (const pick of picks) {
      if (seen.has(pick.reportId)) continue;
      seen.add(pick.reportId);
      const report = await this.reports.findOne({
        where: { id: pick.reportId },
        relations: ['opportunity'],
      });
      if (!report || !this.facultyApproved(report)) continue;
      const of = pick.of || pool.length;
      const badge = {
        kind,
        label,
        rank: pick.rank,
        of,
        score:
          pick.total ?? pool.find((c) => c.id === pick.reportId)?.total ?? 0,
        scope,
        at: new Date().toISOString(),
        by: actorName || undefined,
      };
      const prev = (report.awardBadges || []).filter((b) => b.kind !== kind);
      const same = (report.awardBadges || []).find(
        (b) =>
          b.kind === kind &&
          b.rank === badge.rank &&
          b.of === badge.of &&
          b.scope === badge.scope,
      );
      report.awardBadges = [...prev, badge];
      report.awardBadgeHistory = [...(report.awardBadgeHistory || []), badge];
      await this.reports.save(report);
      if (same) {
        sent += 1;
        continue;
      }
      const first = (report.section1?.team_lead?.name || 'there').split(' ')[0];
      const title =
        report.opportunity?.title ||
        report.project_id ||
        'your community service';
      try {
        await this.notifications.createNotification(report.studentId, {
          type: 'update',
          title: `${label} — ranked #${pick.rank}`,
          message: `${first}, “${title}” ranked #${pick.rank} of ${of} in ${scope} (${badge.score}/100). Open Community Service → My Impact Wall to see the badge.`,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(
          `Community award notify failed for ${report.id}: ${(err as Error).message}`,
        );
      }
    }
    return {
      notified: sent,
      scope,
      kind,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { StudentReport } from './entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { NotifyCommunityAwardDto } from './dto/notify-community-award.dto';
import {
    awardBadgeLabel,
    awardTopN,
    countMedia,
    readCii,
    scoreCommunityAward,
    type CommunityAwardKind,
} from './community-award.util';

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
    awardBadges: NonNullable<StudentReport['awardBadges']>;
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
        const s4 = report.section4 as Record<string, unknown> | null;
        const s5 = report.section5 as StudentReport['section5'] | null;
        const s7 = report.section7 as StudentReport['section7'] | null;
        const s8 = report.section8 as StudentReport['section8'] | null;
        const s10 = report.section10 as StudentReport['section10'] | null;
        const lead = s1?.team_lead;
        const hours = Number(s1?.metrics?.total_verified_hours ?? 0) || 0;
        const sessions = Number(s4?.total_sessions ?? s4?.my_sessions ?? s1?.metrics?.total_active_days ?? 0) || 0;
        const evidenceCount = countMedia([s1, s2, s3, s4 as { media_urls?: unknown }, s5, s7, s8, s10]);
        const baseline = String(s5?.baseline ?? '').trim();
        const endline = String(s5?.endline ?? '').trim();
        const change = String(s5?.observed_change ?? '').trim();
        const scored = scoreCommunityAward({
            cii: readCii(report.section11 as Record<string, unknown> | null),
            hours,
            sessions,
            evidenceCount,
            hasBaseline: !!baseline,
            hasEndline: !!endline,
            hasMeasuredChange: !!change,
            continuation: (s10?.continuation_status as 'yes' | 'partially' | 'no' | '') || '',
            partnerCount: Array.isArray(s7?.partners) ? s7.partners.length : 0,
        });
        const submitted = report.reportSubmittedAt || report.submission_date || report.createdAt;
        const dt = submitted ? new Date(submitted) : null;
        const sdgNum = s3?.primary_sdg?.goal_number ?? report.primary_sdg_goal;
        const members = Array.isArray(s1?.team_members) ? s1.team_members.length : 0;
        return {
            id: report.id,
            studentId: report.studentId,
            student_name: report.student?.name || lead?.name || 'Student',
            project_title: report.opportunity?.title || report.project_id || 'Community service',
            organization_name: report.opportunity?.organization?.name || 'Partner',
            university: lead?.university || report.student?.university || report.student?.institution || '—',
            department: lead?.degree || report.student?.department || '—',
            faculty_name: String((s1 as { faculty_supervisor_name?: string } | null)?.faculty_supervisor_name || '').trim() || 'Faculty',
            hours,
            sdg: sdgNum ? `SDG ${sdgNum}` : '—',
            evidenceCount,
            story: (s2?.summary_text || s2?.problem_statement || report.summary_text_generated || '').trim(),
            change: [baseline && endline ? `${baseline} → ${endline}` : '', change].filter(Boolean).join(' · '),
            semester: String(lead?.year || '').trim() || '—',
            year: dt ? String(dt.getFullYear()) : '',
            month: dt ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}` : '',
            teamSize: 1 + members,
            faculty_status: report.faculty_status,
            status: report.status,
            cii: readCii(report.section11 as Record<string, unknown> | null),
            pts: scored.pts,
            total: scored.total,
            awardBadges: report.awardBadges ?? [],
        };
    }

    private facultyApproved(report: StudentReport) {
        return (report.faculty_status || '').toLowerCase() === 'approved';
    }

    cardsFrom(reports: StudentReport[], approvedOnly = true): CommunityAwardCard[] {
        return reports.filter((r) => (approvedOnly ? this.facultyApproved(r) : true)).map((r) => this.toCard(r));
    }

    async listForPartnerOrg(organizationId: string): Promise<CommunityAwardCard[]> {
        if (!organizationId) return [];
        const rows = await this.reports.find({
            where: { faculty_status: 'approved', admin_status: 'approved' },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { submission_date: 'DESC' },
        });
        return rows.filter((r) => r.opportunity?.organizationId === organizationId).map((r) => this.toCard(r));
    }

    async listForUniversity(organizationId: string): Promise<CommunityAwardCard[]> {
        if (!organizationId) return [];
        const org = await this.orgs.findOne({ where: { id: organizationId } });
        const name = (org?.name || '').trim().toLowerCase();
        const qb = this.reports
            .createQueryBuilder('report')
            .leftJoinAndSelect('report.student', 'student')
            .leftJoin('student.organization', 'studentOrg')
            .leftJoinAndSelect('report.opportunity', 'opportunity')
            .leftJoinAndSelect('opportunity.organization', 'organization')
            .where('LOWER(TRIM(report.faculty_status)) = :fa', { fa: 'approved' })
            .andWhere('LOWER(TRIM(report.admin_status)) = :aa', { aa: 'approved' })
            .andWhere(
                new Brackets((q) => {
                    q.where('studentOrg.id = :oid', { oid: organizationId }).orWhere(
                        'opportunity.organizationId = :oid',
                        { oid: organizationId },
                    );
                    if (name) {
                        q.orWhere('LOWER(TRIM(COALESCE(student.university, student.institution, \'\'))) = :n', { n: name }).orWhere(
                            `LOWER(TRIM(COALESCE(report.section1->'team_lead'->>'university', ''))) = :n`,
                            { n: name },
                        );
                    }
                }),
            )
            .orderBy('report.submission_date', 'DESC');
        const rows = await qb.getMany();
        return rows.map((r) => this.toCard(r));
    }

    async listForAdmin(): Promise<CommunityAwardCard[]> {
        const rows = await this.reports.find({
            where: { faculty_status: 'approved', admin_status: 'approved' },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { submission_date: 'DESC' },
        });
        return rows.map((r) => this.toCard(r));
    }

    async notifyFromPool(
        pool: CommunityAwardCard[],
        dto: NotifyCommunityAwardDto,
    ) {
        const kind = dto.kind as CommunityAwardKind;
        const allowed = new Set(pool.map((c) => c.id));
        const scope = (dto.scopeLabel || 'this ranking').trim();
        const topN = awardTopN(kind);
        const picks = (dto.picks?.length
            ? dto.picks
            : (dto.reportIds || []).map((reportId, i) => ({
                  reportId,
                  rank: i + 1,
                  of: pool.length,
                  total: undefined as number | undefined,
              }))
        )
            .filter((p) => p.reportId && allowed.has(p.reportId))
            .slice(0, topN);
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
                score: pick.total ?? pool.find((c) => c.id === pick.reportId)?.total ?? 0,
                scope,
                at: new Date().toISOString(),
            };
            const prev = (report.awardBadges || []).filter((b) => b.kind !== kind);
            const same = (report.awardBadges || []).find(
                (b) => b.kind === kind && b.rank === badge.rank && b.of === badge.of && b.scope === badge.scope,
            );
            report.awardBadges = [...prev, badge];
            await this.reports.save(report);
            if (same) {
                sent += 1;
                continue;
            }
            const first = (report.section1?.team_lead?.name || 'there').split(' ')[0];
            const title = report.opportunity?.title || report.project_id || 'your community service';
            try {
                await this.notifications.createNotification(report.studentId, {
                    type: 'update',
                    title: `${label} — ranked #${pick.rank}`,
                    message: `${first}, “${title}” ranked #${pick.rank} of ${of} in ${scope} (${badge.score}/100). Open Community Service → My Impact Wall to see the badge.`,
                });
                sent += 1;
            } catch (err) {
                this.logger.warn(`Community award notify failed for ${report.id}: ${(err as Error).message}`);
            }
        }
        return { notified: sent, scope, kind };
    }
}

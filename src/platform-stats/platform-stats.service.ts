import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Organization } from '../organizations/entities/organization.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';

export type PlatformStatsPayload = {
    contributors: number;
    impact_hours: number | null;
    impact_hours_label: string | null;
    universities: number;
    sdgs_impacted: number;
    students_enrolled: number;
    engagement_hours: number;
    sdgs_covered: number;
    active_projects: number;
    avg_cii_score: number;
    verified_records: number;
    people_reached: number;
};

const VERIFIED_RECORD_STATUSES = ['verified', 'paid'];

const PUBLIC_LIVE_STATUSES = ['active', 'live', 'open', 'recruiting'];

const CONTRIBUTOR_PARTICIPATION_STATUSES = ['approved', 'finalized', 'verified', 'accepted'];

function parseSdgGoal(raw: string | undefined | null): number | null {
    if (raw == null || typeof raw !== 'string') return null;
    const t = raw.trim();
    if (!t || t === 'SDG') return null;
    const m = t.match(/(?:SDG\s*)?(\d{1,2})/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 17) return n;
    return null;
}

function collectSdgGoalsFromOpportunity(opp: Opportunity): number[] {
    const goals: number[] = [];
    const primaryRaw =
        (opp.sdg_info as { sdg_id?: string } | undefined)?.sdg_id != null
            ? String((opp.sdg_info as { sdg_id?: string }).sdg_id)
            : opp.sdg;
    const p = parseSdgGoal(primaryRaw);
    if (p != null) goals.push(p);

    const secondary = opp.secondary_sdgs;
    if (Array.isArray(secondary)) {
        for (const row of secondary) {
            const id = row && typeof row === 'object' && row !== null ? (row as { sdg_id?: string }).sdg_id : null;
            const g = parseSdgGoal(id != null ? String(id) : null);
            if (g != null) goals.push(g);
        }
    }
    return goals;
}

@Injectable()
export class PlatformStatsService {
    constructor(
        @InjectRepository(User) private readonly usersRepository: Repository<User>,
        @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
        @InjectRepository(Opportunity) private readonly opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(Participation) private readonly participationsRepository: Repository<Participation>,
        @InjectRepository(AttendanceLog) private readonly attendanceLogsRepository: Repository<AttendanceLog>,
        @InjectRepository(StudentReport) private readonly studentReportsRepository: Repository<StudentReport>,
    ) {}

    async getAggregatedStats(): Promise<PlatformStatsPayload> {
        const [
            contributors,
            studentsEnrolled,
            universities,
            opportunities,
            engagementHours,
            avgCiiScore,
            verifiedRecords,
            peopleReached,
        ] = await Promise.all([
                this.countDistinctContributors(),
                this.countStudentsEnrolled(),
                this.countApprovedUniversities(),
                this.opportunitiesRepository.find({
                    where: { status: In(PUBLIC_LIVE_STATUSES) },
                    select: [
                        'id',
                        'sdg',
                        'sdg_info',
                        'secondary_sdgs',
                        'participation_scope',
                        'visibility_and_academic_linkage',
                        'visibility',
                    ],
                }),
                this.sumEngagementHours(),
                this.getAverageCiiScore(),
                this.countVerifiedRecords(),
                this.sumPeopleReached(),
            ]);

        const sdgSet = new Set<number>();
        const activeProjects = opportunities.length;
        for (const opp of opportunities) {
            for (const g of collectSdgGoalsFromOpportunity(opp)) {
                sdgSet.add(g);
            }
        }

        const impactHoursRaw = process.env.PLATFORM_STATS_IMPACT_HOURS;
        let configuredImpactHours: number | null = null;
        if (impactHoursRaw != null && impactHoursRaw.trim() !== '') {
            const n = parseInt(impactHoursRaw.trim(), 10);
            if (!Number.isNaN(n) && n >= 0) {
                configuredImpactHours = n;
            }
        }

        const impact_hours = configuredImpactHours ?? engagementHours;
        const defaultLabel = 'Launching Pilot';
        const impact_hours_label =
            configuredImpactHours == null && engagementHours === 0
                ? (process.env.PLATFORM_STATS_IMPACT_HOURS_LABEL?.trim() || defaultLabel)
                : null;

        const sdgsImpacted = Math.min(17, sdgSet.size);

        return {
            contributors,
            impact_hours,
            impact_hours_label,
            universities,
            sdgs_impacted: sdgsImpacted,
            students_enrolled: studentsEnrolled,
            engagement_hours: engagementHours,
            sdgs_covered: sdgsImpacted,
            active_projects: activeProjects,
            avg_cii_score: avgCiiScore,
            verified_records: verifiedRecords,
            people_reached: peopleReached,
        };
    }

    private toBeneficiaryCount(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }

    /** A "record" is a student report that has cleared verification. */
    private async countVerifiedRecords(): Promise<number> {
        return this.studentReportsRepository.count({
            where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
        });
    }

    /** Mirrors the admin analytics beneficiary rollup: report-declared beneficiaries, falling back to the opportunity's own count for live opportunities no verified report has already covered. */
    private async sumPeopleReached(): Promise<number> {
        const [reports, opportunities] = await Promise.all([
            this.studentReportsRepository.find({
                where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
                select: ['opportunityId', 'project_id', 'section4'],
            }),
            this.opportunitiesRepository.find({
                where: { status: In(PUBLIC_LIVE_STATUSES) },
                select: ['id', 'objectives'],
            }),
        ]);

        const projectIdsFromReports = new Set<string>();
        const reportBeneficiaries = reports.reduce((sum, report) => {
            const projectId = report.opportunityId || report.project_id || null;
            if (projectId) projectIdsFromReports.add(projectId);
            const section4 = report.section4 as
                | {
                      project_summary?: { distinct_total_beneficiaries?: unknown };
                      distinct_total_beneficiaries?: unknown;
                      total_beneficiaries?: unknown;
                      my_beneficiaries?: unknown;
                  }
                | undefined;
            const beneficiaries =
                this.toBeneficiaryCount(section4?.project_summary?.distinct_total_beneficiaries) ||
                this.toBeneficiaryCount(section4?.distinct_total_beneficiaries) ||
                this.toBeneficiaryCount(section4?.total_beneficiaries) ||
                this.toBeneficiaryCount(section4?.my_beneficiaries);
            return sum + beneficiaries;
        }, 0);

        const opportunityBeneficiaries = opportunities.reduce((sum, opportunity) => {
            if (projectIdsFromReports.has(opportunity.id)) return sum;
            const objectives = opportunity.objectives as
                | { beneficiaries_count?: unknown; total_beneficiaries?: unknown }
                | undefined;
            const beneficiaries =
                this.toBeneficiaryCount(objectives?.beneficiaries_count) ||
                this.toBeneficiaryCount(objectives?.total_beneficiaries);
            return sum + beneficiaries;
        }, 0);

        return reportBeneficiaries + opportunityBeneficiaries;
    }

    /** Verified students ∪ students with at least one approved participation (deduped; no PII in response). */
    private async countDistinctContributors(): Promise<number> {
        const [participationRows, verifiedStudents] = await Promise.all([
            this.participationsRepository.find({
                where: {
                    studentId: Not(IsNull()),
                    status: In(CONTRIBUTOR_PARTICIPATION_STATUSES),
                },
                select: ['studentId'],
            }),
            this.usersRepository
                .createQueryBuilder('u')
                .select(['u.id'])
                .where('u.role = :role', { role: UserRole.STUDENT })
                .andWhere('u.status = :active', { active: 'active' })
                .andWhere('(u.profile_verified = true OR u.identity_verified = true)')
                .getMany(),
        ]);

        const ids = new Set<string>();
        for (const p of participationRows) {
            if (p.studentId) ids.add(p.studentId);
        }
        for (const u of verifiedStudents) {
            ids.add(u.id);
        }
        return ids.size;
    }

    private async countStudentsEnrolled(): Promise<number> {
        return this.usersRepository.count({
            where: { role: UserRole.STUDENT },
        });
    }

    private async countApprovedUniversities(): Promise<number> {
        return this.organizationsRepository
            .createQueryBuilder('o')
            .where('LOWER(o.orgType) = :t', { t: 'university' })
            .andWhere('o.verificationStatus = :v', { v: 'APPROVED' })
            .andWhere('o.isBlocked = false')
            .getCount();
    }

    private async sumEngagementHours(): Promise<number> {
        const row = await this.attendanceLogsRepository
            .createQueryBuilder('log')
            .select('COALESCE(SUM(log.sessionHours), 0)', 'total')
            .where('(log.approvalStatus IS NULL OR log.approvalStatus = :empty OR log.approvalStatus = :approved)', {
                empty: '',
                approved: 'approved',
            })
            .getRawOne<{ total: string | number | null }>();

        const total = Number(row?.total ?? 0);
        return Number.isFinite(total) ? Math.round(total) : 0;
    }

    private async getAverageCiiScore(): Promise<number> {
        const reports = await this.studentReportsRepository.find({
            select: ['section11'],
        });

        const scores = reports
            .map((report) =>
                Number(
                    (report.section11 as { ai_generated_impact_score?: number } | null | undefined)
                        ?.ai_generated_impact_score,
                ),
            )
            .filter((score) => Number.isFinite(score) && score >= 0);

        if (scores.length === 0) return 0;

        const total = scores.reduce((sum, score) => sum + score, 0);
        return Math.round(total / scores.length);
    }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Organization } from '../organizations/entities/organization.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
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
};

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

function isPubliclyListableOpportunity(opp: Opportunity): boolean {
    const visibilityType = String(
        (opp.visibility_and_academic_linkage as { visibility_type?: string } | undefined)
            ?.visibility_type ||
            opp.visibility ||
            '',
    )
        .trim()
        .toLowerCase();

    return !['own_university_only', 'restricted_specific_universities', 'restricted'].includes(
        visibilityType,
    );
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
        @InjectRepository(StudentReport) private readonly studentReportsRepository: Repository<StudentReport>,
    ) {}

    async getAggregatedStats(): Promise<PlatformStatsPayload> {
        const [contributors, universities, opportunities, avgCiiScore] = await Promise.all([
            this.countDistinctContributors(),
            this.countApprovedUniversities(),
            this.opportunitiesRepository.find({
                where: { status: In(PUBLIC_LIVE_STATUSES), admin_approved: true },
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
            this.getAverageCiiScore(),
        ]);

        const sdgSet = new Set<number>();
        let activeProjects = 0;
        for (const opp of opportunities) {
            if (!isPubliclyListableOpportunity(opp)) continue;
            activeProjects += 1;
            for (const g of collectSdgGoalsFromOpportunity(opp)) {
                sdgSet.add(g);
            }
        }

        const impactHoursRaw = process.env.PLATFORM_STATS_IMPACT_HOURS;
        let impact_hours: number | null = null;
        if (impactHoursRaw != null && impactHoursRaw.trim() !== '') {
            const n = parseInt(impactHoursRaw.trim(), 10);
            if (!Number.isNaN(n) && n >= 0) {
                impact_hours = n;
            }
        }

        const defaultLabel = 'Launching Pilot';
        const impact_hours_label =
            impact_hours == null
                ? (process.env.PLATFORM_STATS_IMPACT_HOURS_LABEL?.trim() || defaultLabel)
                : null;

        const sdgsImpacted = Math.min(17, sdgSet.size);

        return {
            contributors,
            impact_hours,
            impact_hours_label,
            universities,
            sdgs_impacted: sdgsImpacted,
            students_enrolled: contributors,
            engagement_hours: impact_hours ?? 0,
            sdgs_covered: sdgsImpacted,
            active_projects: activeProjects,
            avg_cii_score: avgCiiScore,
        };
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

    private async countApprovedUniversities(): Promise<number> {
        return this.organizationsRepository
            .createQueryBuilder('o')
            .where('LOWER(o.orgType) = :t', { t: 'university' })
            .andWhere('o.verificationStatus = :v', { v: 'APPROVED' })
            .andWhere('o.isBlocked = false')
            .getCount();
    }

    private async getAverageCiiScore(): Promise<number> {
        const reports = await this.studentReportsRepository.find({
            where: { status: In(['verified', 'paid']) },
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

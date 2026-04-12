import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Organization } from '../organizations/entities/organization.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';

export type PlatformStatsPayload = {
    contributors: number;
    impact_hours: number | null;
    impact_hours_label: string | null;
    universities: number;
    sdgs_impacted: number;
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
    ) {}

    async getAggregatedStats(): Promise<PlatformStatsPayload> {
        const [contributors, universities, opportunities] = await Promise.all([
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
        ]);

        const sdgSet = new Set<number>();
        for (const opp of opportunities) {
            if (!isPubliclyListableOpportunity(opp)) continue;
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

        return {
            contributors,
            impact_hours,
            impact_hours_label,
            universities,
            sdgs_impacted: Math.min(17, sdgSet.size),
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
}

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
import { CourseProjectEntry } from '../paths/entities/course-project-entry.entity';
import { FypEntry } from '../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../paths/entities/venture-entry.entity';
import { computeVentureGates } from '../paths/venture-gates.util';
import { normalizeCityKey, PAKISTAN_CITY_GEO } from './pakistan-geo';

export type CityImpactStat = {
  id: string;
  name: string;
  province: string;
  lat: number;
  lon: number;
  peopleServing: number;
  peopleServed: number;
  verifiedHours: number;
  resourcesDeployedPkr: number;
  outOfPocketPkr: number;
  communityDividendPkr: number;
  verifiedReports: number;
  sdgs: number[];
  partners: string[];
};

export type RecentActivityItem = {
  city: string | null;
  hours: number;
  beneficiaries: number;
  partnerName: string | null;
  verifiedAt: string;
};

export type SdgProjectItem = {
  title: string;
  city: string | null;
  path: string;
  verifiedAt: string;
};

export type SdgImpactStat = {
  number: number;
  projects: number;
  attributedHours: number;
  peopleServed: number;
  cities: number;
  items: SdgProjectItem[];
};

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
  /** Community-service-report-driven ledger — see computeCommunityLedger() for the exact formula. */
  people_serving: number;
  report_verified_hours: number;
  resources_deployed_pkr: number;
  out_of_pocket_pkr: number;
  community_dividend_pkr: number;
  dividend_hourly_rate_pkr: number;
  partner_organisations: number;
  verified_projects_all_paths: number;
  cities_live: number;
  sdgs_touched_by_reports: number;
  partners_come_back_pct: number;
  cities: CityImpactStat[];
  recent_activity: RecentActivityItem[];
  sdgs: SdgImpactStat[];
};

const VERIFIED_RECORD_STATUSES = ['verified', 'paid'];

/** PKR value assigned to one verified volunteer hour in the community-dividend formula:
 * Σ Verified Student Person-Hours × Volunteer Hour Value + Verified Student Out-of-Pocket Spending. */
const DIVIDEND_HOURLY_RATE_PKR = 500;

function isPkrResourceUnit(unit: unknown): boolean {
  return (
    typeof unit === 'string' && /pkr|rs\.?|rupee|cash|financial/i.test(unit)
  );
}

function isSelfFundedSource(source: unknown): boolean {
  return (
    typeof source === 'string' &&
    /self|own|personal|out.?of.?pocket|student/i.test(source)
  );
}

const PUBLIC_LIVE_STATUSES = ['active', 'live', 'open', 'recruiting'];

const CONTRIBUTOR_PARTICIPATION_STATUSES = [
  'approved',
  'finalized',
  'verified',
  'accepted',
];

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
      const id =
        row && typeof row === 'object' && row !== null
          ? (row as { sdg_id?: string }).sdg_id
          : null;
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
    @InjectRepository(Organization)
    private readonly organizationsRepository: Repository<Organization>,
    @InjectRepository(Opportunity)
    private readonly opportunitiesRepository: Repository<Opportunity>,
    @InjectRepository(Participation)
    private readonly participationsRepository: Repository<Participation>,
    @InjectRepository(AttendanceLog)
    private readonly attendanceLogsRepository: Repository<AttendanceLog>,
    @InjectRepository(StudentReport)
    private readonly studentReportsRepository: Repository<StudentReport>,
    @InjectRepository(CourseProjectEntry)
    private readonly courseProjectRepository: Repository<CourseProjectEntry>,
    @InjectRepository(FypEntry)
    private readonly fypRepository: Repository<FypEntry>,
    @InjectRepository(VentureEntry)
    private readonly ventureRepository: Repository<VentureEntry>,
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
      communityLedger,
      partnerOrganisations,
      verifiedProjectsAllPaths,
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
      this.computeCommunityLedger(),
      this.computePartnerStats(),
      this.countVerifiedProjectsAllPaths(),
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
        ? process.env.PLATFORM_STATS_IMPACT_HOURS_LABEL?.trim() || defaultLabel
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
      people_serving: communityLedger.peopleServing,
      report_verified_hours: communityLedger.verifiedHours,
      resources_deployed_pkr: communityLedger.resourcesDeployedPkr,
      out_of_pocket_pkr: communityLedger.outOfPocketPkr,
      community_dividend_pkr: communityLedger.communityDividendPkr,
      dividend_hourly_rate_pkr: DIVIDEND_HOURLY_RATE_PKR,
      partner_organisations: partnerOrganisations.count,
      verified_projects_all_paths: verifiedProjectsAllPaths,
      cities_live: communityLedger.cities.length,
      sdgs_touched_by_reports: communityLedger.sdgsTouched,
      partners_come_back_pct: partnerOrganisations.comeBackPct,
      cities: communityLedger.cities,
      recent_activity: communityLedger.recentActivity,
      sdgs: communityLedger.sdgs,
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

  /**
   * Public "not estimates" claim means this must only count beneficiaries from verified student
   * reports — unlike the admin analytics rollup, it deliberately excludes opportunities' own
   * self-reported `beneficiaries_count` (set by whoever created the listing, never audited).
   */
  private async sumPeopleReached(): Promise<number> {
    const reports = await this.studentReportsRepository.find({
      where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
      select: ['section4'],
    });

    return reports.reduce((sum, report) => {
      const section4 = report.section4 as
        | {
            project_summary?: { distinct_total_beneficiaries?: unknown };
            distinct_total_beneficiaries?: unknown;
            total_beneficiaries?: unknown;
            my_beneficiaries?: unknown;
          }
        | undefined;
      const beneficiaries =
        this.toBeneficiaryCount(
          section4?.project_summary?.distinct_total_beneficiaries,
        ) ||
        this.toBeneficiaryCount(section4?.distinct_total_beneficiaries) ||
        this.toBeneficiaryCount(section4?.total_beneficiaries) ||
        this.toBeneficiaryCount(section4?.my_beneficiaries);
      return sum + beneficiaries;
    }, 0);
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

  /** Same "verified" definition used throughout section1-analytics.service.ts — approvalStatus alone
   * is null for any row that predates the approval-request workflow (see AttendanceLog entity), so it
   * must never be treated as verified on its own; entryStatus is the field that actually defaults to
   * 'pending' and only flips to 'verified' once reviewed. */
  private async sumEngagementHours(): Promise<number> {
    const row = await this.attendanceLogsRepository
      .createQueryBuilder('log')
      .select('COALESCE(SUM(log.sessionHours), 0)', 'total')
      .where(
        '(log.approvalStatus = :approved OR log.entryStatus = :verified)',
        {
          approved: 'approved',
          verified: 'verified',
        },
      )
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
          (
            report.section11 as
              | { ai_generated_impact_score?: number }
              | null
              | undefined
          )?.ai_generated_impact_score,
        ),
      )
      .filter((score) => Number.isFinite(score) && score >= 0);

    if (scores.length === 0) return 0;

    const total = scores.reduce((sum, score) => sum + score, 0);
    return Math.round(total / scores.length);
  }

  /**
   * The public community-impact ledger (hero tiles + per-city map). Only student_reports carries
   * hours/PKR-resources/beneficiaries/city(via the reporting student)/partner(via its opportunity)
   * in any structured form — Course Project / FYP / Venture entries are academic-output records
   * with no hours/money/beneficiary fields, so they're deliberately excluded here (they still count
   * toward verified_projects_all_paths below, just not toward this ledger's numbers).
   *
   * Community dividend = Σ(verified person-hours) × dividend hourly rate + Σ(verified
   * out-of-pocket spending) — the formula the ledger tiles are built to show.
   */
  private async computeCommunityLedger(): Promise<{
    peopleServing: number;
    verifiedHours: number;
    resourcesDeployedPkr: number;
    outOfPocketPkr: number;
    communityDividendPkr: number;
    sdgsTouched: number;
    cities: CityImpactStat[];
    recentActivity: RecentActivityItem[];
    sdgs: SdgImpactStat[];
  }> {
    const reports = await this.studentReportsRepository.find({
      where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
      relations: ['student', 'opportunity', 'opportunity.organization'],
    });

    const studentIds = new Set<string>();
    const sdgSet = new Set<number>();
    let verifiedHours = 0;
    let resourcesDeployedPkr = 0;
    let outOfPocketPkr = 0;

    type CityAccumulator = {
      studentIds: Set<string>;
      peopleServed: number;
      verifiedHours: number;
      resourcesDeployedPkr: number;
      outOfPocketPkr: number;
      verifiedReports: number;
      sdgs: Set<number>;
      partners: Set<string>;
    };
    const cityAcc = new Map<string, CityAccumulator>();
    const activityCandidates: RecentActivityItem[] = [];

    type SdgAccumulator = {
      projects: number;
      attributedHours: number;
      peopleServed: number;
      cities: Set<string>;
      items: SdgProjectItem[];
    };
    const sdgAcc = new Map<number, SdgAccumulator>();

    for (const report of reports) {
      if (report.studentId) studentIds.add(report.studentId);

      const hours = Number(report.section1?.metrics?.total_verified_hours) || 0;
      verifiedHours += hours;

      const beneficiaries =
        this.toBeneficiaryCount(
          (
            report.section4 as
              | { project_summary?: { distinct_total_beneficiaries?: unknown } }
              | undefined
          )?.project_summary?.distinct_total_beneficiaries,
        ) ||
        this.toBeneficiaryCount(
          (
            report.section4 as
              | { distinct_total_beneficiaries?: unknown }
              | undefined
          )?.distinct_total_beneficiaries,
        ) ||
        this.toBeneficiaryCount(report.section4?.total_beneficiaries) ||
        this.toBeneficiaryCount(report.section4?.my_beneficiaries);

      let reportResourcesPkr = 0;
      let reportOutOfPocketPkr = 0;
      const resources = report.section6?.resources;
      if (Array.isArray(resources)) {
        for (const r of resources) {
          if (!isPkrResourceUnit(r?.unit)) continue;
          const amt = Number(r?.amount);
          if (!Number.isFinite(amt) || amt <= 0) continue;
          if (isSelfFundedSource(r?.source)) reportOutOfPocketPkr += amt;
          else reportResourcesPkr += amt;
        }
      }
      resourcesDeployedPkr += reportResourcesPkr;
      outOfPocketPkr += reportOutOfPocketPkr;

      const reportSdgs = new Set<number>();
      if (
        Number.isFinite(report.primary_sdg_goal) &&
        (report.primary_sdg_goal as number) >= 1 &&
        (report.primary_sdg_goal as number) <= 17
      ) {
        reportSdgs.add(report.primary_sdg_goal as number);
      }
      const secondary = report.section3?.secondary_sdgs;
      if (Array.isArray(secondary)) {
        for (const s of secondary) {
          if (
            s?.status === 'validated' &&
            Number.isFinite(s.goal_number) &&
            s.goal_number >= 1 &&
            s.goal_number <= 17
          ) {
            reportSdgs.add(s.goal_number);
          }
        }
      }
      for (const g of reportSdgs) sdgSet.add(g);

      const cityKey = normalizeCityKey(report.student?.city);
      if (cityKey) {
        let acc = cityAcc.get(cityKey);
        if (!acc) {
          acc = {
            studentIds: new Set(),
            peopleServed: 0,
            verifiedHours: 0,
            resourcesDeployedPkr: 0,
            outOfPocketPkr: 0,
            verifiedReports: 0,
            sdgs: new Set(),
            partners: new Set(),
          };
          cityAcc.set(cityKey, acc);
        }
        if (report.studentId) acc.studentIds.add(report.studentId);
        acc.peopleServed += beneficiaries;
        acc.verifiedHours += hours;
        acc.resourcesDeployedPkr += reportResourcesPkr;
        acc.outOfPocketPkr += reportOutOfPocketPkr;
        acc.verifiedReports += 1;
        for (const g of reportSdgs) acc.sdgs.add(g);
        const partnerName = report.opportunity?.organization?.name;
        if (partnerName) acc.partners.add(partnerName);
      }

      const geo = cityKey ? PAKISTAN_CITY_GEO[cityKey] : null;
      const verifiedAt =
        report.adminApprovedAt ?? report.partnerApprovedAt ?? report.updatedAt;
      const verifiedAtIso = (
        verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt)
      ).toISOString();
      activityCandidates.push({
        city: geo?.name ?? null,
        hours: Math.round(hours),
        beneficiaries,
        partnerName: report.opportunity?.organization?.name ?? null,
        verifiedAt: verifiedAtIso,
      });

      for (const g of reportSdgs) {
        let sAcc = sdgAcc.get(g);
        if (!sAcc) {
          sAcc = {
            projects: 0,
            attributedHours: 0,
            peopleServed: 0,
            cities: new Set(),
            items: [],
          };
          sdgAcc.set(g, sAcc);
        }
        sAcc.projects += 1;
        sAcc.attributedHours += hours;
        sAcc.peopleServed += beneficiaries;
        if (cityKey) sAcc.cities.add(cityKey);
        sAcc.items.push({
          title: report.opportunity?.title || 'Community Service record',
          city: geo?.name ?? null,
          path: 'Community Service',
          verifiedAt: verifiedAtIso,
        });
      }
    }

    const cities: CityImpactStat[] = [...cityAcc.entries()]
      .map(([key, acc]) => {
        const geo = PAKISTAN_CITY_GEO[key];
        return {
          id: key,
          name: geo.name,
          province: geo.province,
          lat: geo.lat,
          lon: geo.lon,
          peopleServing: acc.studentIds.size,
          peopleServed: acc.peopleServed,
          verifiedHours: Math.round(acc.verifiedHours),
          resourcesDeployedPkr: Math.round(acc.resourcesDeployedPkr),
          outOfPocketPkr: Math.round(acc.outOfPocketPkr),
          communityDividendPkr: Math.round(
            acc.verifiedHours * DIVIDEND_HOURLY_RATE_PKR + acc.outOfPocketPkr,
          ),
          verifiedReports: acc.verifiedReports,
          sdgs: [...acc.sdgs].sort((a, b) => a - b),
          partners: [...acc.partners].sort(),
        };
      })
      .sort((a, b) => b.peopleServing - a.peopleServing);

    return {
      peopleServing: studentIds.size,
      verifiedHours: Math.round(verifiedHours),
      resourcesDeployedPkr: Math.round(resourcesDeployedPkr),
      outOfPocketPkr: Math.round(outOfPocketPkr),
      communityDividendPkr: Math.round(
        verifiedHours * DIVIDEND_HOURLY_RATE_PKR + outOfPocketPkr,
      ),
      sdgsTouched: sdgSet.size,
      cities,
      recentActivity: activityCandidates
        .sort(
          (a, b) =>
            new Date(b.verifiedAt).getTime() - new Date(a.verifiedAt).getTime(),
        )
        .slice(0, 6),
      sdgs: [...sdgAcc.entries()]
        .map(([number, acc]) => ({
          number,
          projects: acc.projects,
          attributedHours: Math.round(acc.attributedHours),
          peopleServed: acc.peopleServed,
          cities: acc.cities.size,
          items: acc.items
            .sort(
              (a, b) =>
                new Date(b.verifiedAt).getTime() -
                new Date(a.verifiedAt).getTime(),
            )
            .slice(0, 12),
        }))
        .sort((a, b) => a.number - b.number),
    };
  }

  /** Partner orgs = approved, non-blocked NGO/corporate orgs (there's no distinct "partner" orgType —
   * partners are NGO/corporate accounts, mirrored from countApprovedUniversities' pattern). "Come
   * back" = an approved partner org with verified/paid reports spanning 2+ distinct opportunities
   * it posted — a real repeat-engagement signal, not just one project verified twice. */
  private async computePartnerStats(): Promise<{
    count: number;
    comeBackPct: number;
  }> {
    const partners = await this.organizationsRepository
      .createQueryBuilder('o')
      .where('LOWER(o.orgType) IN (:...types)', { types: ['ngo', 'corporate'] })
      .andWhere('o.verificationStatus = :v', { v: 'APPROVED' })
      .andWhere('o.isBlocked = false')
      .select(['o.id'])
      .getMany();

    if (!partners.length) return { count: 0, comeBackPct: 0 };

    const rows = await this.studentReportsRepository
      .createQueryBuilder('r')
      .innerJoin('r.opportunity', 'opp')
      .where('r.status IN (:...statuses)', {
        statuses: VERIFIED_RECORD_STATUSES,
      })
      .andWhere('opp.organizationId IS NOT NULL')
      .select([
        'opp.organizationId AS "orgId"',
        'r.opportunityId AS "opportunityId"',
      ])
      .getRawMany<{ orgId: string; opportunityId: string }>();

    const opportunitiesByOrg = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.orgId || !row.opportunityId) continue;
      let set = opportunitiesByOrg.get(row.orgId);
      if (!set) {
        set = new Set();
        opportunitiesByOrg.set(row.orgId, set);
      }
      set.add(row.opportunityId);
    }

    const returning = partners.filter(
      (p) => (opportunitiesByOrg.get(p.id)?.size ?? 0) >= 2,
    ).length;
    const comeBackPct = Math.round((returning / partners.length) * 100);
    return { count: partners.length, comeBackPct };
  }

  /** "Verified projects" spans all four paths — unlike computeCommunityLedger, this only needs a
   * count per entity's own established "verified" definition (see each path's own service). */
  private async countVerifiedProjectsAllPaths(): Promise<number> {
    const [reports, courseProjects, fyps, ventures] = await Promise.all([
      this.countVerifiedRecords(),
      this.courseProjectRepository.count({
        where: { status: 'submitted', facultyApprovalStatus: 'approved' },
      }),
      this.fypRepository.count({
        where: { status: 'submitted', supervisorApprovalStatus: 'approved' },
      }),
      this.ventureRepository.find(),
    ]);
    const verifiedVentures = ventures.filter(
      (v) => computeVentureGates(v).showcaseOk,
    ).length;
    return reports + courseProjects + fyps + verifiedVentures;
  }
}

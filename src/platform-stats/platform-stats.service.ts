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
import {
  DIVIDEND_HOURLY_RATE_PKR,
  beneficiariesFromSection4,
  communityDividendPkr,
  creditPairOnce,
  hoursFromReportSection1,
  membersFromReportSection1,
  isPlaceholderPartnerOrg,
  partnerNamesFromSection7,
  normalizePartnerKey,
  pkrFromResources,
  sdgsFromVerifiedReport,
  servingMemberKey,
  sumPeopleServing,
} from './platform-stats.ledger.util';

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
  /** Sum of unique team members on each project that has a verified/paid report (not just the students who submitted). */
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

const PUBLIC_LIVE_STATUSES = ['active', 'live', 'open', 'recruiting'];

const CONTRIBUTOR_PARTICIPATION_STATUSES = [
  'approved',
  'finalized',
  'verified',
  'accepted',
];

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
      communityLedger,
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
      this.computeCommunityLedger(),
      this.countVerifiedProjectsAllPaths(),
    ]);

    const activeProjects = opportunities.length;

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

    const sdgsImpacted = Math.min(17, communityLedger.sdgsTouched);

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
      people_reached: communityLedger.peopleReached,
      people_serving: communityLedger.peopleServing,
      report_verified_hours: communityLedger.verifiedHours,
      resources_deployed_pkr: communityLedger.resourcesDeployedPkr,
      out_of_pocket_pkr: communityLedger.outOfPocketPkr,
      community_dividend_pkr: communityLedger.communityDividendPkr,
      dividend_hourly_rate_pkr: DIVIDEND_HOURLY_RATE_PKR,
      partner_organisations: communityLedger.partnerOrganisations,
      verified_projects_all_paths: verifiedProjectsAllPaths,
      cities_live: communityLedger.cities.length,
      sdgs_touched_by_reports: communityLedger.sdgsTouched,
      partners_come_back_pct: communityLedger.partnersComeBackPct,
      cities: communityLedger.cities,
      recent_activity: communityLedger.recentActivity,
      sdgs: communityLedger.sdgs,
    };
  }

  /** A "record" is a student report that has cleared verification. */
  private async countVerifiedRecords(): Promise<number> {
    return this.studentReportsRepository.count({
      where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
    });
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
      .andWhere('UPPER(o.verificationStatus) = :v', { v: 'APPROVED' })
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

  /** Real, server-computed verified hours per (project, student) pair — same verified definition
   * as sumEngagementHours, batched across every report at once so the community-dividend ledger
   * doesn't run one query per report. Never trusts a report's own client-submitted
   * section1.metrics.total_verified_hours, which a report's own author controls.
   *
   * Grouped by student as well as project: an opportunity's attendance logs cover every
   * participant on it, so grouping by project alone would attribute the *whole* project's hours
   * to each verified report against it — inflating the total whenever more than one student
   * reports on the same opportunity (a very normal case). Matches the per-student scoping already
   * used in section1-analytics.service.ts's sumVerifiedHours(). */
  private async sumVerifiedHoursByProjectAndStudent(
    pairs: { projectId: string; studentId: string }[],
  ): Promise<Map<string, number>> {
    const byKey = new Map<string, number>();
    const uniquePairs = Array.from(
      new Map(
        pairs
          .filter((p) => p.projectId && p.studentId)
          .map((p) => [`${p.projectId}:${p.studentId}`, p] as const),
      ).values(),
    );
    if (uniquePairs.length === 0) return byKey;

    const projectIds = Array.from(new Set(uniquePairs.map((p) => p.projectId)));
    const studentIds = Array.from(new Set(uniquePairs.map((p) => p.studentId)));

    const rows = await this.attendanceLogsRepository
      .createQueryBuilder('log')
      .innerJoin('log.participant', 'part')
      .select('log.projectId', 'projectId')
      .addSelect('part.studentId', 'studentId')
      .addSelect('COALESCE(SUM(log.sessionHours), 0)', 'total')
      .where('log.projectId IN (:...projectIds)', { projectIds })
      .andWhere('part.studentId IN (:...studentIds)', { studentIds })
      .andWhere(
        `(log.approvalStatus = 'approved' OR log.entryStatus = 'verified')`,
      )
      .groupBy('log.projectId')
      .addGroupBy('part.studentId')
      .getRawMany<{ projectId: string; studentId: string; total: string | number | null }>();

    for (const row of rows) {
      const total = Number(row.total ?? 0);
      byKey.set(`${row.projectId}:${row.studentId}`, Number.isFinite(total) ? total : 0);
    }
    return byKey;
  }

  private async getAverageCiiScore(): Promise<number> {
    const reports = await this.studentReportsRepository.find({
      where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
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
    peopleReached: number;
    verifiedHours: number;
    resourcesDeployedPkr: number;
    outOfPocketPkr: number;
    communityDividendPkr: number;
    sdgsTouched: number;
    partnerOrganisations: number;
    partnersComeBackPct: number;
    cities: CityImpactStat[];
    recentActivity: RecentActivityItem[];
    sdgs: SdgImpactStat[];
  }> {
    const reports = await this.studentReportsRepository.find({
      where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
      relations: ['student', 'opportunity', 'opportunity.organization'],
    });
    const verifiedHoursByProjectStudent = await this.sumVerifiedHoursByProjectAndStudent(
      reports.map((r) => ({
        projectId: r.opportunityId || r.project_id,
        studentId: r.studentId,
      })),
    );

    const projectIds = [
      ...new Set(
        reports
          .map((r) => r.opportunityId || r.project_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const participations = projectIds.length
      ? await this.participationsRepository.find({
          where: { projectId: In(projectIds) },
          select: ['id', 'projectId', 'studentId', 'email', 'status'],
        })
      : [];
    const rosterByProject = new Map<string, Set<string>>();
    for (const p of participations) {
      if (p.status === 'rejected') continue;
      const key = servingMemberKey(p);
      if (!key) continue;
      let roster = rosterByProject.get(p.projectId);
      if (!roster) {
        roster = new Set();
        rosterByProject.set(p.projectId, roster);
      }
      roster.add(key);
    }

    const creditedProjects = new Set<string>();
    const projectCity = new Map<string, string>();
    const projectMemberHint = new Map<string, number>();
    const partnerKeys = new Set<string>();
    const oppsByPartnerOrg = new Map<string, Set<string>>();
    const creditedSdgProjects = new Set<string>();
    const sdgSet = new Set<number>();
    const creditedHourKeys = new Set<string>();
    const creditedSdgHourKeys = new Set<string>();
    let verifiedHours = 0;
    let peopleReachedLoose = 0;
    let resourcesDeployedLoose = 0;
    let outOfPocketLoose = 0;
    let peopleServingWithoutProject = 0;

    type CityAccumulator = {
      peopleServing: number;
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
      const projectId = report.opportunityId || report.project_id || '';
      const pairKey =
        report.studentId && projectId
          ? `${projectId}:${report.studentId}`
          : report.id
            ? `report:${report.id}`
            : '';
      const attendanceHours = pairKey
        ? verifiedHoursByProjectStudent.get(pairKey) || 0
        : 0;
      const reportHours = hoursFromReportSection1(report.section1);
      const pairHours = reportHours > 0 ? reportHours : attendanceHours;
      const firstForPair = creditPairOnce(pairKey, creditedHourKeys);
      if (firstForPair) verifiedHours += pairHours;

      const beneficiaries = beneficiariesFromSection4(report.section4);
      const pkr = pkrFromResources(report.section6?.resources);
      const reportMembers = membersFromReportSection1(
        report.section1,
        report.studentId,
      );
      if (firstForPair) {
        peopleReachedLoose += beneficiaries;
        resourcesDeployedLoose += pkr.deployed;
        outOfPocketLoose += pkr.outOfPocket;
        if (projectId) {
          creditedProjects.add(projectId);
          let roster = rosterByProject.get(projectId);
          if (!roster) {
            roster = new Set();
            rosterByProject.set(projectId, roster);
          }
          const reporterKey = servingMemberKey({
            studentId: report.studentId,
            id: report.id,
          });
          if (reporterKey) roster.add(reporterKey);
          const s1 = report.section1 as
            | {
                team_lead?: { email?: string; name?: string; cnic?: string };
                team_members?: Array<{
                  email?: string;
                  name?: string;
                  cnic?: string;
                }>;
              }
            | undefined;
          const leadKey = servingMemberKey({
            email: s1?.team_lead?.email,
            id: s1?.team_lead?.cnic || s1?.team_lead?.name,
          });
          if (leadKey) roster.add(leadKey);
          for (const m of s1?.team_members ?? []) {
            const k = servingMemberKey({
              email: m?.email,
              id: m?.cnic || m?.name,
            });
            if (k) roster.add(k);
          }
          projectMemberHint.set(
            projectId,
            Math.max(projectMemberHint.get(projectId) ?? 0, reportMembers),
          );
        } else {
          peopleServingWithoutProject += reportMembers;
        }
      }

      const reportSdgs = sdgsFromVerifiedReport({
        primary_sdg_goal: report.primary_sdg_goal,
        section3: report.section3,
        opportunity: report.opportunity
          ? {
              sdg: report.opportunity.sdg,
              sdg_info: report.opportunity.sdg_info,
            }
          : null,
      });
      for (const g of reportSdgs) sdgSet.add(g);

      // Opportunities with no named partner get an auto-created placeholder Organization row
      // (createPlaceholderOrganizationForStudentOpportunity, opportunities.service.ts) purely so
      // the record has an org to join against — its name ("Student opportunity — <title> —
      // <id8>") is an internal bookkeeping string, never a real partner, and must never be shown
      // as one on the public ledger/feed/city partner list.
      const org = report.opportunity?.organization;
      const partnerName =
        org && !isPlaceholderPartnerOrg(org) ? org.name : null;
      if (partnerName) {
        partnerKeys.add(normalizePartnerKey(partnerName));
        if (org?.id && projectId) {
          let set = oppsByPartnerOrg.get(org.id);
          if (!set) {
            set = new Set();
            oppsByPartnerOrg.set(org.id, set);
          }
          set.add(projectId);
        }
      }
      for (const name of partnerNamesFromSection7(report.section7)) {
        partnerKeys.add(normalizePartnerKey(name));
      }

      const cityKey = normalizeCityKey(report.student?.city);
      if (cityKey) {
        let acc = cityAcc.get(cityKey);
        if (!acc) {
          acc = {
            peopleServing: 0,
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
        if (firstForPair) {
          acc.verifiedHours += pairHours;
          acc.peopleServed += beneficiaries;
          acc.resourcesDeployedPkr += pkr.deployed;
          acc.outOfPocketPkr += pkr.outOfPocket;
          if (!projectId) acc.peopleServing += reportMembers;
        }
        acc.verifiedReports += 1;
        for (const g of reportSdgs) acc.sdgs.add(g);
        if (partnerName) acc.partners.add(partnerName);
        if (firstForPair && projectId && !projectCity.has(projectId)) {
          projectCity.set(projectId, cityKey);
        }
      }

      const geo = cityKey ? PAKISTAN_CITY_GEO[cityKey] : null;
      const verifiedAt =
        report.adminApprovedAt ?? report.partnerApprovedAt ?? report.updatedAt;
      const verifiedAtIso = (
        verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt)
      ).toISOString();
      activityCandidates.push({
        city: geo?.name ?? null,
        hours: Math.round(pairHours),
        beneficiaries,
        partnerName,
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
        const sdgProjectKey = `${g}:${projectId || pairKey}`;
        if (creditPairOnce(sdgProjectKey, creditedSdgProjects)) {
          sAcc.projects += 1;
          sAcc.items.push({
            title: report.opportunity?.title || 'Community Service record',
            city: geo?.name ?? null,
            path: 'Community Service',
            verifiedAt: verifiedAtIso,
          });
        }
        if (firstForPair) sAcc.peopleServed += beneficiaries;
        if (creditPairOnce(`${g}:${pairKey}`, creditedSdgHourKeys)) {
          sAcc.attributedHours += pairHours;
        }
        if (cityKey) sAcc.cities.add(cityKey);
      }
    }

    for (const pid of creditedProjects) {
      const n = Math.max(
        rosterByProject.get(pid)?.size ?? 0,
        projectMemberHint.get(pid) ?? 0,
        1,
      );
      const cityKey = projectCity.get(pid);
      if (!cityKey) continue;
      const acc = cityAcc.get(cityKey);
      if (!acc) continue;
      acc.peopleServing += n;
    }

    const peopleServing =
      peopleServingWithoutProject +
      sumPeopleServing(
        [...creditedProjects].map((pid) =>
          Math.max(
            rosterByProject.get(pid)?.size ?? 0,
            projectMemberHint.get(pid) ?? 0,
          ),
        ),
      );
    const peopleReached = peopleReachedLoose;
    const resourcesDeployedPkr = resourcesDeployedLoose;
    const outOfPocketPkr = outOfPocketLoose;

    // sessionHours is a decimal column, so raw sums carry fractional cents' worth of hours. Round
    // hours and out-of-pocket PKR ONCE and derive the dividend from those same rounded figures —
    // otherwise the displayed "<hours> hrs × PKR <rate> + PKR <out-of-pocket>" caption never
    // quite multiplies out to the headline dividend number shown next to it.
    const cities: CityImpactStat[] = [...cityAcc.entries()]
      .map(([key, acc]) => {
        const geo = PAKISTAN_CITY_GEO[key];
        const roundedHours = Math.round(acc.verifiedHours);
        const roundedOutOfPocketPkr = Math.round(acc.outOfPocketPkr);
        return {
          id: key,
          name: geo.name,
          province: geo.province,
          lat: geo.lat,
          lon: geo.lon,
          peopleServing: acc.peopleServing,
          peopleServed: acc.peopleServed,
          verifiedHours: roundedHours,
          resourcesDeployedPkr: Math.round(acc.resourcesDeployedPkr),
          outOfPocketPkr: roundedOutOfPocketPkr,
          communityDividendPkr: communityDividendPkr(
            roundedHours,
            roundedOutOfPocketPkr,
          ),
          verifiedReports: acc.verifiedReports,
          sdgs: [...acc.sdgs].sort((a, b) => a - b),
          partners: [...acc.partners].sort(),
        };
      })
      .sort((a, b) => b.peopleServing - a.peopleServing);

    const roundedVerifiedHours = Math.round(verifiedHours);
    const roundedOutOfPocketPkr = Math.round(outOfPocketPkr);
    const returningPartners = [...oppsByPartnerOrg.values()].filter(
      (s) => s.size >= 2,
    ).length;
    const partnersComeBackPct = oppsByPartnerOrg.size
      ? Math.round((returningPartners / oppsByPartnerOrg.size) * 100)
      : 0;

    return {
      peopleServing,
      peopleReached,
      verifiedHours: roundedVerifiedHours,
      resourcesDeployedPkr: Math.round(resourcesDeployedPkr),
      outOfPocketPkr: roundedOutOfPocketPkr,
      communityDividendPkr: communityDividendPkr(
        roundedVerifiedHours,
        roundedOutOfPocketPkr,
      ),
      sdgsTouched: sdgSet.size,
      partnerOrganisations: partnerKeys.size,
      partnersComeBackPct,
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

  /** Unique community-service opportunities with at least one verified/paid report. */
  private async countVerifiedCommunityServiceProjects(): Promise<number> {
    const rows = await this.studentReportsRepository.find({
      where: VERIFIED_RECORD_STATUSES.map((status) => ({ status })),
      select: ['id', 'opportunityId', 'project_id'],
    });
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.opportunityId || r.project_id || r.id);
    }
    return ids.size;
  }

  /** "Verified projects" spans all four paths — unlike computeCommunityLedger, this only needs a
   * count per entity's own established "verified" definition (see each path's own service). */
  private async countVerifiedProjectsAllPaths(): Promise<number> {
    const [communityServiceProjects, courseProjects, fyps, ventures] =
      await Promise.all([
        this.countVerifiedCommunityServiceProjects(),
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
    return communityServiceProjects + courseProjects + fyps + verifiedVentures;
  }
}

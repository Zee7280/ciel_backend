import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Report } from '../reports/entities/report.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';
import { isTeamApplyFromParticipationAndMembers } from '../opportunities/apply-team-payload.util';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { StudentsService } from '../students/students.service';

import {
  AuditLogFilters,
  AuditLogsService,
} from '../audit-logs/audit-logs.service';
import { UserRole } from '../users/enums/user-role.enum';
import {
  In,
  IsNull,
  LessThan,
  Not,
  SelectQueryBuilder,
  Brackets,
  ILike,
  MoreThanOrEqual,
} from 'typeorm';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { OrganizationMembershipFee } from '../organization-membership/entities/organization-membership-fee.entity';
import { SupportTicket } from '../support/entities/support-ticket.entity';
import { IssueLog } from '../issue-logs/entities/issue-log.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { LINE_STATUS } from '../opportunities/opportunity-workflow.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { reportStatusRank } from '../analytics/shared/report-status.util';
import {
  getSettingSpec,
  settingColumnType,
  SETTINGS_REGISTRY_KEYS,
  validateSettingValue,
} from './settings-registry';

import { Setting } from '../settings/entities/setting.entity';
import { MasterAnalyticsQueryDto } from './dto/master-analytics-query.dto';
import { ReportPartnerApprovalSettingsService } from '../reports/report-partner-approval-settings.service';
import {
  isReportPartnerStepSatisfied,
  REPORT_PARTNER_APPROVAL_SETTING_KEY,
} from '../reports/report-partner-approval.util';
import { OrganizationMembershipService } from '../organization-membership/organization-membership.service';
import { PartnerMembershipSettingsService } from '../organization-membership/partner-membership-settings.service';
import { PARTNER_MEMBERSHIP_REQUIRED_KEY } from '../organization-membership/partner-membership.util';
import { StudentApplyMaintenanceService } from '../opportunities/student-apply-maintenance.service';
import { isStudentApplyMaintenanceSettingKey } from '../opportunities/student-apply-maintenance.util';
import {
  isTeamConfigurationComplete,
  resolveAttendanceUnlockStatus,
  resolveParticipationForAttendanceUnlock,
} from '../engagement/attendance-unlock.util';
import { FeedbackService } from '../feedback/feedback.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Canonical Pakistan regions for stakeholder "participation by region" (sync spellings with ciel_frontend/src/utils/pakistanRegions.ts). */
const STAKEHOLDER_REGION_CANONICAL = [
  'Abbottabad',
  'Attock',
  'Azad Jammu and Kashmir',
  'Bahawalnagar',
  'Bahawalpur',
  'Balochistan',
  'Charsadda',
  'Chiniot',
  'Dera Ghazi Khan',
  'Dera Ismail Khan',
  'Faisalabad',
  'Gilgit',
  'Gilgit-Baltistan',
  'Gujranwala',
  'Gujrat',
  'Haripur',
  'Hyderabad',
  'Islamabad',
  'Islamabad Capital Territory',
  'Jhang',
  'Kamoke',
  'Karachi',
  'Kasur',
  'Khyber Pakhtunkhwa',
  'Kohat',
  'Lahore',
  'Larkana',
  'Mandi Bahauddin',
  'Mansehra',
  'Mardan',
  'Mingora',
  'Mirpur Khas',
  'Multan',
  'Murree',
  'Nawabshah',
  'Okara',
  'Peshawar',
  'Punjab',
  'Quetta',
  'Rahim Yar Khan',
  'Rawalpindi',
  'Sahiwal',
  'Sargodha',
  'Sheikhupura',
  'Sialkot',
  'Skardu',
  'Sindh',
  'Sukkur',
  'Swabi',
  'Taxila',
  'Wah Cantonment',
] as const;

const STAKEHOLDER_REGION_TYPO_TOKEN_FIX: Record<string, string> = {
  lahors: 'lahore',
  lhr: 'lahore',
};

const STAKEHOLDER_REGION_PHRASE_ALIASES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly canonical: string;
}> = [
  { pattern: /^lhr$/i, canonical: 'Lahore' },
  { pattern: /^pakistan$/i, canonical: 'Lahore' },
  { pattern: /\bkpk\b/i, canonical: 'Khyber Pakhtunkhwa' },
  { pattern: /\bfata\b/i, canonical: 'Khyber Pakhtunkhwa' },
  { pattern: /\bajk\b/i, canonical: 'Azad Jammu and Kashmir' },
  { pattern: /\bagk\b/i, canonical: 'Azad Jammu and Kashmir' },
  { pattern: /\bigb\b/i, canonical: 'Gilgit-Baltistan' },
  { pattern: /\bgb\b/i, canonical: 'Gilgit-Baltistan' },
  { pattern: /\bict\b/i, canonical: 'Islamabad Capital Territory' },
];

function escapeStakeholderRegionTokenForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleCaseStakeholderRegionWords(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '',
    )
    .join(' ')
    .trim();
}

function normalizeStakeholderRegionRawInput(raw: string): string {
  return (raw ?? '')
    .replace(/[\uFEFF\u200B-\u200D]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function normalizeStakeholderRegionLabel(raw: string): string {
  let s = normalizeStakeholderRegionRawInput(raw);
  if (!s) return 'Unspecified';

  s = s
    .replace(/,\s*pakistan\s*$/i, '')
    .replace(/,\s*pk\s*$/i, '')
    .trim();
  if (!s) return 'Unspecified';

  for (const { pattern, canonical } of STAKEHOLDER_REGION_PHRASE_ALIASES) {
    if (pattern.test(s)) return canonical;
  }

  const loweredFull = s.toLowerCase().replace(/\s+/g, ' ');

  const byLen = [...STAKEHOLDER_REGION_CANONICAL].sort(
    (a, b) => b.length - a.length,
  );
  for (const canon of byLen) {
    const c = canon.toLowerCase();
    const re = new RegExp(
      `(^|[^a-z0-9])${escapeStakeholderRegionTokenForRegExp(c)}([^a-z0-9]|$)`,
      'i',
    );
    if (re.test(loweredFull)) return canon;
  }

  const tokens = loweredFull
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const canonLcToDisplay = new Map(
    STAKEHOLDER_REGION_CANONICAL.map((c) => [c.toLowerCase(), c]),
  );
  for (const tok of tokens) {
    const fixed = STAKEHOLDER_REGION_TYPO_TOKEN_FIX[tok] || tok;
    const hit = canonLcToDisplay.get(fixed);
    if (hit) return hit;
  }

  const first = s.split(',')[0]?.trim() ?? '';
  const titled = titleCaseStakeholderRegionWords(first);
  return titled || 'Unspecified';
}

/** Non-rejected participation rows for CIEL-wide aggregates (matches university analytics scope). */
const MASTER_ANALYTICS_PARTICIPATION_STATUSES = [
  'pending',
  'pending_payment_approval',
  'paid',
  'pending_ciel_approval',
  'pending_faculty_approval',
  'approved',
  'verified',
  'accepted',
  'finalized',
];

/** Same statuses as OpportunitiesService.getOccupiedSeats (seats counted toward enrollment). */
const OCCUPIED_SEAT_STATUSES = [
  'pending',
  'accepted',
  'approved',
  'verified',
  'paid',
  'pending_payment_approval',
  'pending_ciel_approval',
  'pending_faculty_approval',
];

/** Participations that count as an active volunteer (excludes pending / awaiting-approval). */
const ACTIVE_VOLUNTEER_STATUSES = ['accepted', 'approved', 'verified', 'paid'];

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Opportunity)
    private opportunityRepository: Repository<Opportunity>,
    @InjectRepository(Report)
    private reportRepository: Repository<Report>,
    @InjectRepository(Timesheet)
    private timesheetRepository: Repository<Timesheet>,
    private auditLogsService: AuditLogsService,
    @InjectRepository(Setting)
    private settingRepository: Repository<Setting>,
    @InjectRepository(Participation)
    private participationRepository: Repository<Participation>,
    @InjectRepository(StudentReport)
    private studentReportRepository: Repository<StudentReport>,
    private readonly opportunityApplicationsService: OpportunityApplicationsService,
    private readonly studentsService: StudentsService,
    @InjectRepository(OpportunityApplication)
    private opportunityApplicationRepository: Repository<OpportunityApplication>,
    private readonly reportPartnerApprovalSettings: ReportPartnerApprovalSettingsService,
    private readonly organizationMembershipService: OrganizationMembershipService,
    private readonly partnerMembershipSettings: PartnerMembershipSettingsService,
    private readonly feedbackService: FeedbackService,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    @Optional()
    private readonly studentApplyMaintenance?: StudentApplyMaintenanceService,
    @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly platformSettings?: PlatformSettingsService,
  ) {}

  private readonly logger = new Logger(AdminService.name);

  /** Repository for entities that aren't constructor-injected (keeps the constructor stable). */
  private repoOf<T extends object>(
    entity: new () => T,
  ): Repository<T> | undefined {
    try {
      return this.dataSource?.getRepository(entity);
    } catch {
      return undefined;
    }
  }

  /** Read-only (no seeding side effects). Only allowlisted registry keys are returned. */
  async getSettings() {
    const rows = await this.settingRepository.find();
    const allowed = new Set(SETTINGS_REGISTRY_KEYS);
    const settings = rows
      .filter((r) => allowed.has(r.key))
      .map((r) => ({
        id: r.id,
        key: r.key,
        value: r.value,
        description: r.description ?? getSettingSpec(r.key)?.description ?? null,
        type: r.type,
        updatedAt: r.updatedAt,
      }));
    return {
      success: true,
      data: settings,
    };
  }

  async updateSetting(
    key: string,
    rawValue: unknown,
    actor?: { id?: string; email?: string },
  ) {
    const { spec, value } = validateSettingValue(key, rawValue);
    let setting = await this.settingRepository.findOne({ where: { key } });
    const oldValue = setting?.value ?? null;
    if (setting) {
      setting.value = value;
      if (!setting.description) setting.description = spec.description;
    } else {
      setting = this.settingRepository.create({
        key,
        value,
        type: settingColumnType(spec.kind),
        description: spec.description,
      });
    }
    await this.settingRepository.save(setting);
    this.platformSettings?.invalidate(key);
    if (key === REPORT_PARTNER_APPROVAL_SETTING_KEY) {
      this.reportPartnerApprovalSettings.invalidateCache();
      await this.reportPartnerApprovalSettings.refreshCache();
    }
    if (key === PARTNER_MEMBERSHIP_REQUIRED_KEY) {
      this.partnerMembershipSettings.invalidateCache();
      const enabled = await this.partnerMembershipSettings.refreshCache();
      if (!enabled) {
        await this.organizationMembershipService.releasePendingPartnerMembershipAccounts();
      }
    }
    if (isStudentApplyMaintenanceSettingKey(key)) {
      this.studentApplyMaintenance?.invalidateCache();
      await this.studentApplyMaintenance?.refreshCache();
    }
    await this.auditLogsService.recordMutation?.({
      action: 'SETTING_UPDATE',
      user: actor?.email ?? actor?.id ?? null,
      user_email: actor?.email ?? null,
      target: key,
      target_type: 'setting',
      details: { adminId: actor?.id ?? null, key, old: oldValue, new: value },
    });
    return {
      success: true,
      data: setting,
    };
  }

  /** Same predicate as OpportunitiesService.adminPendingQueueWhere (admin approvals "pending" queue). */
  private opportunityPendingApprovalWhere(): Brackets {
    return new Brackets((qb) => {
      qb.where(
        new Brackets((inner) => {
          inner
            .where('opportunity.status = :st', { st: 'pending_approval' })
            .andWhere(
              '(opportunity.admin_approved = :aa OR opportunity.admin_approved IS NULL)',
              { aa: false },
            );
        }),
      )
        .orWhere(
          new Brackets((inner) => {
            inner
              .where('opportunity.isStudentCreated = :isc', { isc: true })
              .andWhere(
                '(opportunity.admin_approved = :aa OR opportunity.admin_approved IS NULL)',
                { aa: false },
              )
              .andWhere('opportunity.status IN (:...early)', {
                early: [
                  'pending_faculty',
                  'pending_partner',
                  'pending_verification',
                ],
              });
          }),
        )
        .orWhere(
          new Brackets((inner) => {
            inner
              .where('opportunity.isStudentCreated = :isc2', { isc2: false })
              .andWhere(
                '(opportunity.admin_approved = :aa2 OR opportunity.admin_approved IS NULL)',
                { aa2: false },
              )
              .andWhere(
                '(opportunity.adminApprovalStatus IS NULL OR opportunity.adminApprovalStatus NOT IN (:...cielSelfApproved))',
                {
                  cielSelfApproved: [
                    LINE_STATUS.APPROVED,
                    LINE_STATUS.NOT_REQUIRED,
                  ],
                },
              )
              .andWhere('opportunity.status IN (:...partnerOrg)', {
                partnerOrg: ['pending_execution', 'pending_partner'],
              });
          }),
        );
    });
  }

  private countOpportunityApprovalQueue(): Promise<number> {
    return this.opportunityRepository
      .createQueryBuilder('opportunity')
      .where(this.opportunityPendingApprovalWhere())
      .getCount();
  }

  /** Student reports that are past draft (submitted and later). */
  private static readonly STUDENT_REPORT_NOT_SUBMITTED = ['draft', 'continue'];

  /** One COUNT per badge; a failing count degrades to 0 rather than failing the whole sidebar. */
  async getPendingCounts() {
    const safe = async (label: string, fn: () => Promise<number>) => {
      try {
        return Number(await fn()) || 0;
      } catch (err) {
        this.logger.warn(
          `pending-counts ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 0;
      }
    };
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      opportunityApprovals,
      pendingUsers,
      pendingParticipations,
      joinApplications,
      payments,
      orgMembership,
      reportsAwaitingAdmin,
      issueLogsOpen,
      supportOpen,
    ] = await Promise.all([
      safe('opportunityApprovals', () => this.countOpportunityApprovalQueue()),
      safe('users', () =>
        this.usersRepository.count({ where: { status: 'pending' } }),
      ),
      safe('participations', () =>
        this.participationRepository.count({
          where: { status: In(['pending', 'pending_ciel_approval']) },
        }),
      ),
      safe('joinApplications', () =>
        this.opportunityApplicationsService.countPendingAdmin(),
      ),
      safe('payments', async () =>
        (await this.repoOf(Payment)?.count({
          where: { status: PaymentStatus.PENDING },
        })) ?? 0,
      ),
      safe('orgMembership', async () =>
        (await this.repoOf(OrganizationMembershipFee)?.count({
          where: { status: 'pending_review' },
        })) ?? 0,
      ),
      safe('reportsAwaitingAdmin', () =>
        this.studentReportRepository.count({
          where: {
            admin_status: 'pending',
            status: In(['submitted', 'under_review', 'partner_verified']),
          },
        }),
      ),
      // "open" = unresolved error-severity entries from the last 7 days (admins resolve them in Issue Logs).
      safe('issueLogsOpen', async () =>
        (await this.repoOf(IssueLog)?.count({
          where: {
            severity: 'error',
            resolvedAt: IsNull(),
            createdAt: MoreThanOrEqual(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
          },
        })) ?? 0,
      ),
      safe('supportOpen', async () =>
        (await this.repoOf(SupportTicket)?.count({
          where: { status: 'open' },
        })) ?? 0,
      ),
    ]);
    return {
      opportunityApprovals,
      userApprovals: pendingUsers + pendingParticipations,
      joinApplications,
      payments,
      orgMembership,
      reportsAwaitingAdmin,
      issueLogsOpen,
      supportOpen,
    };
  }

  /**
   * Verified volunteer hours — the single source for the dashboard, impact analytics and project
   * lists. Approved attendance logs (the live system) plus verified timesheets, where a
   * student+project pair that has approved attendance ignores its timesheets (no double counting).
   * Aggregated in SQL (SUM/GROUP BY); months are bucketed in Asia/Karachi (fixed UTC+5).
   */
  private async computeVerifiedHours(
    opts: { opportunityIds?: string[] } = {},
  ): Promise<{
    total: number;
    byOpportunity: Map<string, number>;
    rows: Array<{
      studentId: string | null;
      opportunityId: string | null;
      period: string;
      hours: number;
    }>;
  }> {
    const ids = opts.opportunityIds;
    type Raw = {
      studentId: string | null;
      opportunityId: string | null;
      period: string;
      hours: string | number;
    };
    let attendance: Raw[] = [];
    const attendanceRepo = this.repoOf(AttendanceLog);
    if (attendanceRepo && (!ids || ids.length)) {
      const qb = attendanceRepo
        .createQueryBuilder('a')
        .innerJoin('a.participant', 'p')
        .select('p.studentId', 'studentId')
        .addSelect('a.projectId', 'opportunityId')
        .addSelect("to_char(a.dateOfEngagement, 'YYYY-MM')", 'period')
        .addSelect('COALESCE(SUM(a.sessionHours), 0)', 'hours')
        .where('a.approvalStatus = :approved', { approved: 'approved' });
      if (ids) qb.andWhere('a.projectId IN (:...ids)', { ids });
      attendance = await qb
        .groupBy('p.studentId')
        .addGroupBy('a.projectId')
        .addGroupBy("to_char(a.dateOfEngagement, 'YYYY-MM')")
        .getRawMany<Raw>();
    }

    let timesheets: Raw[] = [];
    if (!ids || ids.length) {
      const tqb = this.timesheetRepository
        .createQueryBuilder('t')
        .select('t.studentId', 'studentId')
        .addSelect('t.opportunityId', 'opportunityId')
        .addSelect("to_char(t.createdAt + interval '5 hours', 'YYYY-MM')", 'period')
        .addSelect('COALESCE(SUM(t.hours), 0)', 'hours')
        .where('t.status = :verified', { verified: 'verified' });
      if (ids) tqb.andWhere('t.opportunityId IN (:...ids)', { ids });
      timesheets = await tqb
        .groupBy('t.studentId')
        .addGroupBy('t.opportunityId')
        .addGroupBy("to_char(t.createdAt + interval '5 hours', 'YYYY-MM')")
        .getRawMany<Raw>();
    }

    const rows: Array<{
      studentId: string | null;
      opportunityId: string | null;
      period: string;
      hours: number;
    }> = [];
    const coveredByAttendance = new Set<string>();
    for (const r of attendance) {
      const hours = Number(r.hours) || 0;
      if (hours <= 0) continue;
      if (r.studentId && r.opportunityId) {
        coveredByAttendance.add(`${r.studentId}:${r.opportunityId}`);
      }
      rows.push({
        studentId: r.studentId ?? null,
        opportunityId: r.opportunityId ?? null,
        period: r.period,
        hours,
      });
    }
    for (const r of timesheets) {
      const hours = Number(r.hours) || 0;
      if (hours <= 0) continue;
      if (
        r.studentId &&
        r.opportunityId &&
        coveredByAttendance.has(`${r.studentId}:${r.opportunityId}`)
      ) {
        continue;
      }
      rows.push({
        studentId: r.studentId ?? null,
        opportunityId: r.opportunityId ?? null,
        period: r.period,
        hours,
      });
    }

    const byOpportunity = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      total += r.hours;
      if (r.opportunityId) {
        byOpportunity.set(
          r.opportunityId,
          (byOpportunity.get(r.opportunityId) ?? 0) + r.hours,
        );
      }
    }
    return { total: Math.round(total * 100) / 100, byOpportunity, rows };
  }

  async getDashboardStats() {
    // User Breakdown
    const totalStudents = await this.usersRepository.count({
      where: { role: UserRole.STUDENT },
    });
    const orgRoles = In([UserRole.ORGANIZATION_ADMIN, 'org']);
    const totalNgos = await this.usersRepository.count({
      where: [
        { role: UserRole.NGO },
        { role: orgRoles, orgType: ILike('%ngo%') },
      ],
    });
    const totalCorporates = await this.usersRepository.count({
      where: [
        { role: UserRole.CORPORATE },
        { role: orgRoles, orgType: ILike('%corporate%') },
      ],
    });
    // Every account on the platform, not just students + a hand-picked subset of org roles
    // (that list previously omitted University and Faculty accounts entirely).
    const totalUsers = await this.usersRepository.count();

    const totalOpportunities = await this.opportunityRepository.count();
    // Two different things used to share the "reports" label: keep both explicit.
    const issueReports = await this.reportRepository.count();
    const studentReports = await this.studentReportRepository.count({
      where: {
        status: Not(In(AdminService.STUDENT_REPORT_NOT_SUBMITTED)),
      },
    });

    // Pending Approvals (Opportunity queue + Users + Applications) — distinct tables, so no overlap.
    const pendingOpportunities = await this.countOpportunityApprovalQueue();
    const pendingUsers = await this.usersRepository.count({
      where: { status: 'pending' },
    });
    const pendingApplications = await this.participationRepository.count({
      where: { status: In(['pending', 'pending_ciel_approval']) },
    });
    const pendingOppApplications =
      await this.opportunityApplicationsService.countPendingAdmin();
    const pendingApprovals =
      pendingOpportunities +
      pendingUsers +
      pendingApplications +
      pendingOppApplications;

    const verifiedHours = (await this.computeVerifiedHours()).total;

    // SDG Distribution
    const opportunities = await this.opportunityRepository.find();
    const sdgMap = opportunities.reduce((acc, opp) => {
      const sdg = opp.sdg || 'Unknown';
      acc[sdg] = (acc[sdg] || 0) + 1;
      return acc;
    }, {});

    const sdgDistribution = Object.entries(sdgMap).map(([name, value]) => ({
      name,
      value,
      color: this.getSDGColor(name),
    }));

    return {
      success: true,
      data: {
        metrics: {
          totalUsers: {
            total: totalUsers,
            students: totalStudents,
            ngos: totalNgos,
            corporates: totalCorporates,
          },
          opportunities: totalOpportunities,
          verifiedHours: verifiedHours,
          pendingApprovals: pendingApprovals,
          // Legacy name kept: this is the generic issue/moderation Report table.
          totalReports: issueReports,
          issueReports,
          studentReports,
        },
        pendingSummary: {
          total: pendingApprovals,
          items: [
            {
              key: 'admin_pending_opportunities',
              title: 'Opportunity approvals',
              count: pendingOpportunities,
              href: '/dashboard/admin/approvals',
              tone: 'urgent',
              description: 'Opportunities waiting for admin approval.',
            },
            {
              key: 'admin_pending_users',
              title: 'User approvals',
              count: pendingUsers,
              href: '/dashboard/admin/approvals',
              tone: 'urgent',
              description: 'Registrations waiting for admin approval.',
            },
            {
              key: 'admin_participation_requests',
              title: 'Participation requests',
              count: pendingApplications,
              href: '/dashboard/admin/approvals',
              tone: 'warning',
              description:
                'Student participation records waiting for CIEL review.',
            },
            {
              key: 'admin_opportunity_applications',
              title: 'Opportunity applications',
              count: pendingOppApplications,
              href: '/dashboard/admin/join-applications',
              tone: 'warning',
              description: 'Join applications in the admin approval queue.',
            },
          ],
        },
        sdgDistribution: sdgDistribution,
        recentActivity: [], // Optional
      },
    };
  }

  /**
   * CIEL Master dashboard: platform-wide student headcount, verification, universities, participation mix, required hours, growth.
   * Does not alter {@link getDashboardStats} payload.
   *
   * Optional query filters narrow metrics to participations matching every supplied dimension (AND).
   * Without filters, behavior matches the original platform-wide aggregates.
   */
  async getMasterAnalytics(query?: MasterAnalyticsQueryDto) {
    const filtersActive = Boolean(
      query && this.masterAnalyticsFiltersActive(query),
    );

    const participations = await this.loadMasterAnalyticsParticipations(
      filtersActive ? query : undefined,
    );

    const typeCounts = new Map<string, number>();
    let total_required_hours = 0;
    for (const p of participations) {
      const mode = (p.participationMode || 'individual').toLowerCase();
      typeCounts.set(mode, (typeCounts.get(mode) || 0) + 1);
      total_required_hours +=
        this.resolveRequiredHoursPerStudentFromOpportunity(p.project);
    }

    const participation_type_mix = [...typeCounts.entries()]
      .map(([participation_type, count]) => ({ participation_type, count }))
      .sort((a, b) => b.count - a.count);

    if (!filtersActive) {
      const now = new Date();
      const startOfThisMonthUtc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const total_participants = await this.usersRepository.count({
        where: { role: UserRole.STUDENT },
      });

      const verified_students = await this.usersRepository.count({
        where: {
          role: UserRole.STUDENT,
          profile_verified: true,
          identity_verified: true,
        },
      });

      const verification_rate_percent =
        total_participants === 0
          ? 0
          : Math.round((100 * verified_students) / total_participants);

      const uniFromUsers = await this.usersRepository
        .createQueryBuilder('u')
        .select('DISTINCT TRIM(u.university)', 'name')
        .where('u.role = :role', { role: UserRole.STUDENT })
        .andWhere("TRIM(COALESCE(u.university, '')) <> ''")
        .getRawMany();

      const uniFromPart = await this.participationRepository
        .createQueryBuilder('p')
        .select('DISTINCT TRIM(p.universityName)', 'name')
        .where('p.student_id IS NOT NULL')
        .andWhere("TRIM(COALESCE(p.universityName, '')) <> ''")
        .getRawMany();

      const universityNames = new Set<string>();
      for (const row of [...uniFromUsers, ...uniFromPart]) {
        // Lowercase so "NUST" / "Nust" / "nust" collapse to one university, not three.
        const n = String((row as { name?: string }).name || '').trim().toLowerCase();
        if (n) universityNames.add(n);
      }
      const total_universities = universityNames.size;

      const previous_headcount = await this.usersRepository.count({
        where: {
          role: UserRole.STUDENT,
          createdAt: LessThan(startOfThisMonthUtc),
        },
      });

      const system_growth_rate_percent =
        previous_headcount === 0
          ? null
          : Math.round(
              ((total_participants - previous_headcount) / previous_headcount) *
                1000,
            ) / 10;

      return {
        success: true,
        data: {
          total_participants,
          verified_students,
          verification_rate_percent,
          total_universities,
          participation_type_mix,
          total_required_hours: Math.round(total_required_hours * 10) / 10,
          system_growth_rate_percent,
          growth_meta: {
            basis: 'student_accounts',
            formula: '(current_total - previous_total) / previous_total * 100',
            previous_total: previous_headcount,
            current_total: total_participants,
            previous_label: 'students_created_before_this_utc_month',
          },
          filter_meta: { active: false as const },
        },
      };
    }

    const cohortStudentIds = [
      ...new Set(
        participations
          .map((p) => p.studentId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const total_participants = cohortStudentIds.length;

    const verified_students =
      await this.countVerifiedStudentsInCohort(cohortStudentIds);

    const verification_rate_percent =
      total_participants === 0
        ? 0
        : Math.round((100 * verified_students) / total_participants);

    const universityNamesFiltered = new Set<string>();
    for (const p of participations) {
      const n = (p.universityName || '').trim().toLowerCase();
      if (n) universityNamesFiltered.add(n);
    }
    const total_universities = universityNamesFiltered.size;

    return {
      success: true,
      data: {
        total_participants,
        verified_students,
        verification_rate_percent,
        total_universities,
        participation_type_mix,
        total_required_hours: Math.round(total_required_hours * 10) / 10,
        system_growth_rate_percent: null,
        growth_meta: {
          basis: 'filtered_participation_cohort',
          formula: null,
          previous_total: null,
          current_total: total_participants,
          previous_label: null,
          note: 'Platform MoM growth is only computed without filters. Distinct students are counted from matching participation rows.',
        },
        filter_meta: {
          active: true as const,
          params: this.compactMasterAnalyticsFilterParams(query!),
        },
      },
    };
  }

  /** CIEL's real users are in Pakistan (UTC+5) — semester/cohort date filters must use PKT day
   * boundaries, not UTC, or the first/last ~5 hours of the intended range are silently excluded. */
  private static readonly PKT_UTC_OFFSET_HOURS = 5;

  private masterPktStartOfDay(iso: string): Date {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return d;
    return new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        -AdminService.PKT_UTC_OFFSET_HOURS,
        0,
        0,
        0,
      ),
    );
  }

  private masterUtcEndOfDay(iso: string): Date {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return d;
    return new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        23 - AdminService.PKT_UTC_OFFSET_HOURS,
        59,
        59,
        999,
      ),
    );
  }

  /** Verified students in cohort; chunked {@link In} avoids PostgreSQL bind-parameter limits for large filtered cohorts. */
  private async countVerifiedStudentsInCohort(
    cohortStudentIds: string[],
  ): Promise<number> {
    if (cohortStudentIds.length === 0) return 0;
    const chunkSize = 8000;
    let total = 0;
    for (let i = 0; i < cohortStudentIds.length; i += chunkSize) {
      const chunk = cohortStudentIds.slice(i, i + chunkSize);
      total += await this.usersRepository.count({
        where: {
          id: In(chunk),
          role: UserRole.STUDENT,
          profile_verified: true,
          identity_verified: true,
        },
      });
    }
    return total;
  }

  private masterAnalyticsFiltersActive(
    query: MasterAnalyticsQueryDto,
  ): boolean {
    return Object.entries(query).some(
      ([, v]) => v !== undefined && v !== null && String(v).trim() !== '',
    );
  }

  private compactMasterAnalyticsFilterParams(
    query: MasterAnalyticsQueryDto,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const keys = [
      'university',
      'degree_program',
      'year_of_study',
      'academic_integration_type',
      'participation_type',
      'project_id',
      'faculty_email',
      'partner_organization_id',
      'verification_status',
      'period_start',
      'period_end',
    ] as const;
    for (const k of keys) {
      const raw = query[k];
      if (raw === undefined || raw === null) continue;
      const s = String(raw).trim();
      if (s !== '') out[k] = s;
    }
    return out;
  }

  private applyMasterAnalyticsQueryFilters(
    qb: SelectQueryBuilder<Participation>,
    query: MasterAnalyticsQueryDto,
  ): void {
    if (query.university?.trim()) {
      qb.andWhere("LOWER(TRIM(COALESCE(p.universityName, ''))) = :uni", {
        uni: query.university.trim().toLowerCase(),
      });
    }
    if (query.degree_program?.trim()) {
      qb.andWhere("TRIM(COALESCE(p.academicProgram, '')) = :deg", {
        deg: query.degree_program.trim(),
      });
    }
    if (query.year_of_study?.trim()) {
      qb.andWhere('p.yearOfStudy = :yos', { yos: query.year_of_study.trim() });
    }
    if (query.academic_integration_type?.trim()) {
      qb.andWhere('p.academicIntegrationType = :ait', {
        ait: query.academic_integration_type.trim(),
      });
    }
    if (query.participation_type?.trim()) {
      // Postgres: TRIM/LOWER on native enum columns fails unless cast to text.
      qb.andWhere('LOWER(TRIM(CAST(p.participationMode AS text))) = :pm', {
        pm: query.participation_type.trim().toLowerCase(),
      });
    }
    if (query.project_id) {
      qb.andWhere('p.project_id = :pid', { pid: query.project_id });
    }
    if (query.faculty_email?.trim()) {
      const fe = query.faculty_email.trim().toLowerCase();
      qb.andWhere(
        `(LOWER(TRIM(COALESCE(p.primaryFacultyEmail, ''))) = :fe OR LOWER(TRIM(COALESCE(p.facultySupervisorEmail, ''))) = :fe OR LOWER(TRIM(COALESCE(p.secondaryFacultyEmail, ''))) = :fe)`,
        { fe },
      );
    }
    if (query.partner_organization_id) {
      qb.andWhere('proj.organizationId = :porg', {
        porg: query.partner_organization_id,
      });
    }
    if (query.verification_status === 'verified') {
      qb.andWhere(
        'stu.profile_verified = true AND stu.identity_verified = true',
      );
    } else if (query.verification_status === 'unverified') {
      qb.andWhere(
        '(stu.id IS NULL OR COALESCE(stu.profile_verified, false) = false OR COALESCE(stu.identity_verified, false) = false)',
      );
    }
    if (query.period_start?.trim()) {
      const ps = this.masterPktStartOfDay(query.period_start.trim());
      if (!Number.isNaN(ps.getTime())) {
        qb.andWhere('p.createdAt >= :pstart', { pstart: ps });
      }
    }
    if (query.period_end?.trim()) {
      const pe = this.masterUtcEndOfDay(query.period_end.trim());
      if (!Number.isNaN(pe.getTime())) {
        qb.andWhere('p.createdAt <= :pend', { pend: pe });
      }
    }
  }

  private async loadMasterAnalyticsParticipations(
    query?: MasterAnalyticsQueryDto,
  ): Promise<Participation[]> {
    if (!query || !this.masterAnalyticsFiltersActive(query)) {
      return this.participationRepository.find({
        where: {
          studentId: Not(IsNull()),
          status: In(MASTER_ANALYTICS_PARTICIPATION_STATUSES),
        },
        relations: ['project'],
      });
    }

    const qb = this.participationRepository
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.project', 'proj')
      .leftJoinAndSelect('proj.organization', 'org')
      .leftJoin('p.student', 'stu')
      .where('p.student_id IS NOT NULL')
      .andWhere('p.status IN (:...mastSt)', {
        mastSt: MASTER_ANALYTICS_PARTICIPATION_STATUSES,
      });

    this.applyMasterAnalyticsQueryFilters(qb, query);

    return qb.getMany();
  }

  /**
   * HEC / Government / UN stakeholder slices for the admin impact dashboard.
   * Uses non-rejected participations with a linked student plus platform student counts.
   */
  async getImpactStakeholderAnalytics() {
    const total_students = await this.usersRepository.count({
      where: { role: UserRole.STUDENT },
    });

    const verified_students = await this.usersRepository.count({
      where: {
        role: UserRole.STUDENT,
        profile_verified: true,
        identity_verified: true,
      },
    });

    const verification_rate_percent =
      total_students === 0
        ? 0
        : Math.round((100 * verified_students) / total_students);

    const uniFromUsers = await this.usersRepository
      .createQueryBuilder('u')
      .select('DISTINCT TRIM(u.university)', 'name')
      .where('u.role = :role', { role: UserRole.STUDENT })
      .andWhere("TRIM(COALESCE(u.university, '')) <> ''")
      .getRawMany();

    const uniFromPart = await this.participationRepository
      .createQueryBuilder('p')
      .select('DISTINCT TRIM(p.universityName)', 'name')
      .where('p.student_id IS NOT NULL')
      .andWhere("TRIM(COALESCE(p.universityName, '')) <> ''")
      .getRawMany();

    const universityNames = new Set<string>();
    for (const row of [...uniFromUsers, ...uniFromPart]) {
      // Lowercase so case-variant spellings of the same university aren't counted twice.
      const n = String((row as { name?: string }).name || '').trim().toLowerCase();
      if (n) universityNames.add(n);
    }
    const institution_count = universityNames.size;

    const participations = await this.participationRepository.find({
      where: {
        studentId: Not(IsNull()),
        status: In(MASTER_ANALYTICS_PARTICIPATION_STATUSES),
      },
      relations: ['project', 'student'],
    });

    const degreeMap = new Map<string, number>();
    const integrationMap = new Map<string, number>();
    const regionMap = new Map<string, number>();
    const structureMap = new Map<string, number>();
    let total_required_hours = 0;
    let formal_enrollment_rows = 0;

    for (const p of participations) {
      const deg = (p.academicProgram || '').trim() || 'Unspecified';
      degreeMap.set(deg, (degreeMap.get(deg) || 0) + 1);

      const integRaw = p.academicIntegrationType;
      const integLabel = (integRaw || '').trim() || 'Unspecified';
      integrationMap.set(integLabel, (integrationMap.get(integLabel) || 0) + 1);

      const region = this.resolveParticipationRegionForStakeholder(p);
      regionMap.set(region, (regionMap.get(region) || 0) + 1);

      const mode = (p.participationMode || 'individual').toLowerCase();
      structureMap.set(mode, (structureMap.get(mode) || 0) + 1);

      total_required_hours +=
        this.resolveRequiredHoursPerStudentFromOpportunity(p.project);

      if (
        integRaw === 'Course-Linked' ||
        integRaw === 'Credit-Bearing' ||
        integRaw === 'Research-Integrated'
      ) {
        formal_enrollment_rows += 1;
      }
    }

    const degree_distribution = [...degreeMap.entries()]
      .map(([degree, count]) => ({ degree, count }))
      .sort((a, b) => b.count - a.count);

    const academic_integration_distribution = [...integrationMap.entries()]
      .map(([academic_integration_type, count]) => ({
        academic_integration_type,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    const participation_by_region = [...regionMap.entries()]
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count);

    const participation_structure = [...structureMap.entries()]
      .map(([participation_type, count]) => ({ participation_type, count }))
      .sort((a, b) => b.count - a.count);

    const enrollment_total = participations.length;
    const formal_integration_rate_percent =
      enrollment_total === 0
        ? 0
        : Math.round((100 * formal_enrollment_rows) / enrollment_total);

    const now = new Date();
    const startOfThisMonthUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const previous_headcount = await this.usersRepository.count({
      where: {
        role: UserRole.STUDENT,
        createdAt: LessThan(startOfThisMonthUtc),
      },
    });

    const growth_rate_percent =
      previous_headcount === 0
        ? null
        : Math.round(
            ((total_students - previous_headcount) / previous_headcount) * 1000,
          ) / 10;

    return {
      success: true,
      data: {
        hec: {
          total_participants: total_students,
          verified_students,
          verification_rate_percent,
          institution_count,
          degree_distribution,
          academic_integration_distribution,
          total_required_hours: Math.round(total_required_hours * 10) / 10,
        },
        government: {
          total_engagement: total_students,
          participation_by_region,
          academic_integration_mix: academic_integration_distribution,
          growth_rate_percent,
          growth_meta: {
            previous_total: previous_headcount,
            current_total: total_students,
            previous_label: 'students_created_before_this_utc_month',
          },
        },
        un: {
          total_participants: total_students,
          formal_integration_rate_percent,
          formal_integration_enrollments: formal_enrollment_rows,
          formal_integration_denominator_enrollments: enrollment_total,
          participation_structure,
        },
      },
    };
  }

  private resolveParticipationRegionForStakeholder(p: Participation): string {
    const student = p.student as User | undefined;
    const fromStudent = (student?.city || '').trim();

    const loc = p.project?.location;
    let fromProject = '';
    if (loc && typeof loc === 'object' && loc !== null) {
      const city = String(
        (loc as { city?: string; province?: string }).city || '',
      ).trim();
      if (city) fromProject = city;
      else {
        const province = String(
          (loc as { province?: string }).province || '',
        ).trim();
        if (province) fromProject = province;
      }
    }

    const raw = fromStudent || fromProject;
    return normalizeStakeholderRegionLabel(raw);
  }

  private resolveRequiredHoursPerStudentFromOpportunity(
    project: Opportunity | null | undefined,
  ): number {
    if (!project) return 0;
    const raw = project.timeline?.expected_hours;
    const fromT = Number(raw);
    if (Number.isFinite(fromT) && fromT > 0) return fromT;
    const rh = Number(project.requiredHours);
    return Number.isFinite(rh) ? rh : 0;
  }

  private getSDGColor(sdg: string): string {
    const colors = {
      'No Poverty': '#e5243b',
      'Zero Hunger': '#DDA63A',
      'Good Health and Well-being': '#4C9F38',
      'Quality Education': '#c5192d',
      'Gender Equality': '#FF3A21',
      'Clean Water and Sanitation': '#26BDE2',
      'Affordable and Clean Energy': '#FCC30B',
      'Decent Work and Economic Growth': '#A21942',
      'Industry, Innovation and Infrastructure': '#FD6925',
      'Reduced Inequality': '#DD1367',
      'Sustainable Cities and Communities': '#FD9D24',
      'Responsible Consumption and Production': '#BF8B2E',
      'Climate Action': '#3f7e44',
      'Life Below Water': '#0A97D9',
      'Life on Land': '#56C02B',
      'Peace and Justice Strong Institutions': '#00689D',
      'Partnerships to achieve the Goal': '#19486A',
      'SDG 1': '#e5243b',
      'SDG 4': '#c5192d',
      'SDG 13': '#3f7e44',
    };
    return colors[sdg] || '#000000';
  }

  private toAnalyticsNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'string') {
      return null;
    }
    const match = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (!match) {
      return null;
    }
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private hasMeaningfulAnalyticsObjectValue(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return Object.values(value as Record<string, unknown>).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === 'object')
        return this.hasMeaningfulAnalyticsObjectValue(v);
      return v !== null && v !== undefined && String(v).trim() !== '';
    });
  }

  private reportRequiresPartnerApproval(report: StudentReport): boolean {
    return this.reportPartnerApprovalSettings.reportRequiresPartnerApprovalSync(
      report,
      (value) => this.hasMeaningfulAnalyticsObjectValue(value),
    );
  }

  private isApprovedImpactReport(report: StudentReport): boolean {
    if (
      report.status === 'rejected' ||
      report.partner_status === 'rejected' ||
      report.admin_status === 'rejected'
    ) {
      return false;
    }

    const hasFinalStatus =
      report.status === 'verified' ||
      report.status === 'paid' ||
      (report.admin_status === 'approved' &&
        ['submitted', 'partner_verified'].includes(report.status));
    const partnerApproved =
      !this.reportRequiresPartnerApproval(report) ||
      isReportPartnerStepSatisfied(report.partner_status);

    return (
      hasFinalStatus && partnerApproved && report.admin_status === 'approved'
    );
  }

  private getReportProjectId(report: StudentReport): string | null {
    return report.opportunityId || report.project_id || null;
  }

  private getReportImpactHours(report: StudentReport): number {
    const section1 = report.section1 as
      | {
          metrics?: { total_verified_hours?: unknown };
          attendance_logs?: Array<{ hours?: unknown }>;
          team_lead?: { hours?: unknown };
        }
      | undefined;
    const section4 = report.section4 as { my_hours?: unknown } | undefined;

    const metricHours = this.toAnalyticsNumber(
      section1?.metrics?.total_verified_hours,
    );
    if (metricHours && metricHours > 0) {
      return metricHours;
    }

    const attendanceHours = Array.isArray(section1?.attendance_logs)
      ? section1.attendance_logs.reduce(
          (sum, log) => sum + (this.toAnalyticsNumber(log?.hours) ?? 0),
          0,
        )
      : 0;
    if (attendanceHours > 0) {
      return attendanceHours;
    }

    return (
      this.toAnalyticsNumber(section4?.my_hours) ??
      this.toAnalyticsNumber(section1?.team_lead?.hours) ??
      0
    );
  }

  private getReportBeneficiaries(report: StudentReport): number {
    const section4 = report.section4 as
      | {
          project_summary?: { distinct_total_beneficiaries?: unknown };
          distinct_total_beneficiaries?: unknown;
          total_beneficiaries?: unknown;
          my_beneficiaries?: unknown;
          activity_blocks?: Array<{
            unique_beneficiaries?: unknown;
            beneficiaries_reached?: unknown;
          }>;
        }
      | undefined;

    const stored =
      this.toAnalyticsNumber(
        section4?.project_summary?.distinct_total_beneficiaries,
      ) ??
      this.toAnalyticsNumber(section4?.distinct_total_beneficiaries) ??
      this.toAnalyticsNumber(section4?.total_beneficiaries) ??
      this.toAnalyticsNumber(section4?.my_beneficiaries);
    if (stored) return stored;
    const blocks = Array.isArray(section4?.activity_blocks) ? section4.activity_blocks : [];
    return blocks.reduce((sum, block) => {
      return sum + (this.toAnalyticsNumber(block?.unique_beneficiaries || block?.beneficiaries_reached) ?? 0);
    }, 0);
  }

  private getOpportunityBeneficiaries(opportunity: Opportunity): number {
    return (
      this.toAnalyticsNumber(opportunity.objectives?.beneficiaries_count) ??
      this.toAnalyticsNumber(opportunity.objectives?.total_beneficiaries) ??
      0
    );
  }

  private getSdgName(
    opportunity?: Opportunity | null,
    report?: StudentReport,
  ): string {
    const primarySdg = (
      report?.section3 as
        | { primary_sdg?: { goal_number?: unknown; goal_title?: unknown } }
        | undefined
    )?.primary_sdg;
    const goalNumber = this.toAnalyticsNumber(primarySdg?.goal_number);
    if (goalNumber) {
      return primarySdg?.goal_title
        ? `SDG ${goalNumber}: ${primarySdg.goal_title}`
        : `SDG ${goalNumber}`;
    }
    return (
      opportunity?.sdg ||
      opportunity?.sdg_info?.sdg_id ||
      opportunity?.sdg_info?.goal ||
      'Unknown'
    );
  }

  private normalizeStudentEmailFilter(raw?: string | null): string | null {
    const e = String(raw ?? '')
      .trim()
      .toLowerCase();
    return e.length ? e : null;
  }

  private deriveParticipationStudentRole(p: Participation): string {
    const tid = (p.teamId || '').trim();
    const mode = String(p.participationMode ?? '')
      .trim()
      .toLowerCase();
    if (!tid || mode === 'individual') {
      return 'Individual participant';
    }
    return p.isTeamLead ? 'Team lead' : 'Team member';
  }

  private mergeEnrollmentRoles(a: string, b: string): string {
    const rank = (r: string) =>
      r === 'Team lead' ? 3 : r === 'Team member' ? 2 : 1;
    return rank(a) >= rank(b) ? a : b;
  }

  private deriveApplicationStudentRole(
    app: OpportunityApplication,
    em: string,
  ): string {
    const payload = app.applyPayload || {};
    const teamMembersRaw = Array.isArray(payload['team_members'])
      ? (payload['team_members'] as Array<{ email?: string }>)
      : [];
    const isTeamApply = isTeamApplyFromParticipationAndMembers(
      payload['participation_type'],
      teamMembersRaw,
    );
    const leadNorm = (app.studentUser?.email ?? '').trim().toLowerCase();
    if (leadNorm === em) {
      return isTeamApply ? 'Team lead' : 'Individual participant';
    }
    return 'Team member';
  }

  /** Projects where email matches seated participation row or non-withdrawn application (lead or listed teammate). */
  private async buildStudentEmailProjectMatchMap(
    normalizedEmail: string,
  ): Promise<
    Map<
      string,
      { role: string; match_source: 'enrollment' | 'application_pipeline' }
    >
  > {
    const matchByOppId = new Map<
      string,
      { role: string; match_source: 'enrollment' | 'application_pipeline' }
    >();

    const enrollmentRows = await this.participationRepository
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.student', 'student')
      .where('p.status IN (:...sts)', { sts: OCCUPIED_SEAT_STATUSES })
      .andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(TRIM(p.email)) = :em', {
            em: normalizedEmail,
          }).orWhere('LOWER(TRIM(student.email)) = :em', {
            em: normalizedEmail,
          });
        }),
      )
      .getMany();

    for (const row of enrollmentRows) {
      const role = this.deriveParticipationStudentRole(row);
      const prev = matchByOppId.get(row.projectId);
      if (!prev) {
        matchByOppId.set(row.projectId, { role, match_source: 'enrollment' });
      } else {
        matchByOppId.set(row.projectId, {
          role: this.mergeEnrollmentRoles(prev.role, role),
          match_source: 'enrollment',
        });
      }
    }

    const applicationRows = await this.opportunityApplicationRepository
      .createQueryBuilder('app')
      .leftJoinAndSelect('app.studentUser', 'studentUser')
      .where('app.withdrawnAt IS NULL')
      .andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(TRIM(studentUser.email)) = :em', {
            em: normalizedEmail,
          }).orWhere(
            `EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                COALESCE(app.apply_payload->'team_members', '[]'::jsonb)
              ) tm
              WHERE LOWER(TRIM(COALESCE(tm->>'email', ''))) = :em
            )`,
            { em: normalizedEmail },
          );
        }),
      )
      .getMany();

    for (const app of applicationRows) {
      if (matchByOppId.has(app.opportunityId)) continue;
      matchByOppId.set(app.opportunityId, {
        role: this.deriveApplicationStudentRole(app, normalizedEmail),
        match_source: 'application_pipeline',
      });
    }

    return matchByOppId;
  }

  private groupTeamMembersForParticipation(
    projectEnrollments: Participation[],
    anchor: Participation,
  ): Participation[] {
    if (anchor.participationMode !== 'team') return [anchor];
    if (anchor.teamId) {
      return projectEnrollments.filter((row) => row.teamId === anchor.teamId);
    }
    if (anchor.applicationId) {
      return projectEnrollments.filter(
        (row) => row.applicationId === anchor.applicationId,
      );
    }
    return projectEnrollments.filter((row) => row.participationMode === 'team');
  }

  private formatAdminEnrollmentSummary(
    participation: Participation,
    projectEnrollments: Participation[],
  ) {
    const teamMembers = this.groupTeamMembersForParticipation(
      projectEnrollments,
      participation,
    );
    const teamConfigured = isTeamConfigurationComplete(teamMembers);
    const effectiveParticipation =
      resolveParticipationForAttendanceUnlock(participation, teamMembers) ??
      participation;
    const attendanceUnlock = resolveAttendanceUnlockStatus(
      effectiveParticipation.student ?? participation.student,
      effectiveParticipation,
      teamConfigured,
    );

    return {
      participation_id: participation.id,
      project_id: participation.projectId,
      student_id: participation.studentId,
      full_name: participation.fullName,
      email: participation.email,
      role: this.deriveParticipationStudentRole(participation),
      participation_mode: participation.participationMode,
      is_team_lead: participation.isTeamLead === true,
      attendance_locked: participation.attendanceLocked === true,
      attendance_verification_requested:
        participation.attendanceVerificationRequested === true,
      admin_attendance_editable: participation.adminAttendanceEditable === true,
      attendance_logging_unlock_status: attendanceUnlock,
    };
  }

  private async loadOccupiedEnrollmentsByProject(
    projectIds: string[],
  ): Promise<Map<string, Participation[]>> {
    const grouped = new Map<string, Participation[]>();
    if (!projectIds.length) return grouped;

    const enrollments = await this.participationRepository.find({
      where: {
        projectId: In(projectIds),
        status: In(OCCUPIED_SEAT_STATUSES),
      },
      relations: ['student'],
      order: { isTeamLead: 'DESC', fullName: 'ASC' },
    });

    for (const row of enrollments) {
      const bucket = grouped.get(row.projectId) ?? [];
      bucket.push(row);
      grouped.set(row.projectId, bucket);
    }
    return grouped;
  }

  async getProjectEnrollments(opportunityId: string) {
    const opportunity = await this.opportunityRepository.findOne({
      where: { id: opportunityId },
    });
    if (!opportunity) {
      throw new NotFoundException('Project not found');
    }

    const enrollments = await this.participationRepository.find({
      where: {
        projectId: opportunityId,
        status: In(OCCUPIED_SEAT_STATUSES),
      },
      relations: ['student'],
      order: { isTeamLead: 'DESC', fullName: 'ASC' },
    });

    return {
      success: true,
      data: {
        project_id: opportunityId,
        project_title: opportunity.title,
        enrollments: enrollments.map((row) =>
          this.formatAdminEnrollmentSummary(row, enrollments),
        ),
      },
    };
  }

  async setParticipationAttendanceEditable(
    participationId: string,
    editable: boolean,
  ) {
    const participation = await this.participationRepository.findOne({
      where: { id: participationId },
      relations: ['student'],
    });
    if (!participation) {
      throw new NotFoundException('Participation not found');
    }

    participation.adminAttendanceEditable = editable;
    if (editable) {
      participation.attendanceLocked = false;
      participation.attendanceVerificationRequested = false;
      participation.attendanceVerificationRequestedAt = null;
    }
    await this.participationRepository.save(participation);

    const projectEnrollments = await this.participationRepository.find({
      where: {
        projectId: participation.projectId,
        status: In(OCCUPIED_SEAT_STATUSES),
      },
      relations: ['student'],
      order: { isTeamLead: 'DESC', fullName: 'ASC' },
    });

    if (participation.participationMode === 'team') {
      const teamGroup = this.groupTeamMembersForParticipation(
        projectEnrollments,
        participation,
      );
      const rowsToSync: Participation[] = [];

      if (participation.isTeamLead) {
        for (const row of teamGroup) {
          if (row.id !== participation.id) {
            rowsToSync.push(row);
          }
        }
      } else if (editable) {
        const teamLead =
          teamGroup.find((row) => row.isTeamLead) ?? teamGroup[0];
        if (teamLead && teamLead.id !== participation.id) {
          rowsToSync.push(teamLead);
        }
      }

      for (const row of rowsToSync) {
        row.adminAttendanceEditable = editable;
        if (editable) {
          row.attendanceLocked = false;
          row.attendanceVerificationRequested = false;
          row.attendanceVerificationRequestedAt = null;
        }
        await this.participationRepository.save(row);
      }
    }

    return {
      success: true,
      message: editable
        ? 'Attendance editing enabled for this team member'
        : 'Admin attendance override removed',
      data: this.formatAdminEnrollmentSummary(
        participation,
        projectEnrollments,
      ),
    };
  }

  dedupeStudentParticipationSeats(
    opportunityId: string,
    studentUserId: string,
  ) {
    return this.opportunityApplicationsService.adminDedupeStudentParticipationSeats(
      opportunityId,
      studentUserId,
    );
  }

  reconcileOpportunityEnrollments(opportunityId: string) {
    return this.opportunityApplicationsService.adminReconcileOpportunityEnrollments(
      opportunityId,
    );
  }

  healOpportunityTeamEnrollments(opportunityId: string) {
    return this.opportunityApplicationsService.adminHealOpportunityTeamEnrollments(
      opportunityId,
    );
  }

  async getProjects(
    studentEmailRaw?: string,
    opts: { page?: number; limit?: number; fields?: 'lite' } = {},
  ) {
    const normalizedEmail = this.normalizeStudentEmailFilter(
      studentEmailRaw ?? undefined,
    );

    let matchByOppId = new Map<
      string,
      { role: string; match_source: 'enrollment' | 'application_pipeline' }
    >();
    if (normalizedEmail) {
      matchByOppId =
        await this.buildStudentEmailProjectMatchMap(normalizedEmail);
    }

    const paginated =
      Number.isFinite(opts.page) || Number.isFinite(opts.limit);
    const limit = paginated
      ? Math.min(Math.max(Math.floor(opts.limit as number) || 50, 1), 200)
      : undefined;
    const page = paginated
      ? Math.max(Math.floor(opts.page as number) || 1, 1)
      : 1;

    // Dropdown mode: id/title/status only — no joins, no aggregates.
    if (opts.fields === 'lite') {
      let lite = await this.opportunityRepository.find({
        select: ['id', 'title', 'status'],
        order: { createdAt: 'DESC' },
      });
      if (normalizedEmail) lite = lite.filter((o) => matchByOppId.has(o.id));
      const total = lite.length;
      if (paginated) lite = lite.slice((page - 1) * limit!, page * limit!);
      return {
        success: true,
        data: lite.map((o) => ({ id: o.id, title: o.title, status: o.status })),
        ...(paginated ? { meta: { page, limit, total } } : {}),
      };
    }

    let opportunities = await this.opportunityRepository.find({
      relations: ['organization'],
      ...(paginated ? { order: { createdAt: 'DESC' as const } } : {}),
    });

    if (normalizedEmail) {
      const allowIds = matchByOppId;
      opportunities = opportunities.filter((o) => allowIds.has(o.id));
    }
    const total = opportunities.length;
    if (paginated) {
      opportunities = opportunities.slice((page - 1) * limit!, page * limit!);
    }

    const oppIds = opportunities.map((opp) => opp.id);
    const creatorIds = [
      ...new Set(opportunities.map((o) => o.creatorId).filter(Boolean)),
    ] as string[];

    const [
      enrollmentsByProject,
      verified,
      participationSeatRows,
      pipelineApps,
      creatorUsers,
    ] = await Promise.all([
      this.loadOccupiedEnrollmentsByProject(oppIds),
      this.computeVerifiedHours({ opportunityIds: oppIds }),
      oppIds.length
        ? this.participationRepository
            .createQueryBuilder('p')
            .select('p.projectId', 'projectId')
            .addSelect('COUNT(*)', 'cnt')
            .where('p.projectId IN (:...oppIds)', { oppIds })
            .andWhere('p.status IN (:...statuses)', {
              statuses: OCCUPIED_SEAT_STATUSES,
            })
            .groupBy('p.projectId')
            .getRawMany<{ projectId: string; cnt: string }>()
        : Promise.resolve([] as { projectId: string; cnt: string }[]),
      oppIds.length
        ? this.opportunityApplicationRepository.find({
            where: {
              opportunityId: In(oppIds),
              withdrawnAt: IsNull(),
              internalStatus: In(['pending_faculty', 'pending_partner', 'pending_admin']),
            },
            relations: ['studentUser'],
          })
        : Promise.resolve([] as OpportunityApplication[]),
      creatorIds.length
        ? this.usersRepository.find({
            where: { id: In(creatorIds) },
            select: ['id', 'name', 'email', 'phone'],
          })
        : Promise.resolve([] as User[]),
    ]);

    const participationSeatsByOpp = new Map(
      participationSeatRows.map((r) => [r.projectId, Number(r.cnt) || 0]),
    );
    const pipelineSeatsByOpp = new Map<string, number>();
    for (const app of pipelineApps) {
      const team =
        this.opportunityApplicationsService.adminBrowseApplicationTeamSummaryForQueue(
          app,
        );
      const seats = team && team.team_member_count >= 1 ? team.team_member_count : 1;
      pipelineSeatsByOpp.set(
        app.opportunityId,
        (pipelineSeatsByOpp.get(app.opportunityId) ?? 0) + seats,
      );
    }
    const creatorById = new Map(creatorUsers.map((u) => [u.id, u]));

    const projects = opportunities.map((opp) => {
      const hours = verified.byOpportunity.get(opp.id) ?? 0;
      const occupiedSeats =
        (participationSeatsByOpp.get(opp.id) ?? 0) +
        (pipelineSeatsByOpp.get(opp.id) ?? 0);

      const volunteersRequired = Number(opp.timeline?.volunteers_required) || 0;
      const perVolunteerHours =
        Number(opp.timeline?.expected_hours) || opp.requiredHours || 0;
      let targetHours = 0;
      if (volunteersRequired > 0 && perVolunteerHours > 0) {
        targetHours = volunteersRequired * perVolunteerHours;
      } else if (occupiedSeats > 0 && perVolunteerHours > 0) {
        targetHours = occupiedSeats * perVolunteerHours;
      }

      const remainingSeats = Math.max(0, volunteersRequired - occupiedSeats);
      const remainingHours = Math.max(0, targetHours - hours);

      const creatorUser = opp.creatorId
        ? creatorById.get(opp.creatorId)
        : undefined;
      const creator = creatorUser
        ? {
            id: creatorUser.id,
            name: creatorUser.name,
            email: creatorUser.email,
            phone: creatorUser.phone ?? null,
          }
        : null;

      const row: Record<string, unknown> = {
        id: opp.id,
        title: opp.title,
        org: opp.organization?.name || 'Unknown',
        status: opp.status,
        workflow_stage: opp.workflowStage ?? null,
        admin_approval_status: opp.adminApprovalStatus ?? null,
        faculty_approval_status: opp.facultyApprovalStatus ?? null,
        partner_approval_status: opp.partnerApprovalStatus ?? null,
        admin_approved: opp.admin_approved ?? false,
        volunteers: occupiedSeats,
        volunteers_required: volunteersRequired,
        hours,
        remaining_hours: remainingHours,
        remaining_seats: remainingSeats,
        remaining_members: remainingSeats,
        location: opp.location?.city || 'Unknown',
        supervision: opp.supervision,
        timeline: opp.timeline,
        participation_scope: opp.participation_scope,
        creator,
        attendance_routing_override: opp.attendanceRoutingOverride ?? 'auto',
        team_enrollments: (enrollmentsByProject.get(opp.id) ?? []).map((er) =>
          this.formatAdminEnrollmentSummary(
            er,
            enrollmentsByProject.get(opp.id) ?? [],
          ),
        ),
      };
      if (normalizedEmail) {
        const meta = matchByOppId.get(opp.id);
        if (meta) row['student_match'] = meta;
      }
      return row;
    });

    return {
      success: true,
      data: projects,
      ...(paginated ? { meta: { page, limit, total } } : {}),
    };
  }

  /** Last-sent marker per recipient when no DB notification record is available (resets on restart). */
  private readonly zeroHourReminderSentAt = new Map<string, number>();

  private static readonly ZERO_HOURS_REMINDER_TITLE = 'Log your volunteer hours';
  private static readonly ZERO_HOURS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  private static readonly ZERO_HOURS_BATCH_SIZE = 10;
  private static readonly ZERO_HOURS_MAIL_TIMEOUT_MS = 15_000;

  /**
   * Emails + notifies enrolled students on LIVE opportunities with 0 verified hours logged.
   * `dryRun` only returns the counts. A student is reminded at most once per 24h (DB notification
   * record, plus an in-memory marker for students without an account id).
   */
  async remindStudentsOnZeroHourProjects(opts: { dryRun?: boolean } = {}) {
    const dryRun = opts.dryRun === true;
    const opportunities = await this.opportunityRepository.find({
      where: { status: In(['active', 'live']) },
      select: ['id', 'title'],
    });
    const oppIds = opportunities.map((o) => o.id);
    const verified = oppIds.length
      ? await this.computeVerifiedHours({ opportunityIds: oppIds })
      : { byOpportunity: new Map<string, number>() };

    const zeroHourOpportunities = opportunities.filter(
      (opp) => (verified.byOpportunity.get(opp.id) ?? 0) <= 0,
    );

    const base = {
      success: true,
      dry_run: dryRun,
      opportunities_scanned: opportunities.length,
      opportunities_with_zero_hours: zeroHourOpportunities.length,
    };
    if (!zeroHourOpportunities.length) {
      return {
        ...base,
        students_notified: 0,
        students_failed: 0,
        students_skipped_cooldown: 0,
        would_notify: 0,
        students_to_notify: 0,
        students_would_notify: 0,
      };
    }

    const opportunityTitleById = new Map(
      zeroHourOpportunities.map((opp) => [opp.id, opp.title]),
    );
    const participations = await this.participationRepository.find({
      where: {
        projectId: In(zeroHourOpportunities.map((opp) => opp.id)),
        status: In(['accepted', 'approved', 'verified', 'paid']),
      },
    });

    // One reminder per student, listing every zero-hour project they are on.
    type ZeroHourRecipient = {
      email: string;
      name: string;
      studentId: string | null;
      titles: string[];
    };
    const recipients = new Map<string, ZeroHourRecipient>();
    for (const participation of participations) {
      const email = participation.email?.trim();
      if (!email) continue;
      const key = participation.studentId || email.toLowerCase();
      const title =
        opportunityTitleById.get(participation.projectId) ?? 'your project';
      const existing = recipients.get(key);
      if (existing) {
        if (!existing.titles.includes(title)) existing.titles.push(title);
      } else {
        recipients.set(key, {
          email,
          name: participation.fullName || 'Student',
          studentId: participation.studentId || null,
          titles: [title],
        });
      }
    }

    const now = Date.now();
    const cooldownMs = AdminService.ZERO_HOURS_COOLDOWN_MS;
    const dbRecent = new Set<string>();
    const notificationRepo = this.repoOf(Notification);
    const studentIds = [...recipients.values()]
      .map((r) => r.studentId)
      .filter(Boolean) as string[];
    if (notificationRepo && studentIds.length) {
      try {
        const recent = await notificationRepo.find({
          where: {
            userId: In(studentIds),
            title: AdminService.ZERO_HOURS_REMINDER_TITLE,
            createdAt: MoreThanOrEqual(new Date(now - cooldownMs)),
          },
          select: ['userId'],
        });
        for (const n of recent) dbRecent.add(n.userId);
      } catch (err) {
        this.logger.warn(
          `zero-hours cooldown lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const eligible: Array<[string, ZeroHourRecipient]> = [];
    let skippedCooldown = 0;
    for (const [key, r] of recipients) {
      const lastMem = this.zeroHourReminderSentAt.get(key) ?? 0;
      if ((r.studentId && dbRecent.has(r.studentId)) || now - lastMem < cooldownMs) {
        skippedCooldown += 1;
        continue;
      }
      eligible.push([key, r]);
    }

    if (dryRun) {
      return {
        ...base,
        students_notified: 0,
        students_failed: 0,
        students_skipped_cooldown: skippedCooldown,
        would_notify: eligible.length,
        students_to_notify: eligible.length,
        students_would_notify: eligible.length,
      };
    }

    let notified = 0;
    let failed = 0;
    const batchSize = AdminService.ZERO_HOURS_BATCH_SIZE;
    for (let i = 0; i < eligible.length; i += batchSize) {
      const batch = eligible.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async ([key, r]) => {
          const projectTitle = r.titles.slice(0, 3).join(', ');
          let ok = false;
          try {
            await this.withTimeout(
              this.mailService.sendHoursLoggingReminder(
                r.email,
                r.name,
                projectTitle,
              ),
              AdminService.ZERO_HOURS_MAIL_TIMEOUT_MS,
            );
            ok = true;
          } catch (err) {
            this.logger.warn(
              `zero-hours email failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (r.studentId) {
            try {
              await this.notificationsService.createNotification(r.studentId, {
                type: 'reminder',
                title: AdminService.ZERO_HOURS_REMINDER_TITLE,
                message: `You have 0 verified hours logged on "${projectTitle}". Please submit your timesheet so your contribution can be verified.`,
              });
              ok = true;
            } catch (err) {
              this.logger.warn(
                `zero-hours notification failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (ok) this.zeroHourReminderSentAt.set(key, Date.now());
          return ok;
        }),
      );
      for (const ok of results) {
        if (ok) notified += 1;
        else failed += 1;
      }
    }

    return {
      ...base,
      students_notified: notified,
      students_failed: failed,
      students_skipped_cooldown: skippedCooldown,
      would_notify: eligible.length,
      students_to_notify: eligible.length,
      students_would_notify: eligible.length,
    };
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /** One report per student+project: highest status wins, then newest update (not newest-only). */
  private dedupeReportsPerStudentProject(reports: StudentReport[]): StudentReport[] {
    const best = new Map<string, StudentReport>();
    for (const report of reports) {
      const projectId = this.getReportProjectId(report);
      const key =
        report.studentId && projectId
          ? `${report.studentId}:${projectId}`
          : `report:${report.id}`;
      const current = best.get(key);
      if (!current) {
        best.set(key, report);
        continue;
      }
      const rankDiff =
        reportStatusRank(report.status) -
        reportStatusRank(current.status);
      const newer =
        new Date(report.updatedAt ?? report.createdAt ?? 0).getTime() >
        new Date(current.updatedAt ?? current.createdAt ?? 0).getTime();
      if (rankDiff > 0 || (rankDiff === 0 && newer)) best.set(key, report);
    }
    return [...best.values()];
  }

  /** YYYY-MM in Asia/Karachi (fixed UTC+5, no DST). */
  private pktPeriod(date: Date): string {
    return new Date(date.getTime() + 5 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 7);
  }

  private async countPartnerOrganizations(): Promise<number> {
    const orgRepo = this.repoOf(Organization);
    if (orgRepo) {
      return orgRepo
        .createQueryBuilder('o')
        .where("LOWER(o.orgType) = 'ngo'")
        .andWhere("UPPER(COALESCE(o.verificationStatus, '')) <> 'REJECTED'")
        .getCount();
    }
    return this.usersRepository.count({ where: { role: UserRole.NGO } });
  }

  async getImpactAnalytics() {
    const [
      verified,
      studentReports,
      participations,
      partnerNgosCount,
      opportunities,
    ] = await Promise.all([
      this.computeVerifiedHours(),
      this.studentReportRepository.find({
        relations: ['opportunity'],
        order: { submission_date: 'DESC' },
      }),
      this.participationRepository.find({
        where: { status: In(ACTIVE_VOLUNTEER_STATUSES) },
        select: ['studentId'],
      }),
      this.countPartnerOrganizations(),
      this.opportunityRepository.find(),
    ]);

    const oppById = new Map(opportunities.map((o) => [o.id, o]));
    const approvedReports = this.dedupeReportsPerStudentProject(
      studentReports.filter((report) => this.isApprovedImpactReport(report)),
    );
    const coveredKeys = new Set(
      verified.rows
        .map((r) =>
          r.studentId && r.opportunityId
            ? `${r.studentId}:${r.opportunityId}`
            : null,
        )
        .filter(Boolean) as string[],
    );
    const impactEvents: Array<{ period: string; hours: number; sdg: string }> =
      [];

    for (const row of verified.rows) {
      impactEvents.push({
        period: row.period,
        hours: row.hours,
        sdg: this.getSdgName(
          row.opportunityId ? oppById.get(row.opportunityId) : undefined,
        ),
      });
    }

    for (const report of approvedReports) {
      const projectId = this.getReportProjectId(report);
      const key =
        report.studentId && projectId
          ? `${report.studentId}:${projectId}`
          : null;
      if (key && coveredKeys.has(key)) {
        continue;
      }

      const hours = this.getReportImpactHours(report);
      if (hours <= 0) continue;
      impactEvents.push({
        period: this.pktPeriod(
          report.submission_date
            ? new Date(report.submission_date)
            : new Date(report.createdAt),
        ),
        hours,
        sdg: this.getSdgName(report.opportunity, report),
      });
    }

    const MONTHS = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const hoursTrendMap: Record<string, number> = {};
    for (const event of impactEvents) {
      hoursTrendMap[event.period] = (hoursTrendMap[event.period] || 0) + event.hours;
    }
    const hoursTrend = Object.entries(hoursTrendMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, hours]) => {
        const [year, month] = period.split('-');
        const monthName = MONTHS[Number(month) - 1] ?? month;
        return {
          month: monthName,
          hours,
          // Year-qualified key so Jan 2025 and Jan 2026 never merge or collide.
          period,
          label: `${monthName} ${year}`,
        };
      });

    const sdgImpactMap: Record<string, number> = {};
    for (const event of impactEvents) {
      sdgImpactMap[event.sdg] = (sdgImpactMap[event.sdg] || 0) + event.hours;
    }

    const sdgImpact = Object.entries(sdgImpactMap)
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name, value }));

    // Active = enrolled (accepted and later) or has verified output. No fallback to total students.
    const activeVolunteerIds = new Set(
      participations.map((p) => p.studentId).filter(Boolean),
    );
    for (const row of verified.rows) {
      if (row.studentId) activeVolunteerIds.add(row.studentId);
    }
    for (const report of approvedReports) {
      if (report.studentId) activeVolunteerIds.add(report.studentId);
    }

    // Beneficiaries are counted once per project (team members' reports describe the same reach).
    const reportedByProject = new Map<string, number>();
    for (const report of approvedReports) {
      const key = this.getReportProjectId(report) ?? `report:${report.id}`;
      reportedByProject.set(
        key,
        Math.max(reportedByProject.get(key) ?? 0, this.getReportBeneficiaries(report)),
      );
    }
    let totalBeneficiaries = 0;
    for (const n of reportedByProject.values()) totalBeneficiaries += n;
    // Planned-only opportunities are reported separately, never mixed into the reached total.
    const plannedBeneficiaries = opportunities.reduce(
      (sum, opportunity) =>
        reportedByProject.has(opportunity.id)
          ? sum
          : sum + this.getOpportunityBeneficiaries(opportunity),
      0,
    );

    return {
      success: true,
      data: {
        hours_trend: hoursTrend,
        impact_by_sdg: sdgImpact,
        stats: {
          active_volunteers: activeVolunteerIds.size,
          partner_ngos: partnerNgosCount,
          total_beneficiaries: totalBeneficiaries,
          planned_beneficiaries: plannedBeneficiaries,
          verified_hours: verified.total,
        },
      },
    };
  }

  async getReports() {
    const reports = await this.reportRepository.find({
      relations: ['reporter'],
    });

    return {
      success: true,
      data: reports.map((r) => ({
        id: r.id,
        subject: r.subject,
        type: r.type,
        reporter: r.reporter?.name || 'Unknown',
        severity: r.severity,
        status: r.status,
        created_at: r.createdAt,
      })),
    };
  }

  async getCepExperienceFeedback(page?: number, limit?: number) {
    return this.feedbackService.listCepExperienceForAdmin(
      page ?? 1,
      limit ?? 20,
    );
  }

  async getAuditLogs(
    page?: number,
    limit?: number,
    filters?: AuditLogFilters,
  ) {
    const {
      logs,
      total,
      page: p,
      limit: l,
    } = await this.auditLogsService.findPaginated(page ?? 1, limit ?? 20, filters);

    return {
      success: true,
      data: logs.map((log) => ({
        id: log.id,
        action: log.action,
        user: log.user,
        user_email: log.user_email,
        target: log.target,
        target_type: log.target_type,
        ip: log.ip,
        details: log.details,
        created_at: log.created_at,
      })),
      meta: {
        page: p,
        limit: l,
        total,
      },
    };
  }

  async findPendingApplications() {
    const applications = await this.participationRepository.find({
      where: { status: In(['pending', 'pending_ciel_approval']) },
      relations: ['student', 'project'],
      order: { createdAt: 'DESC' },
    });

    const browseApps =
      await this.opportunityApplicationsService.findPendingAdminApplicationsForQueue();

    const fromParticipation = await Promise.all(
      applications.map(async (app) => {
        const base = {
          id: app.id,
          name: app.fullName || app.student?.name || 'Unknown',
          email: app.email || app.student?.email || 'Unknown',
          organization_type:
            app.participationMode === 'team' ? 'Team' : 'Individual',
          opportunity: app.project?.title || 'Unknown',
          status: app.status,
          created_at: app.createdAt,
          approval_kind: 'participation' as const,
        };
        if (app.participationMode !== 'team') {
          return base;
        }
        const team =
          await this.studentsService.getAdminTeamRosterForParticipation(app.id);
        return team ? { ...base, ...team } : base;
      }),
    );

    const fromBrowse = browseApps.map((a) => {
      const team =
        this.opportunityApplicationsService.adminBrowseApplicationTeamSummaryForQueue(
          a,
        );
      const base = {
        id: a.id,
        name: a.studentUser?.name || 'Unknown',
        email: a.studentUser?.email || 'Unknown',
        organization_type: team ? 'Team' : 'Individual',
        opportunity: a.opportunity?.title || 'Unknown',
        status: 'pending_ciel_approval',
        created_at: a.createdAt,
        approval_kind: 'opportunity_application' as const,
      };
      return team ? { ...base, ...team } : base;
    });

    const merged = [...fromParticipation, ...fromBrowse].sort(
      (x, y) =>
        new Date(y.created_at).getTime() - new Date(x.created_at).getTime(),
    );

    return {
      success: true,
      data: merged,
    };
  }

  private static readonly PARTICIPATION_REVIEWABLE = [
    'pending',
    'pending_ciel_approval',
  ];

  private assertParticipationReviewable(status: string): void {
    if (!AdminService.PARTICIPATION_REVIEWABLE.includes(status)) {
      throw new ConflictException(
        `This application is already "${status}" and can no longer be reviewed.`,
      );
    }
  }

  /** In-app notice to the student; a notification failure never fails the review. */
  private async notifyParticipationDecision(
    participation: Participation,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<void> {
    if (!participation.studentId) return;
    try {
      await this.notificationsService.createNotification(
        participation.studentId,
        {
          type: 'approval',
          title:
            decision === 'approved'
              ? 'Participation approved'
              : 'Participation request rejected',
          message:
            decision === 'approved'
              ? 'Your participation request has been approved by CIEL.'
              : `Your participation request was rejected by CIEL.${reason ? ` Reason: ${reason}` : ''}`,
        },
      );
    } catch (err) {
      this.logger.warn(
        `participation decision notification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Participation has no reviewer-id / reason columns; the actor + reason are captured by the
  // admin mutation audit log (route params + body) and the student notification.
  async approveApplication(id: string, adminUserId: string) {
    const application = await this.participationRepository.findOne({
      where: { id },
    });
    if (application) {
      this.assertParticipationReviewable(application.status);
      application.status = 'approved';
      application.reviewedBy = adminUserId || null;
      application.reviewedAt = new Date();
      application.reviewReason = null;
      await this.participationRepository.save(application);
      await this.notifyParticipationDecision(application, 'approved');
      return {
        success: true,
        message: 'Application approved successfully',
      };
    }
    return this.opportunityApplicationsService.adminApprove(id, adminUserId);
  }

  async rejectApplication(id: string, reason: string, adminUserId: string) {
    const application = await this.participationRepository.findOne({
      where: { id },
    });
    if (application) {
      this.assertParticipationReviewable(application.status);
      application.status = 'rejected';
      application.reviewedBy = adminUserId || null;
      application.reviewedAt = new Date();
      application.reviewReason = (reason || '').trim().slice(0, 2000) || null;
      await this.participationRepository.save(application);
      await this.notifyParticipationDecision(application, 'rejected', reason);
      return {
        success: true,
        message: 'Application rejected successfully',
      };
    }
    return this.opportunityApplicationsService.adminReject(
      id,
      adminUserId,
      reason || '',
    );
  }
}

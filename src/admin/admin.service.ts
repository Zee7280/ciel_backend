import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Report } from '../reports/entities/report.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UserRole } from '../users/enums/user-role.enum';
import { In, IsNull, LessThan, Not, SelectQueryBuilder } from 'typeorm';

import { Setting } from '../settings/entities/setting.entity';
import { MasterAnalyticsQueryDto } from './dto/master-analytics-query.dto';

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

const STAKEHOLDER_REGION_PHRASE_ALIASES: ReadonlyArray<{ readonly pattern: RegExp; readonly canonical: string }> = [
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
        .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
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

    s = s.replace(/,\s*pakistan\s*$/i, '').replace(/,\s*pk\s*$/i, '').trim();
    if (!s) return 'Unspecified';

    for (const { pattern, canonical } of STAKEHOLDER_REGION_PHRASE_ALIASES) {
        if (pattern.test(s)) return canonical;
    }

    const loweredFull = s.toLowerCase().replace(/\s+/g, ' ');

    const byLen = [...STAKEHOLDER_REGION_CANONICAL].sort((a, b) => b.length - a.length);
    for (const canon of byLen) {
        const c = canon.toLowerCase();
        const re = new RegExp(`(^|[^a-z0-9])${escapeStakeholderRegionTokenForRegExp(c)}([^a-z0-9]|$)`, 'i');
        if (re.test(loweredFull)) return canon;
    }

    const tokens = loweredFull.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
    const canonLcToDisplay = new Map(STAKEHOLDER_REGION_CANONICAL.map((c) => [c.toLowerCase(), c]));
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
    ) { }

    async getSettings() {
        const settings = await this.settingRepository.find();
        return {
            success: true,
            data: settings
        };
    }

    async updateSetting(key: string, value: string) {
        let setting = await this.settingRepository.findOne({ where: { key } });
        if (setting) {
            setting.value = value;
        } else {
            setting = this.settingRepository.create({ key, value });
        }
        await this.settingRepository.save(setting);
        return {
            success: true,
            data: setting
        };
    }

    async getDashboardStats() {
        // User Breakdown
        const totalStudents = await this.usersRepository.count({ where: { role: UserRole.STUDENT } });
        // Fetch all org types
        const orgUsers = await this.usersRepository.find({
            where: {
                role: In([UserRole.NGO, UserRole.CORPORATE, UserRole.ORGANIZATION_ADMIN, 'org'])
            }
        });
        const totalNgos = orgUsers.filter(u => u.orgType?.toLowerCase().includes('ngo') || u.role === UserRole.NGO).length;
        const totalCorporates = orgUsers.filter(u => u.orgType?.toLowerCase().includes('corporate') || u.role === UserRole.CORPORATE).length;
        const totalUsers = totalStudents + orgUsers.length;

        const totalOpportunities = await this.opportunityRepository.count();
        const totalReports = await this.reportRepository.count();

        // Pending Approvals (Users + Applications)
        const pendingUsers = await this.usersRepository.count({ where: { status: 'pending' } });
        const pendingApplications = await this.participationRepository.count({
            where: { status: In(['pending', 'pending_ciel_approval']) }
        });
        const pendingOppApplications = await this.opportunityApplicationsService.countPendingAdmin();
        const pendingApprovals = pendingUsers + pendingApplications + pendingOppApplications;

        // Verified Hours
        const verifiedTimesheets = await this.timesheetRepository.find({ where: { status: 'verified' } });
        const verifiedHours = verifiedTimesheets.reduce((sum, sheet) => sum + sheet.hours, 0);

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
            color: this.getSDGColor(name)
        }));

        return {
            success: true,
            data: {
                metrics: {
                    totalUsers: {
                        total: totalUsers,
                        students: totalStudents,
                        ngos: totalNgos,
                        corporates: totalCorporates
                    },
                    opportunities: totalOpportunities,
                    verifiedHours: verifiedHours,
                    pendingApprovals: pendingApprovals,
                    totalReports: totalReports
                },
                pendingSummary: {
                    total: pendingApprovals,
                    items: [
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
                            description: 'Student participation records waiting for CIEL review.',
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
                recentActivity: [] // Optional
            }
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
        const filtersActive = Boolean(query && this.masterAnalyticsFiltersActive(query));

        const participations = await this.loadMasterAnalyticsParticipations(filtersActive ? query : undefined);

        const typeCounts = new Map<string, number>();
        let total_required_hours = 0;
        for (const p of participations) {
            const mode = (p.participationMode || 'individual').toLowerCase();
            typeCounts.set(mode, (typeCounts.get(mode) || 0) + 1);
            total_required_hours += this.resolveRequiredHoursPerStudentFromOpportunity(p.project);
        }

        const participation_type_mix = [...typeCounts.entries()]
            .map(([participation_type, count]) => ({ participation_type, count }))
            .sort((a, b) => b.count - a.count);

        if (!filtersActive) {
            const now = new Date();
            const startOfThisMonthUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const total_participants = await this.usersRepository.count({ where: { role: UserRole.STUDENT } });

            const verified_students = await this.usersRepository.count({
                where: {
                    role: UserRole.STUDENT,
                    profile_verified: true,
                    identity_verified: true,
                },
            });

            const verification_rate_percent =
                total_participants === 0 ? 0 : Math.round((100 * verified_students) / total_participants);

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
                const n = String((row as { name?: string }).name || '').trim();
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
                    : Math.round(((total_participants - previous_headcount) / previous_headcount) * 1000) / 10;

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
            ...new Set(participations.map((p) => p.studentId).filter((id): id is string => Boolean(id))),
        ];
        const total_participants = cohortStudentIds.length;

        const verified_students = await this.countVerifiedStudentsInCohort(cohortStudentIds);

        const verification_rate_percent =
            total_participants === 0 ? 0 : Math.round((100 * verified_students) / total_participants);

        const universityNamesFiltered = new Set<string>();
        for (const p of participations) {
            const n = (p.universityName || '').trim();
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

    private masterUtcEndOfDay(iso: string): Date {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return d;
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
    }

    /** Verified students in cohort; chunked {@link In} avoids PostgreSQL bind-parameter limits for large filtered cohorts. */
    private async countVerifiedStudentsInCohort(cohortStudentIds: string[]): Promise<number> {
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

    private masterAnalyticsFiltersActive(query: MasterAnalyticsQueryDto): boolean {
        return Object.entries(query).some(
            ([, v]) => v !== undefined && v !== null && String(v).trim() !== '',
        );
    }

    private compactMasterAnalyticsFilterParams(query: MasterAnalyticsQueryDto): Record<string, string> {
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
            qb.andWhere('TRIM(COALESCE(p.universityName, \'\')) = :uni', { uni: query.university.trim() });
        }
        if (query.degree_program?.trim()) {
            qb.andWhere('TRIM(COALESCE(p.academicProgram, \'\')) = :deg', { deg: query.degree_program.trim() });
        }
        if (query.year_of_study?.trim()) {
            qb.andWhere('p.yearOfStudy = :yos', { yos: query.year_of_study.trim() });
        }
        if (query.academic_integration_type?.trim()) {
            qb.andWhere('p.academicIntegrationType = :ait', { ait: query.academic_integration_type.trim() });
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
            qb.andWhere('proj.organizationId = :porg', { porg: query.partner_organization_id });
        }
        if (query.verification_status === 'verified') {
            qb.andWhere('stu.profile_verified = true AND stu.identity_verified = true');
        } else if (query.verification_status === 'unverified') {
            qb.andWhere(
                '(stu.id IS NULL OR COALESCE(stu.profile_verified, false) = false OR COALESCE(stu.identity_verified, false) = false)',
            );
        }
        if (query.period_start?.trim()) {
            const ps = new Date(query.period_start.trim());
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
            .andWhere('p.status IN (:...mastSt)', { mastSt: MASTER_ANALYTICS_PARTICIPATION_STATUSES });

        this.applyMasterAnalyticsQueryFilters(qb, query);

        return qb.getMany();
    }

    /**
     * HEC / Government / UN stakeholder slices for the admin impact dashboard.
     * Uses non-rejected participations with a linked student plus platform student counts.
     */
    async getImpactStakeholderAnalytics() {
        const total_students = await this.usersRepository.count({ where: { role: UserRole.STUDENT } });

        const verified_students = await this.usersRepository.count({
            where: {
                role: UserRole.STUDENT,
                profile_verified: true,
                identity_verified: true,
            },
        });

        const verification_rate_percent =
            total_students === 0 ? 0 : Math.round((100 * verified_students) / total_students);

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
            const n = String((row as { name?: string }).name || '').trim();
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

            total_required_hours += this.resolveRequiredHoursPerStudentFromOpportunity(p.project);

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
            .map(([academic_integration_type, count]) => ({ academic_integration_type, count }))
            .sort((a, b) => b.count - a.count);

        const participation_by_region = [...regionMap.entries()]
            .map(([region, count]) => ({ region, count }))
            .sort((a, b) => b.count - a.count);

        const participation_structure = [...structureMap.entries()]
            .map(([participation_type, count]) => ({ participation_type, count }))
            .sort((a, b) => b.count - a.count);

        const enrollment_total = participations.length;
        const formal_integration_rate_percent =
            enrollment_total === 0 ? 0 : Math.round((100 * formal_enrollment_rows) / enrollment_total);

        const now = new Date();
        const startOfThisMonthUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const previous_headcount = await this.usersRepository.count({
            where: {
                role: UserRole.STUDENT,
                createdAt: LessThan(startOfThisMonthUtc),
            },
        });

        const growth_rate_percent =
            previous_headcount === 0
                ? null
                : Math.round(((total_students - previous_headcount) / previous_headcount) * 1000) / 10;

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
            const city = String((loc as { city?: string; province?: string }).city || '').trim();
            if (city) fromProject = city;
            else {
                const province = String((loc as { province?: string }).province || '').trim();
                if (province) fromProject = province;
            }
        }

        const raw = fromStudent || fromProject;
        return normalizeStakeholderRegionLabel(raw);
    }

    private resolveRequiredHoursPerStudentFromOpportunity(project: Opportunity | null | undefined): number {
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
            'SDG 13': '#3f7e44'
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
            if (v && typeof v === 'object') return this.hasMeaningfulAnalyticsObjectValue(v);
            return v !== null && v !== undefined && String(v).trim() !== '';
        });
    }

    private reportRequiresPartnerApproval(report: StudentReport): boolean {
        const partners = Array.isArray(report.section7?.partners) ? report.section7.partners : [];
        const hasDeclaredPartner =
            report.section7?.has_partners === 'yes' ||
            report.section8?.partner_verification === true ||
            partners.some((partner) => this.hasMeaningfulAnalyticsObjectValue(partner));

        return Boolean(
            report.opportunity?.requiresPartnerApproval ||
            hasDeclaredPartner ||
            report.partner_status === 'approved',
        );
    }

    private isApprovedImpactReport(report: StudentReport): boolean {
        if (report.status === 'rejected' || report.partner_status === 'rejected' || report.admin_status === 'rejected') {
            return false;
        }

        const hasFinalStatus =
            report.status === 'verified' ||
            report.status === 'paid' ||
            (report.admin_status === 'approved' && ['submitted', 'partner_verified'].includes(report.status));
        const partnerApproved = !this.reportRequiresPartnerApproval(report) || report.partner_status === 'approved';

        return hasFinalStatus && partnerApproved && report.admin_status === 'approved';
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

        const metricHours = this.toAnalyticsNumber(section1?.metrics?.total_verified_hours);
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
            }
            | undefined;

        return (
            this.toAnalyticsNumber(section4?.project_summary?.distinct_total_beneficiaries) ??
            this.toAnalyticsNumber(section4?.distinct_total_beneficiaries) ??
            this.toAnalyticsNumber(section4?.total_beneficiaries) ??
            this.toAnalyticsNumber(section4?.my_beneficiaries) ??
            0
        );
    }

    private getOpportunityBeneficiaries(opportunity: Opportunity): number {
        return (
            this.toAnalyticsNumber(opportunity.objectives?.beneficiaries_count) ??
            this.toAnalyticsNumber(opportunity.objectives?.total_beneficiaries) ??
            0
        );
    }

    private getSdgName(opportunity?: Opportunity | null, report?: StudentReport): string {
        const primarySdg = (report?.section3 as { primary_sdg?: { goal_number?: unknown; goal_title?: unknown } } | undefined)
            ?.primary_sdg;
        const goalNumber = this.toAnalyticsNumber(primarySdg?.goal_number);
        if (goalNumber) {
            return primarySdg?.goal_title ? `SDG ${goalNumber}: ${primarySdg.goal_title}` : `SDG ${goalNumber}`;
        }
        return (
            opportunity?.sdg ||
            opportunity?.sdg_info?.sdg_id ||
            opportunity?.sdg_info?.goal ||
            'Unknown'
        );
    }

    async getProjects() {
        const opportunities = await this.opportunityRepository.find({
            relations: ['organization']
        });

        const projects = await Promise.all(opportunities.map(async (opp) => {
            const timesheets = await this.timesheetRepository.find({ where: { opportunityId: opp.id } });
            const hours = timesheets.filter(t => t.status === 'verified').reduce((sum, t) => sum + Number(t.hours || 0), 0);

            const participationSeats = await this.participationRepository.count({
                where: {
                    projectId: opp.id,
                    status: In(OCCUPIED_SEAT_STATUSES),
                },
            });
            const pipelineSeats = await this.opportunityApplicationsService.countSeatsInFlight(opp.id);
            const occupiedSeats = participationSeats + pipelineSeats;

            const volunteersRequired = Number(opp.timeline?.volunteers_required) || 0;
            const perVolunteerHours = Number(opp.timeline?.expected_hours) || opp.requiredHours || 0;
            let targetHours = 0;
            if (volunteersRequired > 0 && perVolunteerHours > 0) {
                targetHours = volunteersRequired * perVolunteerHours;
            } else if (occupiedSeats > 0 && perVolunteerHours > 0) {
                targetHours = occupiedSeats * perVolunteerHours;
            }

            const remainingSeats = Math.max(0, volunteersRequired - occupiedSeats);
            const remainingHours = Math.max(0, targetHours - hours);

            return {
                id: opp.id,
                title: opp.title,
                org: opp.organization?.name || 'Unknown',
                status: opp.status,
                volunteers: occupiedSeats,
                volunteers_required: volunteersRequired,
                hours,
                remaining_hours: remainingHours,
                remaining_seats: remainingSeats,
                remaining_members: remainingSeats,
                location: opp.location?.city || 'Unknown',
            };
        }));

        return { success: true, data: projects };
    }

    async getImpactAnalytics() {
        const [
            verifiedTimesheets,
            studentReports,
            participations,
            totalStudents,
            partnerNgosCount,
            opportunities,
        ] = await Promise.all([
            this.timesheetRepository.find({
                where: { status: 'verified' },
                relations: ['opportunity']
            }),
            this.studentReportRepository.find({
                relations: ['opportunity'],
                order: { submission_date: 'DESC' },
            }),
            this.participationRepository.find({
                where: { status: In([...OCCUPIED_SEAT_STATUSES]) },
                select: ['studentId'],
            }),
            this.usersRepository.count({ where: { role: UserRole.STUDENT } }),
            this.usersRepository.count({ where: { role: UserRole.NGO } }),
            this.opportunityRepository.find(),
        ]);

        const approvedReports = studentReports.filter((report) => this.isApprovedImpactReport(report));
        const coveredTimesheetKeys = new Set(
            verifiedTimesheets
                .map((t) => t.studentId && t.opportunityId ? `${t.studentId}:${t.opportunityId}` : null)
                .filter(Boolean) as string[],
        );
        const impactEvents: Array<{ date: Date; hours: number; sdg: string }> = [];

        for (const t of verifiedTimesheets) {
            const hours = this.toAnalyticsNumber(t.hours) ?? 0;
            if (hours <= 0) continue;
            impactEvents.push({
                date: new Date(t.createdAt),
                hours,
                sdg: this.getSdgName(t.opportunity),
            });
        }

        for (const report of approvedReports) {
            const projectId = this.getReportProjectId(report);
            const key = report.studentId && projectId ? `${report.studentId}:${projectId}` : null;
            if (key && coveredTimesheetKeys.has(key)) {
                continue;
            }

            const hours = this.getReportImpactHours(report);
            if (hours <= 0) continue;
            impactEvents.push({
                date: report.submission_date ? new Date(report.submission_date) : new Date(report.createdAt),
                hours,
                sdg: this.getSdgName(report.opportunity, report),
            });
        }

        const hoursTrendMap: Record<string, { month: string; sortKey: string; hours: number }> = {};
        for (const event of impactEvents) {
            const year = event.date.getFullYear();
            const monthIndex = event.date.getMonth();
            const sortKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
            const month = event.date.toLocaleString('default', { month: 'short' });
            hoursTrendMap[sortKey] = hoursTrendMap[sortKey] || { month, sortKey, hours: 0 };
            hoursTrendMap[sortKey].hours += event.hours;
        }

        const hoursTrend = Object.values(hoursTrendMap)
            .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
            .map(({ month, hours }) => ({ month, hours }));

        const sdgImpactMap: Record<string, number> = {};
        for (const event of impactEvents) {
            sdgImpactMap[event.sdg] = (sdgImpactMap[event.sdg] || 0) + event.hours;
        }

        const sdgImpact = Object.entries(sdgImpactMap)
            .sort(([, a], [, b]) => b - a)
            .map(([name, value]) => ({ name, value }));

        const activeVolunteerIds = new Set(
            participations.map((p) => p.studentId).filter(Boolean) as string[],
        );
        for (const t of verifiedTimesheets) {
            if (t.studentId) activeVolunteerIds.add(t.studentId);
        }
        for (const report of approvedReports) {
            if (report.studentId) activeVolunteerIds.add(report.studentId);
        }
        const activeVolunteersCount = activeVolunteerIds.size || totalStudents;

        const beneficiaryProjectsFromReports = new Set<string>();
        const reportBeneficiaries = approvedReports.reduce((sum, report) => {
            const projectId = this.getReportProjectId(report);
            if (projectId) beneficiaryProjectsFromReports.add(projectId);
            return sum + this.getReportBeneficiaries(report);
        }, 0);
        const opportunityBeneficiaries = opportunities.reduce((sum, opportunity) => {
            if (beneficiaryProjectsFromReports.has(opportunity.id)) {
                return sum;
            }
            return sum + this.getOpportunityBeneficiaries(opportunity);
        }, 0);
        const totalBeneficiaries = reportBeneficiaries + opportunityBeneficiaries;

        return {
            success: true,
            data: {
                hours_trend: hoursTrend,
                impact_by_sdg: sdgImpact,
                stats: {
                    active_volunteers: activeVolunteersCount,
                    partner_ngos: partnerNgosCount,
                    total_beneficiaries: totalBeneficiaries
                }
            }
        };
    }

    async getReports() {
        const reports = await this.reportRepository.find({
            relations: ['reporter']
        });

        return {
            success: true,
            data: reports.map(r => ({
                id: r.id,
                subject: r.subject,
                type: r.type,
                reporter: r.reporter?.name || 'Unknown',
                severity: r.severity,
                status: r.status,
                created_at: r.createdAt
            }))
        };
    }

    async getAuditLogs(page?: number, limit?: number) {
        const { logs, total, page: p, limit: l } =
            await this.auditLogsService.findPaginated(page ?? 1, limit ?? 20);

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

        const browseApps = await this.opportunityApplicationsService.findPendingAdminApplicationsForQueue();

        const fromParticipation = applications.map((app) => ({
            id: app.id,
            name: app.fullName || app.student?.name || 'Unknown',
            email: app.email || app.student?.email || 'Unknown',
            organization_type: app.participationMode === 'team' ? 'Team' : 'Individual',
            opportunity: app.project?.title || 'Unknown',
            status: app.status,
            created_at: app.createdAt,
            approval_kind: 'participation' as const,
        }));

        const fromBrowse = browseApps.map((a) => {
            const payload = a.applyPayload || {};
            const ptype = (payload['participation_type'] as string) || 'individual';
            return {
                id: a.id,
                name: a.studentUser?.name || 'Unknown',
                email: a.studentUser?.email || 'Unknown',
                organization_type: ptype === 'team' ? 'Team' : 'Individual',
                opportunity: a.opportunity?.title || 'Unknown',
                status: 'pending_ciel_approval',
                created_at: a.createdAt,
                approval_kind: 'opportunity_application' as const,
            };
        });

        const merged = [...fromParticipation, ...fromBrowse].sort(
            (x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime(),
        );

        return {
            success: true,
            data: merged,
        };
    }

    async approveApplication(id: string, adminUserId: string) {
        const application = await this.participationRepository.findOne({ where: { id } });
        if (application) {
            application.status = 'approved';
            await this.participationRepository.save(application);
            return {
                success: true,
                message: 'Application approved successfully',
            };
        }
        return this.opportunityApplicationsService.adminApprove(id, adminUserId);
    }

    async rejectApplication(id: string, reason: string, adminUserId: string) {
        const application = await this.participationRepository.findOne({ where: { id } });
        if (application) {
            application.status = 'rejected';
            await this.participationRepository.save(application);
            return {
                success: true,
                message: 'Application rejected successfully',
            };
        }
        return this.opportunityApplicationsService.adminReject(id, adminUserId, reason || '');
    }
}

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

import { AuditLog } from '../audit-logs/entities/audit-log.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { In } from 'typeorm';

import { Setting } from '../settings/entities/setting.entity';

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
        @InjectRepository(AuditLog)
        private auditLogRepository: Repository<AuditLog>,
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

            const occupiedSeats = await this.participationRepository.count({
                where: {
                    projectId: opp.id,
                    status: In(OCCUPIED_SEAT_STATUSES),
                },
            });

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

    async getAuditLogs(page: number = 1, limit: number = 20) {
        const skip = (page - 1) * limit;
        const [logs, total] = await this.auditLogRepository.findAndCount({
            order: { created_at: 'DESC' },
            skip,
            take: limit
        });

        return {
            success: true,
            data: logs.map(log => ({
                id: log.id,
                action: log.action,
                user: log.user,
                user_email: log.user_email,
                target: log.target,
                target_type: log.target_type,
                ip: log.ip,
                details: log.details,
                created_at: log.created_at
            })),
            meta: {
                page,
                limit,
                total
            }
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

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Report } from '../reports/entities/report.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';

import { AuditLog } from '../audit-logs/entities/audit-log.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { In } from 'typeorm';

import { Setting } from '../settings/entities/setting.entity';

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

    async getProjects() {
        const opportunities = await this.opportunityRepository.find({
            relations: ['organization']
        });

        const projects = await Promise.all(opportunities.map(async (opp) => {
            const timesheets = await this.timesheetRepository.find({ where: { opportunityId: opp.id } });
            const hours = timesheets.filter(t => t.status === 'verified').reduce((sum, t) => sum + t.hours, 0);
            const volunteers = new Set(timesheets.map(t => t.studentId)).size;

            return {
                id: opp.id,
                title: opp.title,
                org: opp.organization?.name || 'Unknown',
                status: opp.status,
                volunteers: volunteers || (opp.timeline?.volunteers_required || 0),
                hours: hours,
                location: opp.location?.city || 'Unknown'
            };
        }));

        return { success: true, data: projects };
    }

    async getImpactAnalytics() {
        const verifiedTimesheets = await this.timesheetRepository.find({
            where: { status: 'verified' },
            relations: ['opportunity']
        });

        const hoursTrendMap = {};
        verifiedTimesheets.forEach(t => {
            const date = new Date(t.createdAt);
            const month = date.toLocaleString('default', { month: 'short' });
            hoursTrendMap[month] = (hoursTrendMap[month] || 0) + t.hours;
        });

        const hoursTrend = Object.entries(hoursTrendMap).map(([month, hours]) => ({ month, hours }));

        const sdgImpactMap = {};
        verifiedTimesheets.forEach(t => {
            const sdg = t.opportunity?.sdg || 'Unknown';
            sdgImpactMap[sdg] = (sdgImpactMap[sdg] || 0) + t.hours;
        });

        const sdgImpact = Object.entries(sdgImpactMap).map(([name, value]) => ({ name, value }));

        const activeVolunteersCount = await this.usersRepository.count({ where: { role: UserRole.STUDENT } });
        const partnerNgosCount = await this.usersRepository.count({ where: { role: UserRole.NGO } });
        const opportunities = await this.opportunityRepository.find();
        const totalBeneficiaries = opportunities.reduce((sum, opp) => sum + (parseInt(opp.objectives?.beneficiaries_count || '0') || 0), 0);

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

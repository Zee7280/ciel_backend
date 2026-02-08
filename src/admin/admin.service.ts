import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Report } from '../reports/entities/report.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';

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
    ) { }

    // ... existing methods (getDashboardStats, etc.) ...

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

    // ... continue other methods ...

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
        const pendingTimesheets = await this.timesheetRepository.count({ where: { status: 'pending' } });
        const pendingApprovals = pendingUsers + pendingTimesheets; // Summing pending entities

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

        // For volunteers and hours, ideally we aggregate from timesheets/applications
        // Doing a simple loop for now as optimization can come later
        const projects = await Promise.all(opportunities.map(async (opp) => {
            const timesheets = await this.timesheetRepository.find({ where: { opportunityId: opp.id } });
            const hours = timesheets.filter(t => t.status === 'verified').reduce((sum, t) => sum + t.hours, 0);
            const volunteers = new Set(timesheets.map(t => t.studentId)).size; // Unique volunteers who logged time

            return {
                id: opp.id,
                title: opp.title,
                org: opp.organization?.name || 'Unknown',
                status: opp.status,
                volunteers: volunteers || (opp.timeline?.volunteers_required || 0), // Fallback to required if 0? Spec impl implies actuals. Let's keep 0 if none.
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

        // Hours Trend (Mocking monthly for now based on createdAt of timesheet)
        const hoursTrendMap = {};
        verifiedTimesheets.forEach(t => {
            const date = new Date(t.createdAt);
            const month = date.toLocaleString('default', { month: 'short' });
            hoursTrendMap[month] = (hoursTrendMap[month] || 0) + t.hours;
        });

        const hoursTrend = Object.entries(hoursTrendMap).map(([month, hours]) => ({ month, hours }));

        // SDG Impact
        const sdgImpactMap = {};
        verifiedTimesheets.forEach(t => {
            const sdg = t.opportunity?.sdg || 'Unknown';
            sdgImpactMap[sdg] = (sdgImpactMap[sdg] || 0) + t.hours; // Impact measured in hours? Spec says "value": 500
        });

        const sdgImpact = Object.entries(sdgImpactMap).map(([name, value]) => ({ name, value }));

        // Stats for Analytics Page
        const activeVolunteersCount = await this.usersRepository.count({ where: { role: UserRole.STUDENT } }); // Approx
        const partnerNgosCount = await this.usersRepository.count({ where: { role: UserRole.NGO } }); // Direct NGO role check
        // Beneficiaries count logic? Using a placeholder or sum from opportunities.
        // Assuming 'beneficiaries_count' in opportunity.objectives
        const opportunities = await this.opportunityRepository.find();
        const totalBeneficiaries = opportunities.reduce((sum, opp) => sum + (parseInt(opp.objectives?.beneficiaries_count || '0') || 0), 0);

        return {
            success: true,
            data: {
                hours_trend: hoursTrend, // Renamed to match spec
                impact_by_sdg: sdgImpact, // Renamed slightly or keep matches? Spec: impact_by_sdg
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
        const applications = await this.timesheetRepository.find({
            where: { status: 'pending' },
            relations: ['student', 'opportunity', 'student.organization'],
            order: { createdAt: 'DESC' }
        });

        // Mapping to user requested format:
        // { "id": 1, "name": "John Doe", "email": "john@example.com", "organization_type": "NGO", "created_at": "..." }
        return {
            success: true,
            data: applications.map(app => ({
                id: app.id,
                name: app.student?.name || 'Unknown',
                email: app.student?.email || 'Unknown',
                organization_type: app.student?.organization?.orgType || 'Student', // If no org, likely individual student
                created_at: app.createdAt
            }))
        };
    }

    async approveApplication(id: string) {
        const application = await this.timesheetRepository.findOne({ where: { id } });
        if (!application) {
            throw new Error('Application not found'); // Best to use NotFoundException if possible, but Error works generic
        }
        application.status = 'approved';
        // User requested 'active' or 'approved'. 'approved' matches our other status logic better.
        await this.timesheetRepository.save(application);
        return {
            success: true,
            message: 'User approved successfully'
        };
    }

    async rejectApplication(id: string, reason: string) {
        const application = await this.timesheetRepository.findOne({ where: { id } });
        if (!application) {
            throw new Error('Application not found');
        }
        application.status = 'rejected';
        application.rejectionReason = reason;
        await this.timesheetRepository.save(application);
        return {
            success: true,
            message: 'User rejected successfully'
        };
    }
}

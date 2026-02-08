import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { ApplyOpportunityDto } from './dto/apply-opportunity.dto';
import { LogHoursDto } from './dto/log-hours.dto';
import { UpdateStudentProfileDto } from './dto/update-profile.dto';

import { OpportunityParticipant } from '../opportunities/entities/opportunity-participant.entity';
import { OpportunityTeamMember } from '../opportunities/entities/opportunity-team-member.entity';

@Injectable()
export class StudentsService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(Timesheet)
        private timesheetsRepository: Repository<Timesheet>,
        @InjectRepository(OpportunityParticipant)
        private opportunityParticipantsRepository: Repository<OpportunityParticipant>,
        @InjectRepository(OpportunityTeamMember)
        private opportunityTeamMembersRepository: Repository<OpportunityTeamMember>,
    ) { }

    // Dashboard
    async getDashboard(userId: string) {
        const timesheets = await this.timesheetsRepository.find({
            where: { studentId: userId },
            relations: ['opportunity'],
        });

        const totalHours = timesheets
            .filter(t => t.status === 'verified')
            .reduce((sum, t) => sum + t.hours, 0);

        const activeOpportunities = new Set(
            timesheets
                .filter(t => t.status !== 'rejected')
                .map(t => t.opportunityId)
        ).size;

        const completedOpportunities = new Set(
            timesheets
                .filter(t => t.status === 'verified')
                .map(t => t.opportunityId)
        ).size;

        return {
            success: true,
            data: {
                stats: {
                    totalHours,
                    activeOpportunities,
                    completedOpportunities,
                    impactScore: totalHours * 10, // Simple calculation
                },
                recentActivities: timesheets.slice(0, 5).map(t => ({
                    id: t.id,
                    type: 'timesheet',
                    title: t.opportunity?.title || 'Unknown',
                    hours: t.hours,
                    status: t.status,
                    date: t.createdAt,
                })),
                upcomingOpportunities: [], // Can be enhanced
            },
        };
    }

    // Opportunities
    async getOpportunities(query: any, userId?: string) {
        const { sdg, location, type, status, page = 1, limit = 10 } = query;
        const skip = (page - 1) * limit;

        let filterStatus = status || 'active';
        if (filterStatus === 'approved') {
            filterStatus = 'active';
        }

        const whereClause: any = { status: filterStatus };
        if (sdg) whereClause.sdg = sdg;
        if (location) whereClause.location = { city: location };
        if (type) whereClause.type = type;

        const [opportunities, total] = await this.opportunitiesRepository.findAndCount({
            where: whereClause,
            relations: ['organization'],
            skip,
            take: limit,
            order: { createdAt: 'DESC' },
        });

        let applicationStatuses = new Map<string, string>();

        if (userId && opportunities.length > 0) {
            const opportunityIds = opportunities.map(o => o.id);
            const applications = await this.opportunityParticipantsRepository
                .createQueryBuilder('participant')
                .where('participant.studentId = :userId', { userId })
                .andWhere('participant.opportunityId IN (:...opportunityIds)', { opportunityIds })
                .getMany();

            applications.forEach(app => {
                applicationStatuses.set(app.opportunityId, app.status);
            });
        }

        return {
            success: true,
            data: opportunities.map(o => ({
                id: o.id,
                title: o.title,
                organization: o.organization?.name || 'Unknown',
                sdg: o.sdg,
                location: o.location?.city || 'Unknown',
                volunteersNeeded: o.timeline?.volunteers_required || 0,
                description: o.objectives?.description?.substring(0, 150) || 'No description',
                application_status: applicationStatuses.get(o.id) || null,
                status: applicationStatuses.has(o.id) ? 'applied' : o.status,
            })),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
            },
        };
    }

    async getOpportunityById(id: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id },
            relations: ['organization'],
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        return {
            success: true,
            data: opportunity,
        };
    }

    async getRecommendedOpportunities(userId: string) {
        // Simple implementation - can be enhanced with ML
        const opportunities = await this.opportunitiesRepository.find({
            where: { status: 'active' },
            relations: ['organization'],
            take: 5,
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: opportunities,
        };
    }

    async getStudentProjects(studentId: string) {
        const applications = await this.opportunityParticipantsRepository.find({
            where: { studentId },
            relations: ['opportunity', 'opportunity.organization', 'teamMembers'],
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: applications,
        };
    }

    // Applications (using Timesheets as applications)
    async getApplications(userId: string, status?: string) {
        const whereClause: any = { studentId: userId };
        if (status) whereClause.status = status;

        const applications = await this.timesheetsRepository.find({
            where: whereClause,
            relations: ['opportunity', 'opportunity.organization'],
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: applications.map(a => ({
                id: a.id,
                opportunityId: a.opportunityId,
                opportunityTitle: a.opportunity?.title || 'Unknown',
                organization: a.opportunity?.organization?.name || 'Unknown',
                status: a.status,
                appliedDate: a.createdAt,
                hours: a.hours,
            })),
        };
    }

    async applyToOpportunity(userId: string, dto: ApplyOpportunityDto) {
        console.log('Apply Opportunity DTO:', JSON.stringify(dto));
        console.log('Participation Type:', dto.participation_type);
        console.log('Team Members:', dto.team_members?.length);

        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: dto.opportunityId },
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        // Check if already applied
        const existing = await this.opportunityParticipantsRepository.findOne({
            where: {
                studentId: userId,
                opportunityId: dto.opportunityId,
            },
        });

        if (existing) {
            throw new BadRequestException('Already applied to this opportunity');
        }

        // Capacity Check
        const participants = await this.opportunityParticipantsRepository.find({
            where: { opportunityId: dto.opportunityId },
            relations: ['teamMembers']
        });

        let currentCount = 0;
        for (const p of participants) {
            currentCount += 1; // The participant themselves
            if (p.participation_type === 'team' && p.teamMembers) {
                currentCount += p.teamMembers.length;
            }
        }

        let incomingCount = 1; // The applicant
        if (dto.participation_type === 'team' && dto.team_members) {
            incomingCount += dto.team_members.length;
        }

        const required = opportunity.timeline?.volunteers_required || 0;
        if (required > 0 && (currentCount + incomingCount) > required) {
            throw new BadRequestException(`Opportunity is full. Remaining spots: ${Math.max(0, required - currentCount)}`);
        }

        // Create Participant
        const participant = this.opportunityParticipantsRepository.create({
            studentId: userId,
            opportunityId: dto.opportunityId,
            participation_type: dto.participation_type || 'individual',
            status: 'pending' // Or 'approved' if auto-approve?
        });

        const savedParticipant = await this.opportunityParticipantsRepository.save(participant);

        // Add Team Members
        if (dto.participation_type === 'team' && dto.team_members && dto.team_members.length > 0) {
            const teamMembers = dto.team_members.map(m => this.opportunityTeamMembersRepository.create({
                participantId: savedParticipant.id,
                name: m.name,
                cnic: m.cnic,
                mobile: m.mobile,
                email: m.email,
                university: m.university,
                program: m.program,
                role: m.role,
                is_verified: false // Email verification needed logic can go here later
            }));
            await this.opportunityTeamMembersRepository.save(teamMembers);
        }

        return {
            success: true,
            data: savedParticipant,
            message: 'Application submitted successfully',
        };
    }

    async withdrawApplication(userId: string, id: string) {
        const application = await this.timesheetsRepository.findOne({
            where: { id },
        });

        if (!application) {
            throw new NotFoundException('Application not found');
        }

        if (application.studentId !== userId) {
            throw new ForbiddenException('Not your application');
        }

        if (application.status !== 'pending') {
            throw new BadRequestException('Can only withdraw pending applications');
        }

        await this.timesheetsRepository.remove(application);

        return {
            success: true,
            message: 'Application withdrawn successfully',
        };
    }

    // Timesheets
    async getTimesheets(userId: string, query: any) {
        const { status, opportunityId } = query;
        const whereClause: any = { studentId: userId };
        if (status) whereClause.status = status;
        if (opportunityId) whereClause.opportunityId = opportunityId;

        const timesheets = await this.timesheetsRepository.find({
            where: whereClause,
            relations: ['opportunity'],
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: timesheets,
        };
    }

    async logHours(userId: string, dto: LogHoursDto) {
        const timesheet = this.timesheetsRepository.create({
            studentId: userId,
            opportunityId: dto.opportunityId,
            hours: dto.hours,
            description: dto.description,
            status: 'pending',
        });

        await this.timesheetsRepository.save(timesheet);

        return {
            success: true,
            data: timesheet,
            message: 'Hours logged successfully',
        };
    }

    async updateTimesheet(userId: string, id: string, dto: Partial<LogHoursDto>) {
        const timesheet = await this.timesheetsRepository.findOne({
            where: { id },
        });

        if (!timesheet) {
            throw new NotFoundException('Timesheet not found');
        }

        if (timesheet.studentId !== userId) {
            throw new ForbiddenException('Not your timesheet');
        }

        if (timesheet.status === 'verified') {
            throw new BadRequestException('Cannot update verified timesheets');
        }

        Object.assign(timesheet, dto);
        await this.timesheetsRepository.save(timesheet);

        return {
            success: true,
            data: timesheet,
        };
    }

    async deleteTimesheet(userId: string, id: string) {
        const timesheet = await this.timesheetsRepository.findOne({
            where: { id },
        });

        if (!timesheet) {
            throw new NotFoundException('Timesheet not found');
        }

        if (timesheet.studentId !== userId) {
            throw new ForbiddenException('Not your timesheet');
        }

        if (timesheet.status === 'verified') {
            throw new BadRequestException('Cannot delete verified timesheets');
        }

        await this.timesheetsRepository.remove(timesheet);

        return {
            success: true,
            message: 'Timesheet deleted successfully',
        };
    }

    // Impact
    async getImpact(userId: string) {
        const timesheets = await this.timesheetsRepository.find({
            where: { studentId: userId, status: 'verified' },
            relations: ['opportunity'],
        });

        const totalHours = timesheets.reduce((sum, t) => sum + t.hours, 0);

        const sdgContributions = timesheets.reduce((acc, t) => {
            const sdg = t.opportunity?.sdg || 'Unknown';
            acc[sdg] = (acc[sdg] || 0) + t.hours;
            return acc;
        }, {});

        // Monthly trend
        const monthlyTrend: Array<{ month: string; hours: number }> = timesheets.reduce((acc, t) => {
            const month = new Date(t.createdAt).toLocaleString('default', { month: 'short' });
            const existing = acc.find(m => m.month === month);
            if (existing) {
                existing.hours += t.hours;
            } else {
                acc.push({ month, hours: t.hours });
            }
            return acc;
        }, [] as Array<{ month: string; hours: number }>);

        return {
            success: true,
            data: {
                totalHours,
                totalBeneficiaries: totalHours * 5, // Estimate
                sdgContributions,
                monthlyTrend,
                certificates: [],
            },
        };
    }

    async getImpactHistory(studentId: string) {
        // Fetch verified timesheets
        const timesheets = await this.timesheetsRepository.find({
            where: { studentId: studentId, status: 'verified' },
            relations: ['opportunity', 'opportunity.organization'],
            order: { createdAt: 'DESC' }
        });

        // 1. Total Hours
        const totalHours = timesheets.reduce((sum, t) => sum + t.hours, 0);

        // 2. Hours this Month
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const hoursThisMonth = timesheets
            .filter(t => new Date(t.createdAt) >= startOfMonth)
            .reduce((sum, t) => sum + t.hours, 0);

        // 3. Projects Completed
        const projectsCompleted = new Set(timesheets.map(t => t.opportunityId)).size;

        // 4. Impact Score (Mock Calculation: hours * 10 + projects * 50)
        const impactScore = (totalHours * 10) + (projectsCompleted * 50);

        // 5. Percentile (Mock: Top X%)
        // in real world, compare with count of all students. 
        const impactPercentile = "Top 10%";

        // 6. Activities List
        const activities = timesheets.map(t => ({
            id: t.id,
            title: t.opportunity?.title || 'Unknown Activity',
            organization: t.opportunity?.organization?.name || 'Unknown Org',
            date: t.createdAt.toISOString().split('T')[0], // YYYY-MM-DD
            hours: t.hours,
            sdg: t.opportunity?.sdg || 'General'
        }));

        return {
            success: true,
            data: {
                total_hours: totalHours,
                hours_this_month: hoursThisMonth,
                projects_completed: projectsCompleted,
                impact_score: impactScore,
                impact_percentile: impactPercentile,
                activities: activities
            }
        };
    }

    // Profile
    async getProfile(userId: string) {
        const user = await this.usersRepository.findOne({
            where: { id: userId },
            relations: ['organization'],
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        return {
            success: true,
            data: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                avatar: user.avatar,
                role: user.role,
                university: user.university,
                major: user.major,
                bio: user.bio,
                interests: user.interests,
                sdgPreferences: user.sdgPreferences,
                joinedDate: user.createdAt,
            },
        };
    }

    async updateProfile(userId: string, dto: UpdateStudentProfileDto) {
        const user = await this.usersRepository.findOne({
            where: { id: userId },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        Object.assign(user, dto);
        await this.usersRepository.save(user);

        return {
            success: true,
            data: user,
        };
    }

    // Settings
    async getSettings(userId: string) {
        // Mock settings for now
        return {
            success: true,
            data: {
                notifications: {
                    email: true,
                    push: false,
                    sms: false,
                },
                privacy: {
                    profileVisibility: 'public',
                    showEmail: false,
                },
                language: 'en',
                theme: 'light',
            },
        };
    }

    async updateSettings(userId: string, settings: any) {
        // Mock implementation
        return {
            success: true,
            data: settings,
        };
    }
}

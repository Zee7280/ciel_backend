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
    // Dashboard
    async getDashboard(userId: string) {
        // 1. Fetch verified timesheets for stats
        const verifiedTimesheets = await this.timesheetsRepository.find({
            where: { studentId: userId, status: 'verified' },
            relations: ['opportunity'],
        });

        // Calculate Stats
        const hoursVolunteered = verifiedTimesheets.reduce((sum, t) => sum + t.hours, 0);
        const projectsCompleted = new Set(verifiedTimesheets.map(t => t.opportunityId)).size;
        // Mock impact points calculation: 10 points per hour
        const impactPoints = hoursVolunteered * 10;

        // 2. Fetch Active Projects (using OpportunityParticipants)
        // Active means status is approved/verified/joined, but not necessarily completed? 
        // For this context, let's say "active" applications that are approved.
        const activeApplications = await this.opportunityParticipantsRepository.find({
            where: {
                studentId: userId,
                status: 'approved' // Assuming 'approved' means currently working on it
            },
            relations: ['opportunity', 'opportunity.organization'],
            take: 5 // Limit to 5 active
        });

        const activeCourses = activeApplications.length;

        const activeProjects = activeApplications.map(app => {
            // Calculate progress based on hours logged vs required
            // This is an estimation. 
            const required = app.opportunity.timeline?.expected_hours || 0;
            // Get hours for this specific opportunity
            // We need to fetch timesheets for these specific opportunities to calc progress correctly, 
            // or we can do a separate query. For efficiency, let's just query all timesheets for this user 
            // once if possible, or just query here.
            // Let's rely on a separate quick count or similar if needed, 
            // but for now let's set progress to 0 if no timesheets found in the loaded verified set.
            const hoursDone = verifiedTimesheets
                .filter(t => t.opportunityId === app.opportunityId)
                .reduce((sum, t) => sum + t.hours, 0);

            let progress = 0;
            if (required > 0) {
                progress = Math.min(100, Math.round((hoursDone / required) * 100));
            }

            return {
                id: app.opportunity.id,
                title: app.opportunity.title,
                category: app.opportunity.sdg_info?.sdg_id || 'General', // Fallback to SDG or verify category field
                assignedAt: app.createdAt.toISOString(),
                status: 'In Progress', // Mapped from app.status
                progress: progress
            };
        });

        // 3. Deadlines
        // Mock logic: deadlines are opportunity end dates
        const deadLinesRaw = activeApplications
            .filter(app => app.opportunity.timeline?.end_date)
            .map(app => ({
                id: app.opportunity.id,
                title: `${app.opportunity.title} Deadline`,
                date: new Date(app.opportunity.timeline.end_date),
                type: 'info' // Default
            }))
            .sort((a, b) => a.date.getTime() - b.date.getTime())
            .slice(0, 3); // Top 3

        const deadlines = deadLinesRaw.map(d => {
            const now = new Date();
            const diffDays = Math.ceil((d.date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            let type = 'info';
            if (diffDays <= 3) type = 'urgent';
            else if (diffDays <= 7) type = 'warning';

            return {
                id: d.id,
                title: d.title,
                date: d.date.toISOString(),
                type
            };
        });

        return {
            success: true,
            data: {
                stats: {
                    activeCourses,
                    impactPoints,
                    projectsCompleted,
                    hoursVolunteered
                },
                activeProjects,
                deadlines
            }
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

        let applicationStatuses = new Map<string, any>();

        if (userId && opportunities.length > 0) {
            const opportunityIds = opportunities.map(o => o.id);
            const applications = await this.opportunityParticipantsRepository
                .createQueryBuilder('participant')
                .leftJoinAndSelect('participant.teamMembers', 'teamMembers')
                .where('participant.studentId = :userId', { userId })
                .andWhere('participant.opportunityId IN (:...opportunityIds)', { opportunityIds })
                .getMany();

            applications.forEach(app => {
                applicationStatuses.set(app.opportunityId, app);
            });
        }

        return {
            success: true,
            data: opportunities.map(o => {
                const app = applicationStatuses.get(o.id);
                return {
                    id: o.id,
                    title: o.title,
                    organization: o.organization?.name || 'Unknown',
                    sdg: o.sdg,
                    location: o.location?.city || 'Unknown',
                    volunteersNeeded: o.timeline?.volunteers_required || 0,
                    description: o.objectives?.description?.substring(0, 150) || 'No description',
                    application_status: app ? app.status : null,
                    // Map status for frontend buttons. "active" is required for "Submit Report".
                    status: (app && (app.status === 'approved' || app.status === 'verified')) ? 'active' : (app ? 'applied' : o.status),
                    teamMembers: app?.teamMembers?.map(member => ({
                        name: member.name,
                        role: member.role,
                        cnic: member.cnic,
                        email: member.email,
                        mobile: member.mobile,
                        university: member.university,
                        is_verified: member.is_verified
                    })) || []
                };
            }),
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

        const formattedProjects = applications.map(app => ({
            id: app.opportunity.id, // Opportunity ID needed for frontend links
            title: app.opportunity.title,
            organization: app.opportunity.organization?.name || 'Unknown',
            description: app.opportunity.objectives?.description,
            // Map status for frontend buttons. "active" is required for "Submit Report".
            status: (app.status === 'approved' || app.status === 'verified') ? 'active' : app.status,
            teamMembers: app.teamMembers?.map(member => ({
                name: member.name,
                role: member.role,
                cnic: member.cnic,
                email: member.email,
                mobile: member.mobile,
                university: member.university,
                is_verified: member.is_verified
            })) || []
        }));

        return {
            success: true,
            data: formattedProjects,
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

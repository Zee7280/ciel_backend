import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { CreateOpportunityDto } from '../opportunities/dto/create-opportunity.dto';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { ApplyOpportunityDto } from './dto/apply-opportunity.dto';
import { LogHoursDto } from './dto/log-hours.dto';
import { UpdateStudentProfileDto } from './dto/update-profile.dto';

import { Participation } from '../engagement/entities/participant.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { Otp } from './entities/otp.entity';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { EngagementService } from '../engagement/engagement.service';
import { OpportunityWorkflowService } from '../opportunities/opportunity-workflow.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';

@Injectable()
export class StudentsService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(Timesheet)
        private timesheetsRepository: Repository<Timesheet>,
        @InjectRepository(Participation)
        private participantRepository: Repository<Participation>,
        @InjectRepository(Organization)
        private orgRepository: Repository<Organization>,
        @InjectRepository(Otp)
        private otpRepository: Repository<Otp>,
        private usersService: UsersService,
        private mailService: MailService,
        private engagementService: EngagementService,
        private readonly opportunityWorkflow: OpportunityWorkflowService,
        private readonly opportunitiesService: OpportunitiesService,
    ) { }

    private normalize(str?: string) {
        return (str || '').trim().toLowerCase();
    }

    private async getOccupiedSeats(opportunityId: string): Promise<number> {
        return await this.participantRepository.count({
            where: {
                projectId: opportunityId,
                status: In(['pending', 'accepted', 'approved', 'verified', 'paid', 'pending_payment_approval', 'pending_ciel_approval', 'pending_faculty_approval'])
            }
        });
    }

    private isEligibleForOpportunity(user: User, opp: Opportunity): boolean {
        const userUniversity = this.normalize(user.university || user.institution || user.orgName);
        const userDept = this.normalize(user.department || user.major);

        // Backward compatibility: restricted_universities
        if (opp.restricted_universities && opp.restricted_universities.length > 0) {
            const allowed = opp.restricted_universities.map(this.normalize);
            if (!allowed.includes(userUniversity)) return false;
        }

        const scope = opp.participation_scope;
        if (!scope) return true;

        const rule = scope.rule;
        const uniNames: string[] = scope.university_names || [];
        const creatorUni = scope.creator_university_name || '';
        const deptScope = scope.department_restriction?.scope || 'all';
        const departments: string[] = scope.department_restriction?.departments || [];

        const uniSet = uniNames.map(this.normalize);
        const creatorNorm = this.normalize(creatorUni);
        const deptSet = departments.map(this.normalize);

        const uniMatch = (names: string[]) => names.includes(userUniversity);
        const deptMatch = deptScope === 'all' || (!!userDept && deptSet.includes(userDept));

        switch (rule) {
            case 'open_all_universities':
                return deptMatch;
            case 'restricted_specific_universities':
                return uniMatch(uniSet) && deptMatch;
            case 'own_university_only':
                return (!!userUniversity && userUniversity === creatorNorm) && deptMatch;
            case 'departments_across_universities':
                return uniMatch(uniSet) && deptMatch;
            case 'own_university_departments':
                return (!!userUniversity && userUniversity === creatorNorm) && deptMatch;
            default:
                return true;
        }
    }
    // Verification
    async sendTeamMemberOtp(email: string) {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Save OTP in DB with 10 mins expiry
        const expiresAt = new Date(Date.now() + 600000);

        // We can either update existing or create new. Given many requests might happen, 
        // let's just create or update if already exists for this email.
        let otpRecord = await this.otpRepository.findOne({ where: { email } });
        if (otpRecord) {
            otpRecord.otp = otp;
            otpRecord.expiresAt = expiresAt;
        } else {
            otpRecord = this.otpRepository.create({ email, otp, expiresAt });
        }

        await this.otpRepository.save(otpRecord);
        await this.mailService.sendTeamMemberOtp(email, otp);

        return { success: true, message: 'OTP sent successfully' };
    }

    async confirmTeamMemberOtp(email: string, otp: string) {
        const record = await this.otpRepository.findOne({
            where: { email, otp }
        });

        if (!record) {
            throw new BadRequestException('Invalid OTP');
        }

        if (record.expiresAt < new Date()) {
            throw new BadRequestException('OTP has expired');
        }

        // Success! We can delete the OTP record now to prevent reuse
        await this.otpRepository.remove(record);

        return { success: true, message: 'Email verified' };
    }

    async sendTeamMemberVerification(email: string) {
        // 1. You can check if the user is already registered (optional)
        // 2. Call MailService to send the email
        await this.mailService.sendTeamMemberInvite(email);
        return { success: true, message: 'Verification email sent' };
    }

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

        // 2. Fetch Active Projects (using Participations)
        const activeApplications = await this.participantRepository.find({
            where: {
                studentId: userId,
                status: In(['approved', 'verified', 'paid', 'pending_ciel_approval', 'pending_faculty_approval', 'accepted'])
            },
            relations: ['project', 'project.organization'],
            take: 5
        });

        const activeCourses = activeApplications.length;

        const activeProjects = activeApplications.map(app => {
            const required = app.project.timeline?.expected_hours || 0;
            const hoursDone = verifiedTimesheets
                .filter(t => t.opportunityId === app.projectId)
                .reduce((sum, t) => sum + t.hours, 0);

            let progress = 0;
            if (required > 0) {
                progress = Math.min(100, Math.round((hoursDone / required) * 100));
            }

            return {
                id: app.projectId,
                title: app.project.title,
                category: app.project.sdg_info?.sdg_id || 'General',
                assignedAt: app.createdAt.toISOString(),
                status: 'In Progress',
                progress: progress
            };
        });

        // 3. Deadlines
        const deadLinesRaw = activeApplications
            .filter(app => app.project.timeline?.end_date)
            .map(app => ({
                id: app.projectId,
                title: `${app.project.title} Deadline`,
                date: new Date(app.project.timeline.end_date),
                type: 'info'
            }))
            .sort((a, b) => a.date.getTime() - b.date.getTime())
            .slice(0, 3);

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

    async getOpportunities(query: any, userId?: string) {
        const { sdg, location, type, status, page = 1, limit = 10 } = query;
        const skip = (page - 1) * limit;

        let filterStatus = status || 'active';
        if (filterStatus === 'approved') {
            filterStatus = 'active';
        }

        const whereClause: any = { status: filterStatus };
        if (filterStatus === 'active') {
            whereClause.admin_approved = true;
        }
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
        const user = userId ? await this.usersRepository.findOne({ where: { id: userId } }) : null;

        if (userId && opportunities.length > 0) {
            const opportunityIds = opportunities.map(o => o.id);
            const applications = await this.participantRepository.find({
                where: {
                    studentId: userId,
                    projectId: In(opportunityIds)
                }
            });

            applications.forEach(app => {
                applicationStatuses.set(app.projectId, app);
            });
        }

        const filtered = user ? opportunities.filter(o => this.isEligibleForOpportunity(user, o)) : opportunities;

        return {
            success: true,
            data: await Promise.all(filtered.map(async o => {
                const app = applicationStatuses.get(o.id);
                const occupiedSeats = await this.getOccupiedSeats(o.id);
                const volunteersRequired = o.timeline?.volunteers_required || 0;

                return {
                    ...o,
                    organization: o.organization?.name || 'Unknown',
                    volunteersNeeded: volunteersRequired,
                    remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
                    description: o.objectives?.description || 'No description',
                    application_status: app ? app.status : null,
                    payment_status: app ? app.paymentStatus : null,
                    payment_proof_url: app ? app.paymentProofUrl : null,
                    // Map status for frontend buttons. "active" is required for "Submit Report".
                    status: (app && (app.status === 'approved' || app.status === 'verified')) ? 'active' : (app ? 'applied' : o.status),
                    teamMembers: [] // We no longer fetch team members in a list view for performance, or we can fetch them if needed.
                };
            })),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
            },
        };
    }

    async getOpportunityById(id: string, userId?: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id, status: 'active', admin_approved: true },
            relations: ['organization'],
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        let applicationStatus: string | null = null;
        let paymentStatus: string | null = null;
        let paymentProofUrl: string | null = null;
        let hasApplied = false;

        if (userId) {
            const application = await this.participantRepository.findOne({
                where: {
                    studentId: userId,
                    projectId: id,
                },
            });

            if (application) {
                applicationStatus = application.status;
                paymentStatus = application.paymentStatus;
                paymentProofUrl = application.paymentProofUrl;
                hasApplied = true;
            }
        }

        const occupiedSeats = await this.getOccupiedSeats(id);
        const volunteersRequired = opportunity.timeline?.volunteers_required || 0;

        return {
            success: true,
            data: {
                ...opportunity,
                application_status: applicationStatus,
                payment_status: paymentStatus,
                payment_proof_url: paymentProofUrl,
                hasApplied: hasApplied,
                remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
                // Also map status for report button visibility
                status: (applicationStatus === 'approved' || applicationStatus === 'verified') ? 'active' : (hasApplied ? 'applied' : opportunity.status)
            },
        };
    }

    async getRecommendedOpportunities(userId: string) {
        // Simple implementation - can be enhanced with ML
        const opportunities = await this.opportunitiesRepository.find({
            where: { status: 'active', admin_approved: true },
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
        const applications = await this.participantRepository.find({
            where: { studentId },
            relations: ['project', 'project.organization'],
            order: { createdAt: 'DESC' },
        });

        const appliedIds = new Set(applications.map((a) => a.projectId));

        const createdOpportunities = await this.opportunitiesRepository.find({
            where: { creatorId: studentId },
            relations: ['organization'],
            order: { createdAt: 'DESC' },
        });

        const ownNotApplied = createdOpportunities.filter((o) => !appliedIds.has(o.id));

        const fromCreator = ownNotApplied.map((opp) =>
            this.opportunityWorkflow.toStudentProjectCard(opp, { teamMembers: [] }),
        );

        const fromParticipants = await Promise.all(
            applications.map(async (app) => {
                const teamMembers = app.applicationId
                    ? (
                          await this.participantRepository.find({
                              where: { applicationId: app.applicationId },
                          })
                      ).map((m) => ({
                          name: m.fullName,
                          email: m.email,
                          mobile: m.mobile,
                          university: m.universityName,
                          is_verified: true,
                      }))
                    : [];

                const base = this.opportunityWorkflow.toStudentProjectCard(app.project, { teamMembers });
                const participationStatus =
                    app.status === 'approved' || app.status === 'verified' ? 'active' : app.status;

                return {
                    ...base,
                    status: participationStatus,
                    organization: app.project.organization?.name || 'Unknown',
                    payment_status: app.paymentStatus,
                    payment_proof_url: app.paymentProofUrl,
                };
            }),
        );

        return {
            success: true,
            data: [...fromCreator, ...fromParticipants],
        };
    }

    async getProjectById(opportunityId: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId },
            relations: ['organization'],
        });

        if (!opportunity) {
            throw new NotFoundException(`Project with ID ${opportunityId} not found`);
        }

        return {
            success: true,
            data: {
                id: opportunity.id,
                title: opportunity.title,
                organization: opportunity.organization?.name || 'Unknown',
                organizationId: opportunity.organizationId,
                logoUrl: opportunity.organization?.logoUrl || null,
                status: opportunity.status,
                mode: opportunity.mode,
                types: opportunity.types,
                location: opportunity.location,
                timeline: opportunity.timeline,
                sdg_info: opportunity.sdg_info,
                objectives: opportunity.objectives,
                activity_details: opportunity.activity_details,
                supervision: opportunity.supervision,
                verification_method: opportunity.verification_method,
                createdAt: opportunity.createdAt,
                updatedAt: opportunity.updatedAt,
            }
        };
    }

    async createStudentOpportunity(userId: string, dto: CreateOpportunityDto) {
        // Single CIEL workflow (faculty token + stages); avoids duplicate liaison-only rows that never sync with the dashboard.
        const result = await this.opportunitiesService.createStudentOpportunity(userId, dto);
        return {
            ...result,
            message: 'Opportunity submitted successfully',
        };
    }

    async updateStudentOpportunity(userId: string, opportunityId: string, dto: Partial<CreateOpportunityDto>) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId },
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        if (opportunity.creatorId !== userId) {
            throw new ForbiddenException('You do not have access to this opportunity');
        }

        if (opportunity.admin_approved || opportunity.status === 'active') {
            throw new BadRequestException('Approved opportunities cannot be updated');
        }

        const patchableFields: (keyof CreateOpportunityDto)[] = [
            'title',
            'types',
            'mode',
            'student_contact',
            'location',
            'timeline',
            'sdg_info',
            'secondary_sdgs',
            'objectives',
            'activity_details',
            'supervision',
            'verification_method',
            'visibility',
            'restricted_universities',
            'executing_context',
            'safety_declaration',
            'submission_confirmations',
            'participation_scope',
            'executing_organization',
            'partner_organization',
            'safety_supervision_declaration',
            'visibility_and_academic_linkage',
            'external_partner_collaboration',
            'academic_linkage',
        ];

        const patch: Partial<Opportunity> = {};
        for (const field of patchableFields) {
            const value = dto[field];
            if (value !== undefined) {
                patch[field as keyof Opportunity] = value as Opportunity[keyof Opportunity];
            }
        }

        const nextRestricted =
            dto.restricted_universities && dto.restricted_universities.length > 0
                ? dto.restricted_universities
                : dto.participation_scope?.creator_university_name
                    ? [dto.participation_scope.creator_university_name]
                    : undefined;

        if (nextRestricted !== undefined) {
            patch.restricted_universities = nextRestricted;
        }

        Object.assign(opportunity, patch);

        if (dto.sdg_info) {
            opportunity.sdg = dto.sdg_info.sdg_id || opportunity.sdg;
        }

        const saved = await this.opportunitiesRepository.save(opportunity);

        return {
            success: true,
            data: saved,
            message: 'Opportunity updated successfully',
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
        if (opportunity.status !== 'active' || !opportunity.admin_approved) {
            throw new BadRequestException('This opportunity is not open for applications yet');
        }

        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');
        if (!this.isEligibleForOpportunity(user, opportunity)) {
            throw new ForbiddenException('You are not eligible to apply for this opportunity');
        }

        // Check if already applied
        const existing = await this.participantRepository.findOne({
            where: {
                studentId: userId,
                projectId: dto.opportunityId,
            },
        });

        if (existing) {
            throw new BadRequestException('Already applied to this opportunity');
        }

        const applicationId = crypto.randomUUID();

        // 1. Register Lead
        let leadParticipation;
        if (user) {
            leadParticipation = await this.engagementService.preRegister(userId, dto.opportunityId, {
                applicationId,
                fullName: user.name,
                email: user.email,
                mobile: user.phone || '',
                cnic: user.cnic || '',
                universityName: user.university || '',
                universityId: user.university || '',
                academicProgram: user.major || '',
                yearOfStudy: '1st Year',
                department: 'Other',
                academicIntegrationType: 'Voluntary',
                participationMode: dto.participation_type || 'individual',
                isTeamLead: true,
                emailVerified: true,
                mobileVerified: true,
                status: 'pending', // Initial status for application
                primaryFacultyEmail: dto.primary_faculty_email,
                secondaryFacultyEmail: dto.secondary_faculty_email,
                teamId: dto.team_id,
            } as any);

            // Send Notifications
            if (dto.primary_faculty_email) {
                await this.mailService.sendFacultyApprovalRequest(
                    dto.primary_faculty_email,
                    user.name,
                    opportunity.title,
                    leadParticipation.id
                );
            }

            if (dto.secondary_faculty_email) {
                await this.mailService.sendFacultyCollaboratorNotice(
                    dto.secondary_faculty_email,
                    user.name,
                    opportunity.title
                );
            }

            await this.mailService.sendApplicationSubmitted(
                user.email,
                user.name,
                opportunity.title
            );
        }

        // 2. Register Team Members
        if (dto.participation_type === 'team' && dto.team_members && dto.team_members.length > 0) {
            for (const m of dto.team_members) {
                const memberUser = await this.usersService.findByEmail(m.email);
                await this.engagementService.preRegister(memberUser?.id || null, dto.opportunityId, {
                    applicationId,
                    fullName: m.name,
                    email: m.email,
                    mobile: m.mobile || '',
                    cnic: m.cnic || '',
                    universityName: m.university || '',
                    universityId: m.university || '',
                    academicProgram: m.program || '',
                    yearOfStudy: '1st Year',
                    department: 'Other',
                    academicIntegrationType: 'Voluntary',
                    participationMode: 'team',
                    isTeamLead: false,
                    emailVerified: true,
                    mobileVerified: true,
                    status: 'approved', // Auto-approved for verified members added by lead?
                    teamId: dto.team_id,
                    primaryFacultyEmail: dto.primary_faculty_email,
                } as any);
            }
        }

        return {
            success: true,
            data: leadParticipation,
            message: 'Application submitted successfully',
        };
    }

    async withdrawApplication(userId: string, id: string) {
        const application = await this.participantRepository.findOne({
            where: { id, studentId: userId },
        });

        if (!application) {
            throw new NotFoundException('Application not found');
        }

        if (application.status !== 'pending') {
            throw new BadRequestException('Can only withdraw pending applications');
        }

        await this.participantRepository.remove(application);

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

    async getReports(userId: string, organisationId: string) {
        // Find all applications/participants for this user in opportunities from this organisation
        const activeApplications = await this.participantRepository.find({
            where: {
                studentId: userId,
                project: {
                    organizationId: organisationId
                }
            },
            relations: ['project', 'project.organization']
        });

        // Fetch verified timesheets for these opportunities
        const verifiedTimesheets = await this.timesheetsRepository.find({
            where: { studentId: userId, status: 'verified' },
            relations: ['opportunity']
        });

        // Format data
        const reports = activeApplications.map(app => {
            const requiredHours = app.project.timeline?.expected_hours || 0;
            const hoursDone = verifiedTimesheets
                .filter(t => t.opportunityId === app.projectId)
                .reduce((sum, t) => sum + t.hours, 0);

            // Determine report status based on hours
            let reportStatus = 'Pending';
            if (hoursDone >= requiredHours && requiredHours > 0) reportStatus = 'Completed';
            else if (hoursDone > 0) reportStatus = 'In Progress';

            return {
                id: app.id,
                opportunityId: app.project.id,
                projectName: app.project.title,
                startDate: app.createdAt,
                endDate: app.project.timeline?.end_date || null,
                totalHours: hoursDone,
                requiredHours: requiredHours,
                status: reportStatus,
                partnerName: app.project.organization?.name || 'Unknown Partner',
                partnerLogo: app.project.organization?.logoUrl || null,
                certificateUrl: null, // Logic for certificate can go here
            };
        });

        return {
            success: true,
            data: reports
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
            data: this.usersService.formatUserResponse(user),
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
            data: this.usersService.formatUserResponse(user),
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

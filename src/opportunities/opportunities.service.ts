import { Injectable, NotFoundException, ForbiddenException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DeepPartial } from 'typeorm';
import { Opportunity } from './entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto/create-opportunity.dto';
import { OrganizationsService } from '../organizations/organizations.service';
import { EngagementService } from '../engagement/engagement.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { MailService } from '../mail/mail.service';
import { randomUUID } from 'crypto';

@Injectable()
export class OpportunitiesService {
    constructor(
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(Participation)
        private participationRepository: Repository<Participation>,
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        private organizationsService: OrganizationsService,
        private engagementService: EngagementService,
        private mailService: MailService,
    ) { }

    private isValidEmail(email?: string) {
        if (!email) return false;
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    }

    private validateSafetyDeclaration(safety?: any) {
        if (!safety) throw new BadRequestException('safety_declaration is required');
        const keys = [
            'environment_safe_and_appropriate',
            'students_guided_and_supervised',
            'lawful_ethical_and_non_hazardous',
            'precautions_and_basic_safety'
        ];
        const allTrue = keys.every(k => safety[k] === true);
        if (!allTrue) {
            throw new BadRequestException('All safety_declaration checks must be true');
        }
    }

    private validateSubmissionConfirmations(confirm?: any) {
        if (!confirm) throw new BadRequestException('submission_confirmations are required');
        const keys = [
            'academically_valid_and_accurately_described',
            'activity_properly_supervised',
            'environment_safe_and_appropriate',
            'information_correct_and_verifiable'
        ];
        if (!keys.every(k => confirm[k] === true)) {
            throw new BadRequestException('All submission_confirmations must be true');
        }
    }

    private validateParticipationScope(scope?: any) {
        if (!scope) return; // backward compatibility
        const rule = scope.rule;
        if (!rule) throw new BadRequestException('participation_scope.rule is required');
        const uniNames: string[] = scope.university_names || [];
        const creatorUni = scope.creator_university_name || '';
        const deptScope = scope.department_restriction?.scope || 'all';
        const departments: string[] = scope.department_restriction?.departments || [];

        const needDepts = ['departments_across_universities', 'own_university_departments'].includes(rule) || deptScope === 'specific';
        if (needDepts && (!departments || departments.length === 0)) {
            throw new BadRequestException('Department list required for department-specific participation_scope');
        }

        const needUniList = ['restricted_specific_universities', 'departments_across_universities'].includes(rule);
        if (needUniList && uniNames.length === 0) {
            throw new BadRequestException('University list required for participation_scope.rule');
        }

        if (rule === 'own_university_only' && creatorUni && uniNames.length === 0) {
            scope.university_names = [creatorUni];
        }
        if (rule === 'own_university_departments' && creatorUni && uniNames.length === 0) {
            scope.university_names = [creatorUni];
        }
    }

    private validateSupervision(supervision: any) {
        if (!supervision) return;
        if (supervision.contact && !this.isValidEmail(supervision.contact)) {
            throw new BadRequestException('supervision.contact must be a valid email');
        }
        if (supervision.external_partner_email && !this.isValidEmail(supervision.external_partner_email)) {
            throw new BadRequestException('supervision.external_partner_email must be a valid email');
        }
    }

    private validateExternalPartner(collab?: any) {
        if (!collab) return;
        const { organization_name, contact_person, official_email } = collab;
        if (!organization_name || !contact_person || !official_email) {
            throw new BadRequestException('external_partner_collaboration requires organization_name, contact_person, official_email');
        }
        if (!this.isValidEmail(official_email)) {
            throw new BadRequestException('external_partner_collaboration.official_email must be valid');
        }
    }

    async getOccupiedSeats(opportunityId: string): Promise<number> {
        return await this.participationRepository.count({
            where: {
                projectId: opportunityId,
                status: In(['pending', 'accepted', 'approved', 'verified', 'paid', 'pending_payment_approval', 'pending_ciel_approval', 'pending_faculty_approval'])
            }
        });
    }

    private async getFacultyOrgFallback(facultyId?: string | null) {
        if (!facultyId) return null;
        const faculty = await this.usersRepository.findOne({ where: { id: facultyId } });
        if (!faculty) return null;
        return {
            id: null,
            name: faculty.institution || faculty.university || faculty.name,
            logo_url: null
        };
    }

    async create(userId: string, createOpportunityDto: CreateOpportunityDto) {
        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new ForbiddenException('User not found');
        }

        this.validateSupervision(createOpportunityDto.supervision);
        this.validateSafetyDeclaration(createOpportunityDto.safety_declaration);
        this.validateSubmissionConfirmations(createOpportunityDto.submission_confirmations);
        this.validateParticipationScope(createOpportunityDto.participation_scope);
        this.validateExternalPartner(createOpportunityDto.external_partner_collaboration);

        const org = await this.organizationsService.getMyOrganization(userId);

        if (!org && user.role !== UserRole.FACULTY) {
            throw new ForbiddenException('User must belong to an organization to create opportunities');
        }

        const executionVerificationToken = createOpportunityDto.executing_organization?.official_email ? randomUUID() : null;

        const payload: DeepPartial<Opportunity> = {
            ...createOpportunityDto,
            organizationId: org?.id || null,
            facultyId: user.role === UserRole.FACULTY ? user.id : null,
            creatorId: user.id,
            status: createOpportunityDto.admin_approval_required ? 'pending_approval' : 'pending_execution',
            execution_verification_token: executionVerificationToken,
            execution_verified: false,
            execution_verification_status: executionVerificationToken ? 'pending_execution' : 'execution_verified',
            sdg: createOpportunityDto.sdg_info?.sdg_id || 'SDG', // Fallback
        };

        const opportunity = this.opportunitiesRepository.create(payload);

        const saved = await this.opportunitiesRepository.save(opportunity);

        // send executing org verification email if provided
        if (executionVerificationToken && createOpportunityDto.executing_organization?.official_email) {
            const verifyBase = process.env.FRONTEND_URL || process.env.APP_URL || '';
            const link = `${verifyBase}/verify/executing-org?token=${executionVerificationToken}`;
            try {
                await this.mailService.sendPasswordResetEmail(createOpportunityDto.executing_organization.official_email, link);
            } catch (e) {
                console.warn('Failed to send executing org verification email', e.message);
            }
        }

        // optional partner email
        const partnerEmail = createOpportunityDto.partner_organization?.official_email;
        if (partnerEmail) {
            try {
                await this.mailService.sendPasswordResetEmail(partnerEmail, `Partner confirmation requested for ${saved.title}`);
            } catch (e) {
                console.warn('Failed to send partner org email', e.message);
            }
        }

        return saved;
    }

    async createStudentOpportunity(userId: string, dto: CreateOpportunityDto) {
        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) throw new ForbiddenException('User not found');
        // validation rules for student flow
        if (!dto.supervision?.contact) throw new BadRequestException('Faculty email (supervision.contact) is required');
        if (!dto.supervision?.faculty_department) throw new BadRequestException('faculty_department is required');
        if (!dto.executing_context?.type) throw new BadRequestException('executing_context.type is required');
        this.validateSafetyDeclaration(dto.safety_declaration);
        this.validateSubmissionConfirmations(dto.submission_confirmations);
        this.validateParticipationScope(dto.participation_scope);
        this.validateSupervision(dto.supervision);

        if (dto.executing_context.type === 'partner') {
            const partner = dto.executing_context.partner || {};
            if (!partner.official_email) throw new BadRequestException('partner official_email required for partner context');
        } else if (dto.executing_context.type === 'independent') {
            const ind = dto.executing_context.independent_community_activity || {};
            if (!ind.activity_site_description) throw new BadRequestException('independent activity_site_description required');
        }

        const restricted = dto.restricted_universities && dto.restricted_universities.length > 0
            ? dto.restricted_universities
            : (dto.participation_scope?.creator_university_name ? [dto.participation_scope.creator_university_name] : []);

        const payload: DeepPartial<Opportunity> = {
            ...dto,
            organizationId: null,
            facultyId: null,
            creatorId: user.id,
            status: 'pending_faculty',
            sdg: dto.sdg_info?.sdg_id || 'SDG',
            restricted_universities: restricted,
            visibility: dto.visibility || 'restricted',
            faculty_verification_status: 'pending_faculty',
            faculty_verified: false,
            faculty_verification_token: randomUUID()
        };

        const opportunity = await this.opportunitiesRepository.save(this.opportunitiesRepository.create(payload));

        // send faculty email
        const verifyBase = process.env.FRONTEND_URL || process.env.APP_URL || '';
        const link = `${verifyBase}/verify/faculty?token=${opportunity.faculty_verification_token}`;
        try {
            await this.mailService.sendPasswordResetEmail(dto.supervision.contact, link); // reuse template
        } catch (e) {
            console.warn('Failed to send faculty verification email', e.message);
        }

        // optional partner email
        const partnerEmail = dto.executing_context.type === 'partner' ? dto.executing_context.partner?.official_email : null;
        if (partnerEmail) {
            try {
                await this.mailService.sendPasswordResetEmail(partnerEmail, link);
            } catch (e) {
                console.warn('Failed to send partner email', e.message);
            }
        }

        return { success: true, data: opportunity };
    }

    async update(userId: string, updateOpportunityDto: UpdateOpportunityDto, organizationId?: string) {
        let orgId = organizationId;

        if (!orgId) {
            const org = await this.organizationsService.getMyOrganization(userId);
            orgId = org?.id;
        }

        if (!orgId) {
            throw new ForbiddenException('User must belong to an organization to update opportunities');
        }

        const opportunity = await this.opportunitiesRepository.findOne({ where: { id: updateOpportunityDto.id } });
        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        if (opportunity.organizationId !== orgId) {
            console.log(`Access Denied: Org ID mismatch. UserOrg: ${orgId}, OpportunityOrg: ${opportunity.organizationId}`);
            throw new ForbiddenException('You do not have access to this opportunity');
        }

        // Update fields
        Object.assign(opportunity, updateOpportunityDto);

        // Handle nested object updates if necessary, but Object.assign handles replacement of top-level properties which seems to be what we want given the DTO structure.
        // Use fallback for sdg if sdg_info is updated
        if (updateOpportunityDto.sdg_info) {
            opportunity.sdg = updateOpportunityDto.sdg_info.sdg_id || opportunity.sdg;
        }

        return this.opportunitiesRepository.save(opportunity);
    }

    async findAll(userId: string, filters: any) {
        const org = await this.organizationsService.getMyOrganization(userId);
        const query = this.opportunitiesRepository.createQueryBuilder('opportunity');

        let filterOrgId: string | null = null;

        if (filters.partner_id === 'me' && org) {
            filterOrgId = org.id;
        } else if (filters.partner_id && filters.partner_id !== 'me') {
            // Check if it's already an org ID
            try {
                const checkOrg = await this.organizationsService.findOne(filters.partner_id);
                filterOrgId = checkOrg.id;
            } catch (e) {
                // Not an org ID, maybe it's a User ID?
                const checkUserOrg = await this.organizationsService.getMyOrganization(filters.partner_id);
                if (checkUserOrg) {
                    filterOrgId = checkUserOrg.id;
                }
            }
        }

        if (filterOrgId) {
            query.andWhere('opportunity.organizationId = :orgId', { orgId: filterOrgId });
        }

        if (filters.status) {
            query.andWhere('opportunity.status = :status', { status: filters.status });
        }

        if (filters.limit) {
            query.take(filters.limit);
        }

        const opportunities = await query.getMany();

        return Promise.all(opportunities.map(async opp => {
            const occupiedSeats = await this.getOccupiedSeats(opp.id);
            const volunteersRequired = opp.timeline?.volunteers_required || 0;
            const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;

            return {
                ...opp,
                location: opp.location,
                start_date: opp.timeline?.start_date,
                end_date: opp.timeline?.end_date,
                from_time: opp.timeline?.from_time,
                to_time: opp.timeline?.to_time,
                dates: opp.timeline ? { end: opp.timeline.end_date } : null,
                capacity: opp.timeline ? {
                    volunteers: volunteersRequired,
                    remaining_seats: Math.max(0, volunteersRequired - occupiedSeats)
                } : null,
                applicants_count: occupiedSeats,
                participation_scope: opp.participation_scope,
                executing_context: opp.executing_context,
                executing_organization: opp.executing_organization,
                partner_organization: opp.partner_organization,
                safety_supervision_declaration: opp.safety_supervision_declaration,
                safety_declaration: opp.safety_declaration,
                visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
                submission_confirmations: opp.submission_confirmations,
                external_partner_collaboration: opp.external_partner_collaboration,
                academic_linkage: opp.academic_linkage,
                organization: opp.organization || orgFallback
            };
        }));
    }

    async getPublicOpportunities(filters: any = {}) {
        const query: any = { status: In(['active', 'pending_approval']) };

        if (filters.partner_id) {
            let filterOrgId = filters.partner_id;
            // Resolve if it's a user ID
            const checkUserOrg = await this.organizationsService.getMyOrganization(filters.partner_id);
            if (checkUserOrg) {
                filterOrgId = checkUserOrg.id;
            }
            query.organizationId = filterOrgId;
        }

        const opportunities = await this.opportunitiesRepository.find({
            where: query,
            relations: ['organization'],
            order: { createdAt: 'DESC' }
        });

        // We need to count participants for each opportunity
        const opportunitiesWithCounts = await Promise.all(opportunities.map(async (opp) => {
            const occupiedSeats = await this.getOccupiedSeats(opp.id);
            const volunteersRequired = opp.timeline?.volunteers_required || 0;
            const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;

            return {
                id: opp.id,
                title: opp.title,
                description: opp.objectives?.description || '',
                types: opp.types,
                sdg_info: opp.sdg_info,
                participant_count: occupiedSeats,
                remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
                status: opp.status,
                location: opp.location,
                start_date: opp.timeline?.start_date,
                end_date: opp.timeline?.end_date,
                from_time: opp.timeline?.from_time,
                to_time: opp.timeline?.to_time,
                participation_scope: opp.participation_scope,
                executing_context: opp.executing_context,
                executing_organization: opp.executing_organization,
                partner_organization: opp.partner_organization,
                safety_supervision_declaration: opp.safety_supervision_declaration,
                safety_declaration: opp.safety_declaration,
                visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
                submission_confirmations: opp.submission_confirmations,
                external_partner_collaboration: opp.external_partner_collaboration,
                academic_linkage: opp.academic_linkage,
                organization: opp.organization ? {
                    id: opp.organization?.id,
                    name: opp.organization?.name,
                    logo_url: opp.organization?.logoUrl
                } : orgFallback
            };
        }));

        return opportunitiesWithCounts;
    }

    async getPublicOpportunityById(id: string) {
        const opp = await this.opportunitiesRepository.findOne({
            where: {
                id,
                status: In(['active', 'pending_approval'])
            },
            relations: ['organization']
        });

        if (!opp) {
            throw new NotFoundException('Opportunity not found or not public');
        }

        const occupiedSeats = await this.getOccupiedSeats(opp.id);
        const volunteersRequired = opp.timeline?.volunteers_required || 0;
        const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;

        return {
            id: opp.id,
            title: opp.title,
            description: opp.objectives?.description || '',
            types: opp.types,
            sdg_info: opp.sdg_info,
            participant_count: occupiedSeats,
            remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
            status: opp.status,
            location: opp.location,
            start_date: opp.timeline?.start_date,
            end_date: opp.timeline?.end_date,
            from_time: opp.timeline?.from_time,
            to_time: opp.timeline?.to_time,
            participation_scope: opp.participation_scope,
            executing_context: opp.executing_context,
            executing_organization: opp.executing_organization,
            partner_organization: opp.partner_organization,
            safety_supervision_declaration: opp.safety_supervision_declaration,
            safety_declaration: opp.safety_declaration,
            visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
            submission_confirmations: opp.submission_confirmations,
            external_partner_collaboration: opp.external_partner_collaboration,
            academic_linkage: opp.academic_linkage,
            organization: opp.organization ? {
                id: opp.organization?.id,
                name: opp.organization?.name,
                logo_url: opp.organization?.logoUrl
            } : orgFallback
        };
    }

    async findOne(id: string) {
        return this.opportunitiesRepository.findOne({ where: { id }, relations: ['organization'] });
    }

    // Admin methods
    async findAllPending() {
        const opportunities = await this.opportunitiesRepository.find({
            where: { status: 'pending_approval' },
            relations: ['organization'],
            order: { createdAt: 'DESC' }
        });

        return Promise.all(opportunities.map(async opp => {
            const occupiedSeats = await this.getOccupiedSeats(opp.id);
            const volunteersRequired = opp.timeline?.volunteers_required || 0;
            const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;

            return {
                ...opp,
                start_date: opp.timeline?.start_date,
                end_date: opp.timeline?.end_date,
                from_time: opp.timeline?.from_time,
                to_time: opp.timeline?.to_time,
                remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
                participant_count: occupiedSeats,
                participation_scope: opp.participation_scope,
                executing_context: opp.executing_context,
                executing_organization: opp.executing_organization,
                partner_organization: opp.partner_organization,
                safety_supervision_declaration: opp.safety_supervision_declaration,
                safety_declaration: opp.safety_declaration,
                visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
                submission_confirmations: opp.submission_confirmations,
                external_partner_collaboration: opp.external_partner_collaboration,
                academic_linkage: opp.academic_linkage,
                execution_verified: opp.execution_verified,
                admin_approved: opp.admin_approved,
                organization: opp.organization || orgFallback
            };
        }));
    }

    async approve(id: string) {
        const opp = await this.findOne(id);
        if (!opp) throw new NotFoundException('Opportunity not found');
        opp.admin_approved = true;
        opp.partnerVerified = true; // keep legacy behavior
        opp.status = opp.execution_verified ? 'active' : 'pending_execution';
        return this.opportunitiesRepository.save(opp);
    }

    async reject(id: string, reason: string) {
        const opp = await this.findOne(id);
        if (!opp) throw new NotFoundException('Opportunity not found');
        opp.status = 'rejected';
        // Store reason? Maybe in a new field or just log it for now as spec doesn't show where to store it on entity
        return this.opportunitiesRepository.save(opp);
    }

    async remove(id: string) {
        const result = await this.opportunitiesRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`Opportunity with ID "${id}" not found`);
        }
        return { success: true, message: 'Opportunity deleted successfully' };
    }

    // Partner methods for managing applicants
    async getApplicantsForOpportunity(opportunityId: string, organizationId: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId }
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        if (opportunity.organizationId !== organizationId) {
            throw new ForbiddenException('You do not have access to this opportunity');
        }

        const participants = await this.participationRepository.find({
            where: { projectId: opportunityId },
            relations: ['student'],
            order: { createdAt: 'DESC' }
        });

        // Group by Application ID to show team structure if needed, or just list everyone
        return await Promise.all(participants.map(async p => ({
            id: p.id,
            studentName: p.fullName || p.student?.name || 'Unknown',
            university: p.universityName || p.student?.institution || 'N/A',
            email: p.email || p.student?.email || 'N/A',
            status: p.status,
            appliedAt: p.createdAt,
            avatar: p.student?.avatar || null,
            participation_type: p.participationMode,
            isTeamLead: p.isTeamLead,
            teamMembers: p.isTeamLead && p.applicationId ? (await this.participationRepository.find({
                where: { applicationId: p.applicationId, isTeamLead: false }
            })).map(m => ({
                id: m.id,
                name: m.fullName,
                email: m.email,
                university: m.universityName,
                role: 'Member',
                is_verified: true
            })) : []
        })));
    }

    async getOrganizationParticipants(organizationId: string) {
        const participants = await this.participationRepository.find({
            where: {
                project: { organizationId },
                status: In(['accepted', 'approved', 'verified', 'finalized'])
            },
            relations: ['student', 'project'],
            order: { createdAt: 'DESC' }
        });

        return participants.map(p => ({
            id: p.id,
            name: p.fullName || p.student?.name || 'Unknown student',
            opportunity: p.project?.title || 'Unknown Opportunity',
            joinedDate: p.createdAt.toLocaleDateString(),
            hours: 0,
            status: p.status === 'accepted' ? 'Active' : (p.status === 'verified' ? 'Completed' : p.status),
            participation_type: p.participationMode,
            is_leader: p.isTeamLead
        }));
    }

    async updateApplicantStatus(applicantId: string, status: string, organizationId: string) {
        const participant = await this.participationRepository.findOne({
            where: { id: applicantId },
            relations: ['project', 'student']
        });

        if (!participant) {
            throw new NotFoundException('Applicant not found');
        }

        if (participant.project.organizationId !== organizationId) {
            throw new ForbiddenException('You do not have access to this applicant');
        }

        participant.status = status;
        await this.participationRepository.save(participant);

        return { success: true, message: 'Applicant status updated successfully' };
    }

    async verifyOpportunityToken(token: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: [
                { liaisonToken: token },
                { partnerToken: token }
            ]
        });

        if (!opportunity) {
            throw new NotFoundException('Invalid or expired verification token.');
        }

        let verifiedRole = '';

        if (opportunity.liaisonToken === token && !opportunity.liaisonVerified) {
            opportunity.liaisonVerified = true;
            verifiedRole = 'Liaison';
        } else if (opportunity.partnerToken === token && !opportunity.partnerVerified) {
            opportunity.partnerVerified = true;
            verifiedRole = 'Partner';
        } else {
            return {
                success: true,
                message: 'This component of the project has already been verified.'
            };
        }

        // Check if both are now verified
        if (opportunity.liaisonVerified && opportunity.partnerVerified) {
            opportunity.status = 'active';
        }

        await this.opportunitiesRepository.save(opportunity);

        return {
            success: true,
            data: {
                title: opportunity.title,
                isFullyVerified: opportunity.status === 'active'
            },
            message: `${verifiedRole} verification successful.`
        };
    }

    async verifyExecutingOrganization(token: string) {
        const opp = await this.opportunitiesRepository.findOne({ where: { execution_verification_token: token } });
        if (!opp) throw new NotFoundException('Invalid or expired execution verification token');
        opp.execution_verified = true;
        opp.execution_verification_status = 'execution_verified';
        if (opp.admin_approved) {
            opp.status = 'active';
        } else {
            opp.status = 'pending_approval';
        }
        await this.opportunitiesRepository.save(opp);
        return { success: true, message: 'Executing organization verified', data: { id: opp.id, status: opp.status } };
    }

    async verifyFaculty(token: string) {
        const opp = await this.opportunitiesRepository.findOne({ where: { faculty_verification_token: token } });
        if (!opp) throw new NotFoundException('Invalid or expired faculty verification token');
        opp.faculty_verified = true;
        opp.faculty_verification_status = 'faculty_verified';
        if (opp.status === 'pending_faculty') {
            opp.status = 'pending_approval';
        }
        await this.opportunitiesRepository.save(opp);
        return { success: true, message: 'Faculty verification successful', data: { id: opp.id, status: opp.status } };
    }
}

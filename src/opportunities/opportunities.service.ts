import { Injectable, NotFoundException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Opportunity } from './entities/opportunity.entity';
import { OpportunityParticipant } from './entities/opportunity-participant.entity';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto/create-opportunity.dto';
import { OrganizationsService } from '../organizations/organizations.service';

@Injectable()
export class OpportunitiesService {
    constructor(
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(OpportunityParticipant)
        private participantsRepository: Repository<OpportunityParticipant>,
        private organizationsService: OrganizationsService,
    ) { }

    async create(userId: string, createOpportunityDto: CreateOpportunityDto) {
        const org = await this.organizationsService.getMyOrganization(userId);
        if (!org) {
            throw new ForbiddenException('User must belong to an organization to create opportunities');
        }

        const opportunity = this.opportunitiesRepository.create({
            ...createOpportunityDto,
            organizationId: org.id,
            status: 'pending_approval',
            sdg: createOpportunityDto.sdg_info?.sdg_id || 'SDG', // Fallback
        });

        return this.opportunitiesRepository.save(opportunity);
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
        // Map to spec if needed, or return entity if it matches enough
        // Spec response: { id, title, status, location, dates, capacity, applicants_count }
        return opportunities.map(opp => ({
            ...opp,
            location: opp.location,
            start_date: opp.timeline?.start_date,
            end_date: opp.timeline?.end_date,
            dates: opp.timeline ? { end: opp.timeline.end_date } : null,
            capacity: opp.timeline ? { volunteers: opp.timeline.volunteers_required } : null,
            applicants_count: 0
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
            const count = await this.participantsRepository.count({
                where: { opportunityId: opp.id, status: 'accepted' }
            });

            return {
                id: opp.id,
                title: opp.title,
                description: opp.objectives?.description || '',
                types: opp.types,
                sdg_info: opp.sdg_info,
                participant_count: count,
                status: opp.status,
                location: opp.location,
                start_date: opp.timeline?.start_date,
                end_date: opp.timeline?.end_date,
                organization: {
                    id: opp.organization?.id,
                    name: opp.organization?.name,
                    logo_url: opp.organization?.logoUrl
                }
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

        const count = await this.participantsRepository.count({
            where: { opportunityId: opp.id, status: 'accepted' }
        });

        return {
            id: opp.id,
            title: opp.title,
            description: opp.objectives?.description || '',
            types: opp.types,
            sdg_info: opp.sdg_info,
            participant_count: count,
            status: opp.status,
            location: opp.location,
            start_date: opp.timeline?.start_date,
            end_date: opp.timeline?.end_date,
            organization: {
                id: opp.organization?.id,
                name: opp.organization?.name,
                logo_url: opp.organization?.logoUrl
            }
        };
    }

    async findOne(id: string) {
        return this.opportunitiesRepository.findOne({ where: { id }, relations: ['organization'] });
    }

    // Admin methods
    async findAllPending() {
        return this.opportunitiesRepository.find({
            where: { status: 'pending_approval' },
            relations: ['organization'],
            order: { createdAt: 'DESC' }
        });
    }

    async approve(id: string) {
        const opp = await this.findOne(id);
        if (!opp) throw new NotFoundException('Opportunity not found');
        opp.status = 'active';
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
        // First verify the opportunity belongs to this organization
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId }
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        if (opportunity.organizationId !== organizationId) {
            throw new ForbiddenException('You do not have access to this opportunity');
        }

        // Fetch all participants/applicants for this opportunity
        const participants = await this.participantsRepository.find({
            where: { opportunityId },
            relations: ['student'],
            order: { createdAt: 'DESC' }
        });

        // Map to API response format
        return participants.map(p => ({
            id: p.id,
            studentName: p.student?.name || 'Unknown',
            university: p.student?.institution || 'N/A',
            email: p.student?.email || 'N/A',
            status: p.status,
            appliedAt: p.createdAt,
            avatar: p.student?.avatar || null
        }));
    }

    async updateApplicantStatus(applicantId: string, status: string, organizationId: string) {
        // Find the participant with opportunity relation
        const participant = await this.participantsRepository.findOne({
            where: { id: applicantId },
            relations: ['opportunity']
        });

        if (!participant) {
            throw new NotFoundException('Applicant not found');
        }

        // Verify the opportunity belongs to this organization
        if (participant.opportunity.organizationId !== organizationId) {
            throw new ForbiddenException('You do not have access to this applicant');
        }

        // Update status
        participant.status = status;
        await this.participantsRepository.save(participant);

        return { success: true, message: 'Applicant status updated successfully' };
    }
}

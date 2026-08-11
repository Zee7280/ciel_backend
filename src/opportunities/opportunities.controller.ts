import {
    Controller,
    Get,
    Post,
    Patch,
    Body,
    UseGuards,
    Request,
    Query,
    Delete,
    Param,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto/create-opportunity.dto';
import { buildOpportunityDetailView } from './opportunity-detail-view.util';
import { GetOpportunityDetailDto } from './dto/get-opportunity-detail.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('opportunities')
export class OpportunitiesController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @Post()
    @UseGuards(JwtAuthGuard)
    create(@Request() req, @Body() createOpportunityDto: CreateOpportunityDto) {
        return this.opportunitiesService.create(req.user.id, createOpportunityDto);
    }


    @UseGuards(JwtAuthGuard)
    @Post('update')
    update(@Request() req, @Body() updateOpportunityDto: UpdateOpportunityDto) {
        return this.opportunitiesService.update(req.user.id, updateOpportunityDto, req.user.organizationId);
    }

    /** Executing-org confirmation: must be signed in as the official executing-organization contact email. */
    @Post('verify/executing-org')
    @UseGuards(JwtAuthGuard)
    async verifyExecutingOrgPost(@Request() req, @Body() body: { id?: string }) {
        const id = typeof body?.id === 'string' ? body.id.trim() : '';
        if (!id) {
            throw new BadRequestException('Opportunity id is required');
        }
        return this.opportunitiesService.verifyExecutingOrganizationForUser(req.user.id, req.user.email, id);
    }

    /**
     * Faculty-facing list: created by this user, linked as project faculty (`facultyId`),
     * or listed on an application as primary/secondary faculty email (same flows as attendance verification).
     */
    @UseGuards(JwtAuthGuard)
    @Get('faculty/mine')
    async findMineForFaculty(
        @Request() req,
        @Query('scope') scope?: string,
    ) {
        const authoredOnly = scope === 'authored' || scope === 'created';
        const result = await this.opportunitiesService.findMineForFaculty(req.user.id, {
            authoredOnly,
        });
        return { success: true, data: result.items };
    }

    @UseGuards(JwtAuthGuard)
    @Get()
    async findAll(@Request() req, @Query() query) {
        const data = await this.opportunitiesService.findAll(req.user.id, query);
        return { success: true, data };
    }

    @UseGuards(JwtAuthGuard)
    @Get('mine')
    async findAllAuthenticated(@Request() req, @Query() query) {
        return this.findAll(req, query);
    }

    @UseGuards(JwtAuthGuard)
    @Post('detail')
    async findOne(@Body() getOpportunityDetailDto: GetOpportunityDetailDto) {
        const data = await this.opportunitiesService.findOneWithCreator(getOpportunityDetailDto.id);
        if (!data) {
            throw new NotFoundException('Opportunity not found');
        }
        const status =
            data.workflowStage === 'live' && data.admin_approved
                ? 'live'
                : ['pending_faculty', 'pending_partner', 'pending_admin'].includes(data.workflowStage || '') ||
                    (data.workflowStage === 'live' && !data.admin_approved)
                    ? 'pending_verification'
                    : data.workflowStage === 'rejected'
                        ? 'rejected'
                        : data.workflowStage === 'revision'
                            ? 'revision'
                            : data.status;
        const detailView = buildOpportunityDetailView(data);
        // Duplicate workflow keys in snake_case for frontend badges (entity fields are camelCase).
        return {
            success: true,
            data: {
                ...data,
                status,
                workflow_stage: data.workflowStage ?? null,
                faculty_approval_status: data.facultyApprovalStatus ?? null,
                partner_approval_status: data.partnerApprovalStatus ?? null,
                admin_approval_status: data.adminApprovalStatus ?? null,
                requires_partner_approval: data.requiresPartnerApproval,
                rejection_reason: data.rejectionReason ?? null,
                detail_view: detailView,
            },
        };
    }

    @UseGuards(JwtAuthGuard)
    @Patch(':id')
    async patchById(@Request() req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
        const dto = { ...body, id } as UpdateOpportunityDto;
        return this.opportunitiesService.update(req.user.id, dto, req.user.organizationId);
    }

    @UseGuards(JwtAuthGuard)
    @Delete(':id')
    remove(@Request() req, @Param('id') id: string) {
        return this.opportunitiesService.remove(id, req.user.id);
    }
}

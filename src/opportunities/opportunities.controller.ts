import { Controller, Get, Post, Patch, Body, UseGuards, Request, Query, Delete, Param, NotFoundException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto/create-opportunity.dto';
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

    @Get('verify/executing-org')
    async verifyExecutingOrg(@Query('token') token: string) {
        return this.opportunitiesService.verifyExecutingOrganization(token);
    }

    /** Opportunities created by the logged-in faculty member (creatorId = user). */
    @UseGuards(JwtAuthGuard)
    @Get('faculty/mine')
    async findMineForFaculty(@Request() req) {
        const data = await this.opportunitiesService.findMineForFaculty(req.user.id);
        return { success: true, data };
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
        const data = await this.opportunitiesService.findOne(getOpportunityDetailDto.id);
        if (!data) {
            throw new NotFoundException('Opportunity not found');
        }
        // Duplicate workflow keys in snake_case for frontend badges (entity fields are camelCase).
        return {
            success: true,
            data: {
                ...data,
                workflow_stage: data.workflowStage ?? null,
                faculty_approval_status: data.facultyApprovalStatus ?? null,
                partner_approval_status: data.partnerApprovalStatus ?? null,
                admin_approval_status: data.adminApprovalStatus ?? null,
                requires_partner_approval: data.requiresPartnerApproval,
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
    remove(@Param('id') id: string) {
        return this.opportunitiesService.remove(id);
    }
}

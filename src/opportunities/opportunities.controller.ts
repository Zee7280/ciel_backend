import { Controller, Get, Post, Body, UseGuards, Request, Query, Delete, Param, NotFoundException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto/create-opportunity.dto';
import { GetOpportunityDetailDto } from './dto/get-opportunity-detail.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('opportunities')
export class OpportunitiesController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @UseGuards(JwtAuthGuard)
    @Post()
    create(@Request() req, @Body() createOpportunityDto: CreateOpportunityDto) {
        return this.opportunitiesService.create(req.user.id, createOpportunityDto);
    }

    @UseGuards(JwtAuthGuard)
    @Post('update')
    update(@Request() req, @Body() updateOpportunityDto: UpdateOpportunityDto) {
        return this.opportunitiesService.update(req.user.id, updateOpportunityDto, req.user.organizationId);
    }

    @Get()
    async findAll() {
        const data = await this.opportunitiesService.getPublicOpportunities();
        return { success: true, data };
    }

    @UseGuards(JwtAuthGuard)
    @Get('mine')
    async findAllAuthenticated(@Request() req, @Query() query) {
        const data = await this.opportunitiesService.findAll(req.user.id, query);
        return { success: true, data };
    }

    @UseGuards(JwtAuthGuard)
    @Post('detail')
    async findOne(@Body() getOpportunityDetailDto: GetOpportunityDetailDto) {
        const data = await this.opportunitiesService.findOne(getOpportunityDetailDto.id);
        if (!data) {
            throw new NotFoundException('Opportunity not found');
        }
        return { success: true, data };
    }

    @UseGuards(JwtAuthGuard)
    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.opportunitiesService.remove(id);
    }
}

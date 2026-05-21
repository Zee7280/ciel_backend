import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';

@Controller('public/opportunities')
export class PublicOpportunitiesController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @Get()
    async findAll(@Query() query: any) {
        const data = await this.opportunitiesService.getPublicOpportunities(query);
        return { success: true, data };
    }

    @Get(':id')
    async findOne(@Param('id', ParseUUIDPipe) id: string) {
        const data = await this.opportunitiesService.getPublicOpportunityById(id);
        return { success: true, data };
    }
}

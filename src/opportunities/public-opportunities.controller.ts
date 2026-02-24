import { Controller, Get, Param } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';

@Controller('public/opportunities')
export class PublicOpportunitiesController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @Get()
    async findAll() {
        const data = await this.opportunitiesService.getPublicOpportunities();
        return { success: true, data };
    }

    @Get(':id')
    async findOne(@Param('id') id: string) {
        const data = await this.opportunitiesService.getPublicOpportunityById(id);
        return { success: true, data };
    }
}

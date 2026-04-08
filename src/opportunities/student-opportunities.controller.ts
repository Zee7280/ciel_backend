import { Controller, Post, Body, UseGuards, Request, Get, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto } from './dto/create-opportunity.dto';

@Controller('student/opportunities')
export class StudentOpportunitiesController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @Post()
    @UseGuards(JwtAuthGuard)
    create(@Request() req, @Body() dto: CreateOpportunityDto) {
        return this.opportunitiesService.createStudentOpportunity(req.user.id, dto);
    }

    @Get('faculty/verify')
    verify(@Query('token') token: string) {
        return this.opportunitiesService.verifyFaculty(token);
    }
}

import { Body, Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VerificationVerifyAuthGuard } from '../auth/verification-verify-auth.guard';
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

    @UseGuards(VerificationVerifyAuthGuard)
    @Get('faculty/verify')
    verify(@Request() req, @Query('token') token: string) {
        return this.opportunitiesService.verifyFaculty(token, req.user);
    }
}

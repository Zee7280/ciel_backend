import { Controller, Get, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';

@Controller('faculty/applications')
@UseGuards(JwtAuthGuard)
export class FacultyApplicationsController {
    constructor(private readonly opportunityApplicationsService: OpportunityApplicationsService) {}

    @Get()
    list(@Request() req, @Query('status') status?: 'pending' | 'history') {
        return this.opportunityApplicationsService.facultyList(
            req.user.email || '',
            req.user.id,
            status === 'history' ? 'history' : 'pending',
        );
    }

    @Post(':id/approve')
    approve(@Request() req, @Param('id') id: string) {
        return this.opportunityApplicationsService.facultyApprove(
            id,
            req.user.email || '',
            req.user.id,
        );
    }

    @Post(':id/reject')
    reject(@Request() req, @Param('id') id: string, @Body() body: { reason?: string }) {
        return this.opportunityApplicationsService.facultyReject(
            id,
            req.user.email || '',
            req.user.id,
            body?.reason || '',
        );
    }
}

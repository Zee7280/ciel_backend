import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { CommunityAwardService } from '../reports/community-award.service';
import { NotifyCommunityAwardDto } from '../reports/dto/notify-community-award.dto';

@Controller('faculty/community-service')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultyCommunityServiceController {
    constructor(
        private readonly facultyReportsService: FacultyReportsService,
        private readonly communityAward: CommunityAwardService,
    ) {}

    @Get('award-cards')
    async awardCards(@Request() req) {
        const reports = await this.facultyReportsService.listAssignedReports(req.user.id, req.user.email);
        return { success: true, data: this.communityAward.cardsFrom(reports, true) };
    }

    @Post('award-notify')
    async awardNotify(@Request() req, @Body() dto: NotifyCommunityAwardDto) {
        const reports = await this.facultyReportsService.listAssignedReports(req.user.id, req.user.email);
        const pool = this.communityAward.cardsFrom(reports, true);
        const data = await this.communityAward.notifyFromPool(pool, { ...dto, kind: 'fac' });
        return { success: true, data };
    }
}

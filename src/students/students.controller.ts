import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Query,
    Request,
    UseGuards,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { StudentsService } from './students.service';
import { ApplyOpportunityDto } from './dto/apply-opportunity.dto';

@Controller('students')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.STUDENT, UserRole.SUPER_ADMIN)
export class StudentsController {
    constructor(
        private readonly studentsService: StudentsService,
    ) { }

    @Get('me/dashboard')
    getMyDashboard(@Request() req) {
        return this.studentsService.getDashboard(req.user.id);
    }

    @Get('reports')
    getReports(@Request() req, @Query('organisationId') organisationId: string) {
        if (!organisationId) {
            throw new BadRequestException('organisationId is required');
        }
        return this.studentsService.getReports(req.user.id, organisationId);
    }

    @Get('opportunities')
    getOpportunities(@Request() req, @Query() query) {
        // Same rule as the POST sibling below: a `student_id` in the query is only honoured for the
        // caller themselves or an admin — never as a way to read another student's scoped list.
        const requestedStudentId = query?.student_id || query?.studentId;
        const studentContextId =
            requestedStudentId && (req.user?.role === UserRole.SUPER_ADMIN || requestedStudentId === req.user.id)
                ? requestedStudentId
                : req.user.id;

        return this.studentsService.getOpportunities(
            { ...query, student_id: studentContextId },
            studentContextId,
        );
    }

    @Post('opportunities')
    getOpportunitiesPost(
        @Request() req,
        @Query() query,
        @Body() body?: { student_id?: string; studentId?: string },
    ) {
        const requestedStudentId = body?.student_id || body?.studentId;
        const studentContextId =
            requestedStudentId && (req.user?.role === UserRole.SUPER_ADMIN || requestedStudentId === req.user.id)
                ? requestedStudentId
                : req.user.id;

        return this.studentsService.getOpportunities(
            { ...query, ...body, student_id: studentContextId },
            studentContextId,
        );
    }

    @Get('opportunities/recommended')
    getRecommendedOpportunities(@Request() req) {
        return this.studentsService.getRecommendedOpportunities(req.user.id);
    }

    @Get('opportunities/:id')
    getOpportunityById(@Request() req, @Param('id') id: string) {
        return this.studentsService.getOpportunityById(id, req.user.id);
    }

    // Applications
    @Get('applications')
    getApplications(@Request() req, @Query('status') status?: string) {
        return this.studentsService.getApplications(req.user.id, status);
    }

    @Post('applications')
    applyToOpportunity(@Request() req, @Body() dto: ApplyOpportunityDto) {
        return this.studentsService.applyToOpportunity(req.user.id, dto);
    }

    @Post('opportunities/:id/apply')
    applyToOpportunityById(@Request() req, @Param('id') id: string, @Body() body: any) {
        return this.studentsService.applyToOpportunity(req.user.id, { ...body, opportunityId: id });
    }

    @Delete('applications/:id')
    withdrawApplication(@Request() req, @Param('id') id: string) {
        return this.studentsService.withdrawApplication(req.user.id, id);
    }

    @Get('impact/history')
    getImpactHistoryGet(
        @Request() req,
        @Query('student_id') student_id?: string,
        @Query('studentId') studentId?: string,
    ) {
        return this.studentsService.getImpactHistory(req.user.id, req.user.role, { student_id, studentId });
    }

    @Post('impact/history')
    getImpactHistory(
        @Request() req,
        @Body() body?: { student_id?: string; studentId?: string },
    ) {
        return this.studentsService.getImpactHistory(req.user.id, req.user.role, body);
    }

    @Get('community-service/rankings')
    getCommunityServiceRankings(@Request() req) {
        return this.studentsService.getCommunityServiceRankings(req.user.id);
    }

}

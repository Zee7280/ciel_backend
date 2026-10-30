import {
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { StudentReportsService } from '../reports/student-reports.service';

type AuthenticatedRequest = { user: { id: string; role: UserRole } };

/**
 * Faculty supervision before an impact report starts: the student sees whether they are waiting
 * (and can remind), the named faculty confirms, CIEL PK admin can confirm on their behalf.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportSupervisionController {
  constructor(private readonly studentReportsService: StudentReportsService) {}

  @Get('student/reports/:projectId/supervision')
  @Roles(UserRole.STUDENT, UserRole.SUPER_ADMIN)
  status(
    @Request() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.studentReportsService.getReportSupervision(
      req.user.id,
      projectId,
    );
  }

  @Post('student/reports/:projectId/supervision/remind')
  @Roles(UserRole.STUDENT)
  remind(
    @Request() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.studentReportsService.remindReportSupervision(
      req.user.id,
      projectId,
    );
  }

  @Get('faculty/report-supervision')
  @Roles(UserRole.FACULTY)
  list(@Request() req: AuthenticatedRequest) {
    return this.studentReportsService.listFacultySupervisionRequests(
      req.user.id,
    );
  }

  /** CIEL PK: every seat still waiting for a faculty confirmation, with the faculty it waits on. */
  @Get('admin/report-supervision')
  @Roles(UserRole.SUPER_ADMIN)
  adminList() {
    return this.studentReportsService.listPendingSupervisionForAdmin();
  }

  @Post('faculty/report-supervision/:participationId/confirm')
  @Roles(UserRole.FACULTY, UserRole.SUPER_ADMIN)
  confirm(
    @Request() req: AuthenticatedRequest,
    @Param('participationId') participationId: string,
  ) {
    return this.studentReportsService.confirmReportSupervision(
      req.user.id,
      participationId,
    );
  }
}

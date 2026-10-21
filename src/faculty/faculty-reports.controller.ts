import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { FacultyReportActionDto } from './dto/faculty-report-action.dto';
import { ApproveCiiV45Dto } from './dto/approve-cii-v4-5.dto';
import { RunIndependentAnalysisDto } from './dto/run-independent-analysis.dto';
import { RunIndependentAnalysisBatchDto } from './dto/run-independent-analysis-batch.dto';

const FACULTY_REPORT_WRITE_BLOCKED =
  'Faculty report review is read-only. Run Analyzer, Approve, Request revision and Reject are handled by CIEL PK Admin.';

/** Request user as populated by JwtStrategy.validate. */
type FacultyRequest = { user: { id: string; email: string } };

/** Every faculty write route rejects with the same 403 (as a rejected promise, like the async handlers before). */
function facultyWriteBlocked(): Promise<never> {
  return Promise.reject(new ForbiddenException(FACULTY_REPORT_WRITE_BLOCKED));
}

@Controller('faculty/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultyReportsController {
  constructor(private readonly facultyReportsService: FacultyReportsService) {}

  @Get()
  async getAssignedReports(@Request() req: FacultyRequest) {
    return await this.facultyReportsService.findAll(
      req.user.id,
      req.user.email,
    );
  }

  /** In-progress (not yet submitted) reports: progress only; opening stays blocked until submit. */
  @Get('progress')
  async getDraftProgress(@Request() req: FacultyRequest) {
    return await this.facultyReportsService.listDraftProgress(
      req.user.id,
      req.user.email,
    );
  }

  @Get(':id')
  async getReportById(@Request() req: FacultyRequest, @Param('id') id: string) {
    return await this.facultyReportsService.findOne(
      id,
      req.user.id,
      req.user.email,
    );
  }

  /** Read-only faculty policy — decisions live on CIEL PK Admin. */
  // The DTO params below stay on the signatures so ValidationPipe still validates the body before the 403.
  @Post(':id/action')
  handleAction(@Body() body: FacultyReportActionDto): Promise<never> {
    void body;
    return facultyWriteBlocked();
  }

  @Post(':id/cii-v4-5/analyse')
  analyseCiiV45(): Promise<never> {
    return facultyWriteBlocked();
  }

  @Post(':id/cii-v4-5/approve')
  approveCiiV45(@Body() body: ApproveCiiV45Dto): Promise<never> {
    void body;
    return facultyWriteBlocked();
  }

  @Post(':id/cii-v4-5/independent-analysis')
  runIndependentAnalysis(
    @Body() body: RunIndependentAnalysisDto,
  ): Promise<never> {
    void body;
    return facultyWriteBlocked();
  }

  @Post('cii-v4-5/independent-analysis/batch')
  runIndependentAnalysisBatch(
    @Body() body: RunIndependentAnalysisBatchDto,
  ): Promise<never> {
    void body;
    return facultyWriteBlocked();
  }
}

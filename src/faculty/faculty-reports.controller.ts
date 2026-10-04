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

@Controller('faculty/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultyReportsController {
  constructor(private readonly facultyReportsService: FacultyReportsService) {}

  @Get()
  async getAssignedReports(@Request() req) {
    return await this.facultyReportsService.findAll(
      req.user.id,
      req.user.email,
    );
  }

  /** In-progress (not yet submitted) reports: progress only; opening stays blocked until submit. */
  @Get('progress')
  async getDraftProgress(@Request() req) {
    return await this.facultyReportsService.listDraftProgress(
      req.user.id,
      req.user.email,
    );
  }

  @Get(':id')
  async getReportById(@Request() req, @Param('id') id: string) {
    return await this.facultyReportsService.findOne(
      id,
      req.user.id,
      req.user.email,
    );
  }

  /** Read-only faculty policy — decisions live on CIEL PK Admin. */
  @Post(':id/action')
  async handleAction(
    @Request() _req,
    @Param('id') _id: string,
    @Body() _body: FacultyReportActionDto,
  ) {
    throw new ForbiddenException(FACULTY_REPORT_WRITE_BLOCKED);
  }

  @Post(':id/cii-v4-5/analyse')
  async analyseCiiV45(@Request() _req, @Param('id') _id: string) {
    throw new ForbiddenException(FACULTY_REPORT_WRITE_BLOCKED);
  }

  @Post(':id/cii-v4-5/approve')
  async approveCiiV45(
    @Request() _req,
    @Param('id') _id: string,
    @Body() _body: ApproveCiiV45Dto,
  ) {
    throw new ForbiddenException(FACULTY_REPORT_WRITE_BLOCKED);
  }

  @Post(':id/cii-v4-5/independent-analysis')
  async runIndependentAnalysis(
    @Request() _req,
    @Param('id') _id: string,
    @Body() _body: RunIndependentAnalysisDto,
  ) {
    throw new ForbiddenException(FACULTY_REPORT_WRITE_BLOCKED);
  }

  @Post('cii-v4-5/independent-analysis/batch')
  async runIndependentAnalysisBatch(
    @Request() _req,
    @Body() _body: RunIndependentAnalysisBatchDto,
  ) {
    throw new ForbiddenException(FACULTY_REPORT_WRITE_BLOCKED);
  }
}

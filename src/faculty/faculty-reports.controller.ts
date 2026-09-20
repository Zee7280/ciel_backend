import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { FacultyReportActionDto } from './dto/faculty-report-action.dto';
import { ApproveCiiV2Dto } from './dto/approve-cii-v2.dto';
import { RunIndependentAnalysisDto } from './dto/run-independent-analysis.dto';
import { RunIndependentAnalysisBatchDto } from './dto/run-independent-analysis-batch.dto';

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

  @Get(':id')
  async getReportById(@Request() req, @Param('id') id: string) {
    return await this.facultyReportsService.findOne(
      id,
      req.user.id,
      req.user.email,
    );
  }

  @Post(':id/action')
  async handleAction(
    @Request() req,
    @Param('id') id: string,
    @Body() body: FacultyReportActionDto,
  ) {
    return await this.facultyReportsService.updateAction(
      id,
      req.user.id,
      req.user.email,
      body.status,
      body.remarks,
    );
  }

  @Post(':id/cii-v2/analyse')
  async analyseCiiV2(@Request() req, @Param('id') id: string) {
    return await this.facultyReportsService.runCiiV2Analysis(
      id,
      req.user.id,
      req.user.email,
    );
  }

  /**
   * Phase 2: Approve CII v2 with audit trail support.
   *
   * If faculty adjusts the AI-recommended score, they must provide a reason.
   * Both scores are stored for audit: AI Recommended → Faculty Approved
   */
  @Post(':id/cii-v2/approve')
  async approveCiiV2(
    @Request() req,
    @Param('id') id: string,
    @Body() body: ApproveCiiV2Dto,
  ) {
    return await this.facultyReportsService.approveCiiV2(
      id,
      req.user.id,
      req.user.email,
      body.note,
      body.facultyAdjustedScore,
      body.scoreAdjustmentReason,
      body.criteriaOverrides,
    );
  }

  /**
   * Phase 4: Run Independent AI Analysis from My Impact Wall.
   *
   * Authorized stakeholders can run additional AI analysis on approved records
   * without overwriting the faculty-approved score.
   *
   * - Uses the same approved formula/rubric
   * - Results stored separately for audit
   * - Original faculty-approved record remains unchanged
   */
  @Post(':id/cii-v2/independent-analysis')
  async runIndependentAnalysis(
    @Request() req,
    @Param('id') id: string,
    @Body() body: RunIndependentAnalysisDto,
  ) {
    return await this.facultyReportsService.runIndependentAiAnalysis(
      id,
      req.user.id,
      'faculty',
      req.user.name || req.user.email,
      body.note,
      { facultyEmail: req.user.email },
    );
  }

  /** Batch counterpart — run independent analysis across several of this faculty's assigned
   * reports at once, so the resulting score/trend update lands on each affected student's My
   * Impact Wall in a single action instead of one report at a time. */
  @Post('cii-v2/independent-analysis/batch')
  async runIndependentAnalysisBatch(
    @Request() req,
    @Body() body: RunIndependentAnalysisBatchDto,
  ) {
    return await this.facultyReportsService.runIndependentAiAnalysisBatch(
      body.reportIds,
      req.user.id,
      'faculty',
      req.user.name || req.user.email,
      body.note,
      { facultyEmail: req.user.email },
    );
  }
}

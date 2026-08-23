import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EngagementService } from './engagement.service';
import { TeamFormationService } from './team-formation.service';
import { FormTeamFromLeadDto } from './dto/form-team-from-lead.dto';
import { RegisterParticipantDto } from './dto/register-participant.dto';
import { CreateAttendanceLogDto } from './dto/create-attendance-log.dto';
import { PatchAttendanceApprovalDto } from './dto/patch-attendance-approval.dto';
import { CreateAttendanceVerifyRequestDto } from './dto/create-attendance-verify-request.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  assertStudentReportUploadMeta,
  studentReportMulterFileFilter,
  studentReportPresignExpiresInSeconds,
  studentReportUploadMulterLimits,
} from '../common/student-report-file-upload';
import { S3Service } from '../common/s3.service';

@Controller('engagement')
@UseGuards(JwtAuthGuard)
export class EngagementController {
  constructor(
    private readonly engagementService: EngagementService,
    private readonly teamFormationService: TeamFormationService,
    private readonly s3Service: S3Service,
  ) {}

  @Get('my')
  async getMy(@Request() req) {
    const result = await this.engagementService.getMyParticipants(req.user.id);
    return {
      success: true,
      data: result,
    };
  }

  @Get('me/latest')
  async getMyLatest(@Request() req) {
    const result = await this.engagementService.getLatestParticipation(
      req.user.id,
    );
    return {
      success: true,
      data: result,
    };
  }

  /** Partner/NGO (creator) or CIEL admin: pending attendance queue (server-side routing; no client-supplied approver). */
  @Get('attendance/pending')
  async listPendingAttendance(
    @Request() req,
    @Query('projectId') projectId?: string,
  ) {
    const result = await this.engagementService.listPendingAttendanceLogs(
      req.user.id,
      req.user.role,
      projectId,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Patch('attendance/:logId')
  async patchAttendanceApproval(
    @Request() req,
    @Param('logId', ParseUUIDPipe) logId: string,
    @Body() dto: PatchAttendanceApprovalDto,
  ) {
    const result = await this.engagementService.patchAttendanceApproval(
      req.user.id,
      req.user.role,
      logId,
      dto,
    );
    return {
      success: true,
      data: result,
      message: 'Attendance approval updated',
    };
  }

  @Post('project/:projectId/attendance/verify-request')
  async createAttendanceVerifyRequest(
    @Request() req,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateAttendanceVerifyRequestDto,
  ) {
    const result = await this.engagementService.createAttendanceVerifyRequest(
      req.user.id,
      req.user.role,
      projectId,
      dto,
    );
    return {
      success: true,
      ...result,
    };
  }

  /** JSON-only presign — browser uploads attendance photo direct to S3 (bypasses serverless body limits). */
  @Post('attendance/evidence/presign')
  async presignAttendanceEvidence(
    @Request() req,
    @Body()
    body: { filename?: string; contentType?: string; size?: number | string },
  ) {
    const meta = assertStudentReportUploadMeta(body);
    const signed = await this.s3Service.presignPutObject({
      folder: `attendance-evidence/${req.user.id}`,
      originalName: meta.filename,
      contentType: meta.contentType,
      expiresInSeconds: studentReportPresignExpiresInSeconds(meta.size),
    });
    return { success: true, data: { ...signed, url: signed.publicUrl } };
  }

  @Post('teams/form')
  async formTeam(@Request() req, @Body() dto: FormTeamFromLeadDto) {
    const result = await this.teamFormationService.formTeamFromLead(
      req.user.id,
      dto.projectId,
      dto.memberParticipationIds ?? [],
    );
    return { success: true, data: result };
  }

  @Post('register')
  async register(@Request() req, @Body() dto: RegisterParticipantDto) {
    const result = await this.engagementService.registerParticipant(
      req.user.id,
      dto,
    );
    return {
      success: true,
      data: result,
      message: 'Participation registered successfully',
    };
  }

  @Post(':id/attendance')
  @UseInterceptors(
    FileInterceptor('evidence', {
      limits: studentReportUploadMulterLimits(),
      fileFilter: studentReportMulterFileFilter,
    }),
  )
  async addAttendance(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: CreateAttendanceLogDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.engagementService.addAttendanceLog(
      req.user.id,
      id,
      dto,
      file,
    );
    return {
      success: true,
      data: result,
      message: 'Attendance logged successfully',
    };
  }

  @Get(':id/attendance')
  async getAttendance(@Param('id') id: string) {
    const result = await this.engagementService.getAttendanceLogs(id);
    return {
      success: true,
      data: result,
    };
  }

  @Delete(':id/attendance/:logId')
  async deleteAttendance(
    @Request() req,
    @Param('id') id: string,
    @Param('logId', ParseUUIDPipe) logId: string,
  ) {
    const result = await this.engagementService.deleteAttendanceLog(
      req.user.id,
      id,
      logId,
    );
    return {
      success: true,
      data: result,
      message: 'Attendance log deleted successfully',
    };
  }

  @Get(':id/metrics')
  async getMetrics(@Param('id') id: string) {
    const result = await this.engagementService.getEngagementMetrics(id);
    return {
      success: true,
      data: result,
    };
  }

  @Get(':id/summary')
  async getSummary(@Param('id') id: string) {
    const result = await this.engagementService.generateSummary(id);
    return {
      success: true,
      data: result,
    };
  }

  @Post(':id/finalize')
  async finalize(@Request() req, @Param('id') id: string) {
    const result = await this.engagementService.finalizeEngagement(
      req.user.id,
      id,
    );
    return {
      success: true,
      data: result,
      message: 'Engagement finalized successfully',
    };
  }

  @Post(':id/faculty-approve')
  async facultyApprove(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: string,
  ) {
    const result = await this.engagementService.facultyApprove(
      req.user.id,
      req.user.role,
      id,
      status,
    );
    return {
      success: true,
      data: result,
      message: `Participation ${status} by faculty`,
    };
  }

  @Get('project/:projectId/team')
  async getProjectTeam(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const result = await this.engagementService.getProjectTeam(projectId);
    return {
      success: true,
      data: result,
    };
  }

  @Get('project/:projectId/attendance-logs')
  async getProjectAttendance(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const result =
      await this.engagementService.getProjectAttendanceLogs(projectId);
    return {
      success: true,
      data: result,
    };
  }

  @Delete(':id')
  async deleteParticipant(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    await this.engagementService.deleteParticipant(req.user.id, id);
    return {
      success: true,
      message: 'Member removed from project participation',
    };
  }
}

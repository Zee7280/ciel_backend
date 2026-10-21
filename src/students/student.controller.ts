import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  UploadedFiles,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SubscriptionActiveGuard } from '../student-subscription/subscription-active.guard';
import { Roles } from '../auth/roles.decorator';
import { StudentsService } from './students.service';
import { StudentParticipationService } from './student-participation.service';
import { StudentReportsService } from '../reports/student-reports.service';
import { CreateOpportunityDto } from '../opportunities/dto/create-opportunity.dto';
import { UserRole } from '../users/enums/user-role.enum';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import {
  assertStudentReportUploadMeta,
  studentReportMulterFileFilter,
  studentReportPresignExpiresInSeconds,
  studentReportUploadMulterLimits,
} from '../common/student-report-file-upload';
import { S3Service } from '../common/s3.service';
import { RedactOpportunitySecretsInterceptor } from '../opportunities/redact-opportunity-secrets.interceptor';
import type { StudentOpportunitiesQuery } from './students.service';

/** `req.user` as populated by JwtStrategy.validate(). */
type AuthenticatedRequest = {
  user: {
    id: string;
    email?: string;
    role: UserRole;
    organizationId?: string | null;
  };
};

/** Copy of the submitted opportunity payload without the `draft` routing flag. */
function withoutDraftFlag<T extends { draft?: boolean }>(
  dto: T,
): Omit<T, 'draft'> {
  const copy: T = { ...dto };
  delete copy.draft;
  return copy;
}

@Controller('student')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionActiveGuard)
@Roles(UserRole.STUDENT, UserRole.SUPER_ADMIN)
export class StudentController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly studentReportsService: StudentReportsService,
    private readonly studentParticipationService: StudentParticipationService,
    private readonly s3Service: S3Service,
  ) {}

  @Get('projects')
  getStudentProjects(@Request() req: AuthenticatedRequest) {
    return this.studentsService.getStudentProjects(req.user.id);
  }

  /** Alias for clients that POST (e.g. Next.js proxy); always scoped to JWT user. */
  @Post('projects')
  postStudentProjects(@Request() req: AuthenticatedRequest) {
    return this.studentsService.getStudentProjects(req.user.id);
  }

  @Get('projects/:id')
  @UseInterceptors(RedactOpportunitySecretsInterceptor)
  getProjectById(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.studentsService.getProjectById(id, req.user.id, {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      organizationId: req.user.organizationId ?? null,
    });
  }

  @Get('projects/:id/my-participation')
  async getMyParticipation(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.studentParticipationService.getMyParticipation(req.user.id, id);
  }

  @Get('opportunities/:id/participation-guide')
  async getParticipationGuide(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    // Only opportunities the caller may open at all (public-live / own / joined / applied).
    await this.studentsService.assertOpportunityVisibleToViewer(id, {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      organizationId: req.user.organizationId ?? null,
    });
    const data = await this.studentParticipationService.getParticipationGuide(
      req.user.id,
      id,
    );
    return { success: true, data };
  }

  @Get('opportunity')
  getOpportunity(
    @Request() req: AuthenticatedRequest,
    @Query() query: StudentOpportunitiesQuery,
  ) {
    return this.studentsService.getOpportunities(query, req.user.id);
  }

  @Get('opportunities/similar')
  findSimilarOpportunities(
    @Request() req: AuthenticatedRequest,
    @Query('title') title?: string,
    @Query('university') university?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.studentsService.findSimilarStudentOpportunitiesForCreate(
      req.user.id,
      title || '',
      {
        university,
        excludeOpportunityId: excludeId,
      },
    );
  }

  @Post('opportunity')
  @UseInterceptors(RedactOpportunitySecretsInterceptor)
  createIndependentProject(
    @Request() req: AuthenticatedRequest,
    @Body() createOpportunityDto: CreateOpportunityDto,
  ) {
    if (createOpportunityDto?.draft === true) {
      return this.studentsService.saveStudentOpportunityDraft(
        req.user.id,
        null,
        createOpportunityDto as unknown as Record<string, unknown>,
      );
    }
    const createDto = withoutDraftFlag(createOpportunityDto);
    return this.studentsService.createStudentOpportunity(
      req.user.id,
      createDto,
    );
  }

  /** Resend the official faculty or partner verification email. Does not change the approval stage. */
  @Post('opportunity/:id/remind-reviewer')
  @Roles(
    UserRole.STUDENT,
    UserRole.SUPER_ADMIN,
    UserRole.FACULTY,
    UserRole.NGO,
    UserRole.UNIVERSITY,
    UserRole.ORGANIZATION_ADMIN,
  )
  remindOpportunityReviewer(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.studentsService.remindOpportunityReviewer(req.user.id, id);
  }

  /** Resend Faculty / CIEL PK report-review email. Does not change report status. */
  @Post('reports/:id/remind-reviewer')
  @Roles(
    UserRole.STUDENT,
    UserRole.SUPER_ADMIN,
    UserRole.FACULTY,
    UserRole.NGO,
    UserRole.UNIVERSITY,
    UserRole.ORGANIZATION_ADMIN,
  )
  remindReportReviewer(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.studentReportsService.remindReportReviewer(req.user.id, id);
  }

  @Post('opportunity/:id')
  @Patch('opportunity/:id')
  @UseInterceptors(RedactOpportunitySecretsInterceptor)
  updateIndependentProject(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body()
    updateOpportunityDto: Partial<CreateOpportunityDto>,
  ) {
    if (updateOpportunityDto?.draft === true) {
      return this.studentsService.saveStudentOpportunityDraft(
        req.user.id,
        id,
        updateOpportunityDto as unknown as Record<string, unknown>,
      );
    }
    const updateDto = withoutDraftFlag(updateOpportunityDto);
    return this.studentsService.updateStudentOpportunity(
      req.user.id,
      id,
      updateDto,
    );
  }

  @Post('verify-team-member/send')
  async sendOtp(
    @Body()
    body: {
      email: string;
      projectId?: string;
      blockIfOnRoster?: boolean;
    },
  ) {
    if (!body.email) {
      throw new BadRequestException('Email is required');
    }
    return this.studentsService.sendTeamMemberOtp(
      body.email,
      body.projectId,
      body.blockIfOnRoster === true,
    );
  }

  @Post('verify-team-member/confirm')
  async confirmOtp(@Body() body: { email: string; otp: string }) {
    if (!body.email || !body.otp) {
      throw new BadRequestException('Email and OTP required');
    }
    return this.studentsService.confirmTeamMemberOtp(body.email, body.otp);
  }

  @Post('verify-team-member')
  async verifyTeamMember(@Body() body: { email: string }) {
    if (!body.email) {
      throw new BadRequestException('Email is required');
    }
    return this.studentsService.sendTeamMemberVerification(body.email);
  }

  // ---- Reports aliases (frontend uses /student not /students) ----

  @Get('reports')
  getAllReports(
    @Request() req: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
  ) {
    return this.studentReportsService.findAll({
      ...query,
      studentId: req.user.id,
    });
  }

  @Get('reports/:id')
  getReportById(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.studentReportsService.findOneByOpportunityOrId(id, req.user.id);
  }

  @Post('reports/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: studentReportUploadMulterLimits(),
      fileFilter: studentReportMulterFileFilter,
    }),
  )
  async uploadFile(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('section') section: string,
  ) {
    if (!file) {
      throw new BadRequestException('File not provided');
    }
    if (!section) {
      throw new BadRequestException('Section is required (e.g., section8)');
    }
    const url = await this.studentReportsService.uploadFile(
      file,
      section,
      req.user.id,
    );
    return { success: true, data: { url } };
  }

  @Post('reports/upload/presign')
  async presignUploadFile(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      section?: string;
      filename?: string;
      contentType?: string;
      size?: number | string;
    },
  ) {
    if (!body.section) {
      throw new BadRequestException('Section is required (e.g., section8)');
    }

    const meta = assertStudentReportUploadMeta(body);
    const signed = await this.s3Service.presignPutObject({
      folder: `student-reports-temp/${req.user.id}/${body.section}`,
      originalName: meta.filename,
      contentType: meta.contentType,
      expiresInSeconds: studentReportPresignExpiresInSeconds(meta.size),
    });

    return { success: true, data: { ...signed, url: signed.publicUrl } };
  }

  @Post('reports/:projectId/evidence')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: studentReportUploadMulterLimits(),
      fileFilter: studentReportMulterFileFilter,
    }),
  )
  async uploadEvidenceFile(
    @Request() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { project_id?: string; section?: string; field?: string },
  ) {
    if (!file) {
      throw new BadRequestException('File not provided');
    }

    if (!body.project_id) {
      throw new BadRequestException('project_id is required');
    }

    if (body.project_id !== projectId) {
      throw new BadRequestException(
        'project_id must match projectId parameter',
      );
    }

    if (body.section !== 'section8') {
      throw new BadRequestException('section must be section8');
    }

    const allowedFields = ['evidence_files', 'partner_verification_files'];
    if (!body.field || !allowedFields.includes(body.field)) {
      throw new BadRequestException(
        `field must be one of: ${allowedFields.join(', ')}`,
      );
    }

    const folder = `${projectId}/${body.section}/${body.field}`;
    const url = await this.studentReportsService.uploadFile(
      file,
      folder,
      req.user.id,
    );
    return { url };
  }

  @Post('reports/:projectId/evidence/presign')
  async presignEvidenceFile(
    @Request() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body()
    body: {
      project_id?: string;
      section?: string;
      field?: string;
      filename?: string;
      contentType?: string;
      size?: number | string;
    },
  ) {
    if (!body.project_id) {
      throw new BadRequestException('project_id is required');
    }

    if (body.project_id !== projectId) {
      throw new BadRequestException(
        'project_id must match projectId parameter',
      );
    }

    if (body.section !== 'section8') {
      throw new BadRequestException('section must be section8');
    }

    const allowedFields = ['evidence_files', 'partner_verification_files'];
    if (!body.field || !allowedFields.includes(body.field)) {
      throw new BadRequestException(
        `field must be one of: ${allowedFields.join(', ')}`,
      );
    }

    const meta = assertStudentReportUploadMeta(body);
    const folder = `student-reports-temp/${req.user.id}/${projectId}/${body.section}/${body.field}`;
    const signed = await this.s3Service.presignPutObject({
      folder,
      originalName: meta.filename,
      contentType: meta.contentType,
      expiresInSeconds: studentReportPresignExpiresInSeconds(meta.size),
    });

    return { success: true, data: { ...signed, url: signed.publicUrl } };
  }

  @Post('reports')
  @UseInterceptors(
    FilesInterceptor('files', 50, {
      limits: studentReportUploadMulterLimits(),
      fileFilter: studentReportMulterFileFilter,
    }),
  )
  async submitReport(
    @Request() req: AuthenticatedRequest,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.studentReportsService.createReport(
      req.user.id,
      body,
      files,
      false,
    );
  }

  @Post('reports/:id/submit')
  @UseInterceptors(
    FilesInterceptor('files', 50, {
      limits: studentReportUploadMulterLimits(),
      fileFilter: studentReportMulterFileFilter,
    }),
  )
  async submitReportWithId(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    // If opportunityId is not in body, use the one from URL
    if (!body.opportunityId) body.opportunityId = id;
    return this.studentReportsService.createReport(
      req.user.id,
      body,
      files,
      true,
    );
  }

  @Post('reports/draft')
  @UseInterceptors(
    FilesInterceptor('files', 50, {
      limits: studentReportUploadMulterLimits(),
      fileFilter: studentReportMulterFileFilter,
    }),
  )
  async saveDraft(
    @Request() req: AuthenticatedRequest,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.studentReportsService.saveDraft(req.user.id, body, files);
  }

  @Post('reports/:id/draft')
  @UseInterceptors(
    FilesInterceptor('files', 50, {
      limits: studentReportUploadMulterLimits(),
      fileFilter: studentReportMulterFileFilter,
    }),
  )
  async saveDraftWithId(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!body.opportunityId) body.opportunityId = id;
    return this.studentReportsService.saveDraft(req.user.id, body, files);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { SubscriptionActiveGuard } from '../student-subscription/subscription-active.guard';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { QuickWorkService } from './quick-work.service';
import {
  AdminQuickWorkListQuery,
  AdminQuickWorkReassignDto,
  QuickWorkEmailResponseDto,
  QuickWorkJoinDto,
  QuickWorkPresignDto,
  QuickWorkReviewDto,
  SaveQuickWorkLogDto,
} from './dto/quick-work.dto';

type AuthedRequest = { user: { id: string } };

/** Student side of Quick Community Work: draft, team confirmation, submit, My Quick Work. */
@Controller('quick-work')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionActiveGuard)
@Roles(UserRole.STUDENT)
export class QuickWorkController {
  constructor(private readonly quickWork: QuickWorkService) {}

  @Get('me')
  async mine(@Request() req: AuthedRequest) {
    return { success: true, data: await this.quickWork.listMine(req.user) };
  }

  @Post('logs')
  async create(
    @Request() req: AuthedRequest,
    @Body() dto: SaveQuickWorkLogDto,
  ) {
    return {
      success: true,
      data: await this.quickWork.createDraft(req.user, dto),
    };
  }

  @Get('logs/:id')
  async get(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.quickWork.getForParticipant(req.user, id),
    };
  }

  @Patch('logs/:id')
  async save(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveQuickWorkLogDto,
  ) {
    return {
      success: true,
      data: await this.quickWork.saveDraft(req.user, id, dto),
    };
  }

  @Delete('logs/:id')
  async remove(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.quickWork.deleteDraft(req.user, id),
    };
  }

  @Post('logs/:id/submit')
  async submit(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return { success: true, data: await this.quickWork.submit(req.user, id) };
  }

  @Post('logs/:id/join')
  async join(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuickWorkJoinDto,
  ) {
    return {
      success: true,
      data: await this.quickWork.respondToInvite(req.user, id, dto.accept),
    };
  }

  /** Lead: ask the named faculty member again while they have not answered. */
  @Post('logs/:id/faculty-request')
  async resendFacultyRequest(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.quickWork.resendFacultyRequest(req.user, id),
    };
  }

  @Post('evidence/presign')
  async presign(
    @Request() req: AuthedRequest,
    @Body() dto: QuickWorkPresignDto,
  ) {
    const signed = await this.quickWork.presignEvidence(req.user, dto);
    return { success: true, data: { ...signed, url: signed.publicUrl } };
  }
}

/** Faculty side: only logs that name the signed-in faculty member's email. */
@Controller('faculty/quick-work')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultyQuickWorkController {
  constructor(private readonly quickWork: QuickWorkService) {}

  @Get()
  async list(@Request() req: AuthedRequest) {
    return {
      success: true,
      data: await this.quickWork.listForFaculty(req.user),
    };
  }

  @Post(':id/review')
  async review(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuickWorkReviewDto,
  ) {
    return {
      success: true,
      data: await this.quickWork.review(req.user, id, dto),
    };
  }

  /** Accept or decline coordinating an activity the students are still preparing. */
  @Post(':id/coordination')
  async coordination(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuickWorkJoinDto,
  ) {
    return {
      success: true,
      data: await this.quickWork.respondAsFaculty(req.user, id, dto.accept),
    };
  }
}

/**
 * Accept / decline from the request emails, without signing in. The sealed token names the log and
 * either the faculty email or the teammate's row; opening the page (GET) never records anything.
 */
@Controller('quick-work/email-response')
export class QuickWorkEmailResponseController {
  constructor(private readonly quickWork: QuickWorkService) {}

  @Get()
  async preview(@Query('token') token: string) {
    return {
      success: true,
      data: await this.quickWork.emailResponsePreview(token ?? ''),
    };
  }

  @Post()
  async respond(@Body() dto: QuickWorkEmailResponseDto) {
    return {
      success: true,
      data: await this.quickWork.emailRespond(dto.token, dto.accept),
    };
  }
}

/** CIEL PK admin: oversight of every log, faculty reassignment, and review when faculty cannot. */
@Controller('admin/quick-work')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminQuickWorkController {
  constructor(private readonly quickWork: QuickWorkService) {}

  @Get()
  async list(@Query() q: AdminQuickWorkListQuery) {
    return { success: true, data: await this.quickWork.listForAdmin(q) };
  }

  @Get('export')
  async export(@Query() q: AdminQuickWorkListQuery) {
    return { success: true, data: await this.quickWork.exportForAdmin(q) };
  }

  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.quickWork.getForAdmin(id) };
  }

  @Patch(':id/faculty')
  async reassign(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminQuickWorkReassignDto,
  ) {
    return {
      success: true,
      data: await this.quickWork.reassignFaculty(req.user, id, dto),
    };
  }

  @Post(':id/review')
  async review(
    @Request() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuickWorkReviewDto,
  ) {
    return {
      success: true,
      data: await this.quickWork.adminReview(req.user, id, dto),
    };
  }
}

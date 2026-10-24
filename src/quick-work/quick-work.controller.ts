import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { SubscriptionActiveGuard } from '../student-subscription/subscription-active.guard';
import { QuickWorkService } from './quick-work.service';
import {
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
}

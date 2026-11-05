import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { RecordIdsService } from './record-ids.service';

/** CIEL PK admin: university registry, public-id backfill and lookup. */
@Controller('admin/record-ids')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class RecordIdsAdminController {
  constructor(private readonly recordIds: RecordIdsService) {}

  @Get('universities')
  async universities() {
    return this.recordIds.listUniversities();
  }

  @Post('universities')
  async createUniversity(
    @Body()
    body: {
      name?: string;
      code?: string;
      organizationId?: string | null;
      aliases?: string[];
    },
  ) {
    if (!body?.name?.trim() || !body?.code?.trim()) {
      throw new BadRequestException('name and code are required');
    }
    try {
      return await this.recordIds.createUniversity({
        name: body.name,
        code: body.code,
        organizationId: body.organizationId,
        aliases: body.aliases,
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Patch('universities/:id')
  async updateUniversity(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      code?: string;
      organizationId?: string | null;
      aliases?: string[];
      active?: boolean;
    },
  ) {
    try {
      const saved = await this.recordIds.updateUniversity(id, body ?? {});
      if (!saved) throw new NotFoundException('University not found');
      return saved;
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new BadRequestException((err as Error).message);
    }
  }

  /**
   * Dry run by default — pass { "dryRun": false } to write. Safe to repeat. Pass { "limit": 500 }
   * to stamp at most that many records per call (the response says how many remain).
   */
  @Post('backfill')
  async backfill(@Body() body: { dryRun?: boolean; limit?: number }) {
    return this.recordIds.backfill(
      body?.dryRun !== false,
      Number(body?.limit) || undefined,
    );
  }

  @Get('unmatched')
  async unmatched() {
    return this.recordIds.unmatched();
  }

  @Get('lookup/:publicId')
  async lookup(@Param('publicId') publicId: string) {
    const found = await this.recordIds.lookup(publicId);
    if (!found) throw new NotFoundException('No record has this id');
    return found;
  }
}

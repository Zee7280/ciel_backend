import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { MailService } from './mail.service';
import { FileInterceptor } from '@nestjs/platform-express';

/** Raw multipart body; validated by hand below because `to` may arrive as a string or an array. */
type AdminSendEmailBody = Record<string, unknown>;

@Controller('admin/email')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminMailController {
  constructor(private readonly mailService: MailService) {}

  @Post('send')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: 3 * 1024 * 1024 },
    }),
  )
  async send(
    @UploadedFile() image?: Express.Multer.File,
    @Body() dto?: AdminSendEmailBody,
  ) {
    const to = this.toArray(dto?.to);
    const subject = this.asString(dto?.subject ?? '').trim();
    const messageHtml = this.asString(dto?.messageHtml ?? '').trim();
    const messageText = dto?.messageText
      ? this.asString(dto.messageText)
      : undefined;

    if (!to.length) {
      throw new BadRequestException('Recipient(s) required');
    }
    if (!subject) {
      throw new BadRequestException('Subject required');
    }
    if (!messageHtml) {
      throw new BadRequestException('Message required');
    }

    const result = await this.mailService.sendAdminComposedEmail({
      to,
      subject,
      messageHtml,
      messageText,
      image,
    });
    return {
      success: result.failed.length === 0,
      sent: result.sent.length,
      failed: result.failed.length,
      skipped: result.skipped.length,
      failedRecipients: result.failed,
      skippedRecipients: result.skipped,
    };
  }

  /** Same coercion as `String(v)` for form fields that are strings in practice. */
  private asString(v: unknown): string {
    return String(v as string);
  }

  private toArray(v: unknown): string[] {
    if (Array.isArray(v)) {
      return v.map((x) => String(x).trim()).filter(Boolean);
    }
    if (typeof v === 'string') {
      const s = v.trim();
      return s ? [s] : [];
    }
    return [];
  }
}

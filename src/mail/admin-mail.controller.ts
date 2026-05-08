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
import { AdminSendEmailDto } from './dto/admin-send-email.dto';
import { FileInterceptor } from '@nestjs/platform-express';

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
        @Body() dto?: any,
    ) {
        const to = this.toArray(dto?.to);
        const subject = String(dto?.subject ?? '').trim();
        const messageHtml = String(dto?.messageHtml ?? '').trim();
        const messageText = dto?.messageText ? String(dto.messageText) : undefined;

        if (!to.length) {
            throw new BadRequestException('Recipient(s) required');
        }
        if (!subject) {
            throw new BadRequestException('Subject required');
        }
        if (!messageHtml) {
            throw new BadRequestException('Message required');
        }

        await this.mailService.sendAdminComposedEmail({
            to,
            subject,
            messageHtml,
            messageText,
            image,
        });
        return { success: true };
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


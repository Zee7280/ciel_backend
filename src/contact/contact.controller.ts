import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { MailService } from '../mail/mail.service';
import { SendContactDto } from './dto/send-contact.dto';

@Controller('contact')
@UseGuards(RateLimitGuard)
export class ContactController {
    constructor(private readonly mailService: MailService) {}

    @Post('send')
    @RateLimit({ name: 'contact-send', limit: 5, windowMs: 60 * 60_000, by: 'ip' })
    async send(@Body() dto: SendContactDto) {
        await this.mailService.sendContactInquiry(dto.name, dto.email, dto.subject, dto.message);
        return {
            success: true,
            message: 'Your message has been sent. We will get back to you soon.',
        };
    }
}

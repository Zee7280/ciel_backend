import { Body, Controller, Post } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { SendContactDto } from './dto/send-contact.dto';

@Controller('contact')
export class ContactController {
    constructor(private readonly mailService: MailService) {}

    @Post('send')
    async send(@Body() dto: SendContactDto) {
        await this.mailService.sendContactInquiry(dto.name, dto.email, dto.subject, dto.message);
        return {
            success: true,
            message: 'Your message has been sent. We will get back to you soon.',
        };
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
    private transporter: nodemailer.Transporter;
    private readonly logger = new Logger(MailService.name);

    constructor(private configService: ConfigService) {
        this.transporter = nodemailer.createTransport({
            host: 'smtpout.secureserver.net', // Correct GoDaddy SMTP host
            port: 465,
            secure: true, // Use SSL/TLS
            auth: {
                user: this.configService.get<string>('MAIL_USER'),
                pass: this.configService.get<string>('MAIL_PASS'),
            },
        });
    }

    async sendWelcomeEmail(to: string, name: string) {
        const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';

        const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Welcome to Ciel, ${name}!</h2>
        <p>We are thrilled to have you join our platform. Ciel is dedicated to connecting passionate individuals with meaningful opportunities.</p>
        <p>You can now log in to your account and start exploring opportunities that match your interests.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="https://cielpk.com/login" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Get Started</a>
        </div>
        <p>If you have any questions, feel free to reach out to our support team.</p>
        <p>Best regards,<br>The Ciel Team</p>
      </div>
    `;

        try {
            await this.transporter.sendMail({
                from,
                to,
                subject: 'Welcome to Ciel PK !',
                html,
            });
            this.logger.log(`Welcome email sent to ${to}`);
        } catch (error) {
            this.logger.error(`Failed to send welcome email to ${to}`, error.stack);
            // We don't throw here to avoid failing the signup process just because of an email error
        }
    }
}

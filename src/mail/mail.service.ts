import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
    private transporter: nodemailer.Transporter;
    private readonly logger = new Logger(MailService.name);

    constructor(private configService: ConfigService) {
        this.transporter = nodemailer.createTransport({
            host: this.configService.get<string>('MAIL_HOST') || 'smtpout.secureserver.net',
            port: this.configService.get<number>('MAIL_PORT') || 465,
            secure: this.configService.get<string>('MAIL_SECURE') === 'true' || this.configService.get<number>('MAIL_PORT') === 465,
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

    async sendTeamMemberOtp(to: string, otp: string) {
        const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';

        const html = `
      <div style="font-family: Arial, sans-serif; text-align: center; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Team Verification Code</h2>
        <p>Your verification code for Ciel PK is:</p>
        <h1 style="color: #2563eb; letter-spacing: 5px; font-size: 48px; margin: 20px 0;">${otp}</h1>
        <p style="color: #666;">This code will expire in 10 minutes.</p>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you didn't request this code, please ignore this email.</p>
      </div>
    `;

        try {
            await this.transporter.sendMail({
                from,
                to,
                subject: 'Your Ciel PK Verification Code',
                html,
            });
            this.logger.log(`OTP email sent to ${to}`);
        } catch (error) {
            this.logger.error(`Failed to send OTP email to ${to}`, error.stack);
        }
    }

    async sendTeamMemberInvite(to: string) {
        const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';

        const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">You've been added to a team!</h2>
        <p>A fellow student has added you as a team member for an opportunity on Ciel PK.</p>
        <p>Please log in to your dashboard to confirm your participation and start contributing.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="https://cielpk.com/login" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Login to Dashboard</a>
        </div>
        <p>Best regards,<br>The Ciel Team</p>
      </div>
    `;

        try {
            await this.transporter.sendMail({
                from,
                to,
                subject: "You've been added to a team on Ciel PK!",
                html,
            });
            this.logger.log(`Team invite email sent to ${to}`);
        } catch (error) {
            this.logger.error(`Failed to send team invite email to ${to}`, error.stack);
        }
    }
}

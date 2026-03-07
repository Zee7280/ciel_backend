import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(MailService.name);

  constructor(private configService: ConfigService) {
    const user = this.configService.get<string>('MAIL_USER');
    const pass = this.configService.get<string>('MAIL_PASS');
    const host = this.configService.get<string>('MAIL_HOST');
    const port = this.configService.get<number>('MAIL_PORT');

    this.logger.log(`MailService init. USER found: ${!!user}, PASS found: ${!!pass}, HOST: ${host}, PORT: ${port}`);

    if (!user || !pass) {
      this.logger.error('CRITICAL: MAIL_USER or MAIL_PASS is missing from ConfigService!');
      // Check process.env directly as fallback
      const directUser = process.env.MAIL_USER;
      const directPass = process.env.MAIL_PASS;
      this.logger.log(`Direct process.env check - USER: ${!!directUser}, PASS: ${!!directPass}`);
    }

    this.transporter = nodemailer.createTransport({
      host: host || 'smtpout.secureserver.net',
      port: Number(port) || 465,
      secure: this.configService.get<string>('MAIL_SECURE') === 'true' || Number(port) === 465,
      auth: {
        user: user || process.env.MAIL_USER,
        pass: pass || process.env.MAIL_PASS,
      },
    });

    // Verify connection configuration
    this.transporter.verify((error, success) => {
      if (error) {
        this.logger.error('Transporter verification failed:', error.message);
      } else {
        this.logger.log('Transporter is ready to take our messages');
      }
    });
  }

  async sendWelcomeEmail(to: string, name: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Welcome to CIEL, ${name}!</h2>
        <p>We're excited to have you join a platform built to transform community engagement into measurable, credible impact.</p>
        <p>CIEL is not just another volunteer portal. We are a verification and impact intelligence platform that ensures every hour contributed is authenticated, documented, and aligned with the Sustainable Development Goals (SDGs).</p>
        
        <h4 style="color: #4CAF50;">What makes CIEL different:</h4>
        <ul style="color: #555; line-height: 1.6;">
            <li>Verified participation with secure identity authentication</li>
            <li>Structured hour tracking and engagement validation</li>
            <li>SDG-mapped impact reporting</li>
            <li>Audit-ready documentation for institutions and partners</li>
            <li>Transparent, credible certification</li>
        </ul>

        <p>Our goal is to bridge individuals, institutions, and organizations through structured, accountable community engagement, turning service into measurable outcomes.</p>
        <p>You can now log in to your account and start exploring verified opportunities aligned with your interests.</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="https://cielpk.com/login" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Get Started</a>
        </div>

        <p>If you need assistance, our support team is here to guide you every step of the way.</p>
        <p>Welcome to a platform where impact is not just done, it is documented and recognized.</p>
        
        <p style="margin-top: 30px;">Warm regards,<br><strong>The CIEL Team</strong></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Welcome to CIEL – Where Impact is Verified',
        html,
      });
      this.logger.log(`Welcome email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send welcome email to ${to}`, error.stack);
      // We don't throw here to avoid failing the signup process just because of an email error
    }
  }

  async sendPasswordResetEmail(to: string, resetLink: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Reset Your Password</h2>
        <p>We received a request to reset your password for your Ciel PK account.</p>
        <p>Click the button below to set a new password. This link will expire in 1 hour.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
        </div>
        <p style="color: #666; font-size: 14px;">If the button doesn't work, you can copy and paste this link into your browser:</p>
        <p style="color: #2563eb; font-size: 14px; word-break: break-all;">${resetLink}</p>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you didn't request a password reset, please ignore this email or contact support if you have concerns.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Reset Your Ciel PK Password',
        html,
      });
      this.logger.log(`Password reset email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${to}`, error.stack);
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

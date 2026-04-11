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

  async sendFacultyApprovalRequest(
    to: string,
    studentName: string,
    projectTitle: string,
    participationId: string
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const approvalLink = `https://cielpk.com/login`; // Assuming login for now, or faculty dashboard

    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #f0f0f0; border-radius: 12px; background-color: #ffffff; color: #333;">
            <div style="text-align: center; margin-bottom: 25px;">
                <h2 style="color: #2c3e50; margin-bottom: 5px;">Project Approval Required</h2>
                <div style="width: 50px; height: 3px; background: #4CAF50; margin: 0 auto;"></div>
            </div>
            
            <p>Dear Faculty Member,</p>
            <p>Greetings from <strong>Community Impact Education Lab (CIEL)</strong>.</p>
            
            <p>Your student, <strong>${studentName}</strong>, has selected a community engagement project and listed you as the supervising faculty.</p>
            
            <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #4CAF50; margin: 20px 0;">
                <p style="margin: 0;"><strong>Project:</strong> ${projectTitle}</p>
            </div>

            <p>Kindly review and approve the project so the student can begin:</p>
            
            <div style="text-align: center; margin: 35px 0;">
                <a href="${approvalLink}" style="background-color: #4CAF50; color: white; padding: 14px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(76, 175, 80, 0.2); transition: background-color 0.3s;">👉 Click here to Review & Approve</a>
            </div>

            <p>Your approval will enable the student to proceed with the project and reporting.</p>
            
            <p>Thank you for your support.</p>
            
            <p style="margin-top: 40px; border-top: 1px solid #eee; padding-top: 20px;">
                Warm regards,<br>
                <span style="color: #4CAF50; font-weight: bold;">CIEL Team</span>
            </p>
        </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Project Approval Required – CIEL`,
        html,
      });
      this.logger.log(`Faculty approval request email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send faculty approval request email to ${to}`, error.stack);
    }
  }

  async sendFacultyCollaboratorNotice(
    to: string,
    studentName: string,
    projectTitle: string
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #f0f0f0; border-radius: 12px; background-color: #ffffff; color: #333;">
            <div style="text-align: center; margin-bottom: 25px;">
                <h2 style="color: #2c3e50; margin-bottom: 5px;">Collaborating Supervisor Notice</h2>
                <div style="width: 50px; height: 3px; background: #3498db; margin: 0 auto;"></div>
            </div>
            
            <p>Dear Faculty Member,</p>
            <p>Greetings from <strong>Community Impact Education Lab (CIEL)</strong>.</p>
            
            <p>You have been added as a **Secondary/Collaborating Faculty Supervisor** for the following project:</p>
            
            <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3498db;">
                <p style="margin: 0 0 10px 0;"><strong>Student:</strong> ${studentName}</p>
                <p style="margin: 0;"><strong>Project:</strong> ${projectTitle}</p>
            </div>

            <p>You can view and monitor this project on the SEAL platform. **Note that your official approval is not required** as you are listed in a collaborating capacity.</p>
            
            <p>Thank you for your engagement.</p>
            
            <p style="margin-top: 40px; border-top: 1px solid #eee; padding-top: 20px;">
                Warm regards,<br>
                <span style="color: #2c3e50; font-weight: bold;">CIEL Team</span>
            </p>
        </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Collaborating Supervisor Notice – CIEL`,
        html,
      });
      this.logger.log(`Faculty collaborator notice email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send faculty collaborator notice email to ${to}`, error.stack);
    }
  }

  async sendApplicationSubmitted(
    to: string,
    studentName: string,
    projectTitle: string
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #333;">Application Submitted Successfully</h2>
            <p>Hi ${studentName},</p>
            <p>Your application for <strong>${projectTitle}</strong> has been submitted successfully.</p>
            <p>Your primary faculty supervisor will review and approve your participation.</p>
            <p>Status: <strong>Pending Faculty Approval</strong></p>
            <p>Best regards,<br>The Ciel Team</p>
        </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Application Submitted – Pending Approval – SEAL Platform`,
        html,
      });
      this.logger.log(`Application submission confirmation email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send application submission confirmation email to ${to}`, error.stack);
    }
  }

  async sendFacultyInvite(to: string, studentName: string, projectName: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const signupLink = `https://cielpk.com/signup?role=faculty&email=${encodeURIComponent(to)}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <p>Dear Faculty Member,</p>
        <p>Greetings from Community Impact Education Lab (CIEL).</p>
        <p><strong>${studentName}</strong> has requested you to be their Faculty Supervisor for the project: <strong>${projectName}</strong> on the SEAL Platform.</p>
        <p>As a Faculty Supervisor, you will be able to review student progress, monitor engagement metrics, and provide official institutional approval for their work.</p>
        <p>If you don't have an account yet, please sign up using the link below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${signupLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Sign Up as Faculty</a>
        </div>
        <p>Your support is vital in ensuring impactful student engagement.</p>
        <p>Warm regards,<br><strong>CIEL Team</strong></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Faculty Supervisor Invitation – CIEL`,
        html,
      });
      this.logger.log(`Faculty invite email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send faculty invite email to ${to}`, error.stack);
    }
  }

  /**
   * Liaison/partner verification links: default to marketing site (FRONTEND_URL + FRONTEND_VERIFY_PATH).
   * The frontend page should call GET {API}/api/v1/verifications/verify?token=… (or open it in the browser).
   * Set VERIFICATION_EMAIL_LINK=api to put the API URL in the email instead (no frontend page needed).
   */
  private buildProjectVerificationLink(token: string): string {
    const enc = encodeURIComponent(token);
    const linkTarget = (this.configService.get<string>('VERIFICATION_EMAIL_LINK') || 'frontend').toLowerCase();
    if (linkTarget === 'api') {
      const raw = this.configService.get<string>('API_URL') || 'https://api.cielpk.com';
      const base = raw.replace(/\/+$/, '');
      const withApiV1 = base.endsWith('/api/v1') ? base : `${base}/api/v1`;
      return `${withApiV1}/verifications/verify?token=${enc}`;
    }
    const frontend = (this.configService.get<string>('FRONTEND_URL') || 'https://cielpk.com').replace(/\/+$/, '');
    const pathRaw = this.configService.get<string>('FRONTEND_VERIFY_PATH') || '/verify-project';
    const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
    return `${frontend}${path}?token=${enc}`;
  }

  async sendLiaisonVerification(to: string, projectTitle: string, token: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const verifyLink = this.buildProjectVerificationLink(token);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Liaison Verification Required</h2>
        <p>Hello!</p>
        <p>A student has claimed you as their Institutional Liaison for the project <strong>${projectTitle}</strong>.</p>
        <p>Please click the button below to verify and approve it:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verifyLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Verify Project</a>
        </div>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you did not authorize this, you may ignore this email.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Project Verification Required: ${projectTitle}`,
        html,
      });
      this.logger.log(`Liaison verification email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send liaison verification email to ${to}`, error.stack);
    }
  }

  async sendPartnerVerification(to: string, projectTitle: string, token: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const verifyLink = this.buildProjectVerificationLink(token);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Partner Verification Required</h2>
        <p>Hello!</p>
        <p>A student has claimed to be doing a project at your organization: <strong>${projectTitle}</strong></p>
        <p>Please click the button below to verify the site and collaboration:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verifyLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Verify Collaboration</a>
        </div>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you are unaware of this, you may safely ignore this email.</p>
        <p style="font-size: 12px; color: #666;">This link only works after the faculty supervisor has approved the proposal.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Partner Verification Required: ${projectTitle}`,
        html,
      });
      this.logger.log(`Partner verification email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send partner verification email to ${to}`, error.stack);
    }
  }

  /** Faculty supervisor magic link for student-submitted opportunities (GET …/verifications/verify?token=…). */
  /** Notify student when their proposal is rejected from the faculty approvals queue. */
  async sendStudentOpportunityRejectedByFaculty(
    to: string,
    projectTitle: string,
    facultyFeedback?: string | null,
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const esc = (s: string) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const feedbackBlock =
      facultyFeedback && facultyFeedback.trim()
        ? `<p style="margin:16px 0 0 0;"><strong>Feedback from your faculty supervisor:</strong></p><p style="background:#f9fafb;border-left:4px solid #ef4444;padding:12px 14px;margin:8px 0 0 0;color:#374151;">${esc(
            facultyFeedback.trim(),
          )}</p>`
        : '';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Update on your opportunity</h2>
        <p>Your faculty supervisor did not approve the following submission on CIEL:</p>
        <p style="font-size:16px;"><strong>${esc(projectTitle)}</strong></p>
        ${feedbackBlock}
        <p style="margin-top:20px;color:#555;">You can revise and submit again from your dashboard if your program allows it.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Opportunity not approved: ${projectTitle}`,
        html,
      });
      this.logger.log(`Student faculty-rejection notice sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send student faculty-rejection email to ${to}`, error.stack);
    }
  }

  async sendFacultyStudentOpportunityVerification(to: string, projectTitle: string, token: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const verifyLink = this.buildProjectVerificationLink(token);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Faculty approval required</h2>
        <p>Hello,</p>
        <p>A student has submitted a community opportunity and listed you as the supervising faculty for <strong>${projectTitle}</strong>.</p>
        <p>Please review and approve using the link below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verifyLink}" style="background-color: #2563eb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Approve as faculty supervisor</a>
        </div>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you did not expect this email, you can ignore it.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Faculty approval required: ${projectTitle}`,
        html,
      });
      this.logger.log(`Faculty student-opportunity verification email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send faculty verification email to ${to}`, error.stack);
    }
  }

  async sendOtpEmail(to: string, otp: string): Promise<void> {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const esc = (s: string) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const brand = '#4CAF50';
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your CIEL verification code</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;-webkit-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f0f2f5;padding:40px 16px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 4px 24px rgba(15,23,42,0.06);">
          <tr>
            <td style="height:4px;background-color:${brand};background-image:linear-gradient(90deg,${brand},#2e7d32);line-height:4px;font-size:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <p style="margin:0 0 4px 0;font-size:13px;font-weight:600;letter-spacing:0.12em;color:${brand};text-transform:uppercase;">CIEL</p>
              <p style="margin:0;font-size:12px;color:#6b7280;">Community Impact Education Lab</p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px 32px;">
              <h1 style="margin:0 0 12px 0;font-size:22px;font-weight:600;color:#111827;line-height:1.3;">Verify your email</h1>
              <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#4b5563;">Use the verification code below to complete your CIEL account setup. For your security, do not share this code with anyone.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
                <tr>
                  <td align="center" style="padding:24px 20px;">
                    <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;color:#166534;text-transform:uppercase;">Your code</p>
                    <p style="margin:0;font-family:'Courier New',Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:#14532d;line-height:1.2;">${esc(otp)}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:20px 0 0 0;font-size:14px;line-height:1.5;color:#6b7280;">
                <span style="color:#374151;font-weight:500;">Expires in 5 minutes.</span> If the code stops working, request a new one from the sign-up page.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f3f4f6;">
                <tr>
                  <td style="padding-top:20px;">
                    <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#9ca3af;">Didn&rsquo;t request this email? You can safely ignore it. Your account will not be changed.</p>
                    <p style="margin:0;font-size:12px;color:#9ca3af;">Questions? <a href="mailto:support@cielpk.com" style="color:${brand};text-decoration:none;font-weight:500;">support@cielpk.com</a></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0 0;font-size:11px;color:#9ca3af;text-align:center;max-width:560px;">This is an automated message from CIEL PK. Please do not reply to this email.</p>
      </td>
    </tr>
  </table>
</body>
</html>
    `;
    const text = `CIEL — Verify your email\n\nYour verification code: ${otp}\n\nThis code expires in 5 minutes.\n\nIf you didn't request this, you can ignore this email.\nSupport: support@cielpk.com`;
    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Your CIEL Verification Code',
        text,
        html,
      });
      this.logger.log(`OTP email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send OTP email to ${to}`, error.stack);
      throw error;
    }
  }

  /** Public contact form: delivers inquiry to support@cielpk.com */
  async sendContactInquiry(name: string, email: string, subject: string, message: string): Promise<void> {
    const from = this.configService.get<string>('MAIL_FROM') || 'Ciel <no-reply@ciel.com>';
    const to = 'support@cielpk.com';
    const esc = (s: string) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Website contact form</h2>
        <p><strong>Name:</strong> ${esc(name)}</p>
        <p><strong>Email:</strong> ${esc(email)}</p>
        <p><strong>Subject:</strong> ${esc(subject)}</p>
        <p><strong>Message:</strong></p>
        <p style="white-space: pre-wrap; color: #444; line-height: 1.5;">${esc(message)}</p>
      </div>
    `;
    const text = `Name: ${name}\nEmail: ${email}\nSubject: ${subject}\n\n${message}`;
    try {
      await this.transporter.sendMail({
        from,
        to,
        replyTo: email,
        subject: `[CIEL Contact] ${String(subject).slice(0, 150)}`,
        text,
        html,
      });
      this.logger.log(`Contact inquiry sent to ${to} from ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send contact inquiry from ${email}`, error.stack);
      throw error;
    }
  }
}

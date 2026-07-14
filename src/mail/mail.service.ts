import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';

/** Optional structured summary for faculty/partner verification emails. */
export interface OpportunityVerificationEmailDetails {
  opportunityId?: string;
  studentName?: string;
  studentUniversity?: string;
  /** Student / creator university line for faculty summary emails. */
  institutionName?: string;
  /** Supervision.supervisor_name — greeting "Dear …" for faculty reviewer. */
  facultyReviewerName?: string;
  /** Supervision.faculty_department — dedicated bullet in faculty approval email. */
  departmentName?: string;
  facultyAuthorName?: string;
  facultyAuthorEmail?: string;
  mode?: string;
  typesLine?: string;
  timelineSummary?: string;
  locationSummary?: string;
  sdgLabel?: string;
  partnerOrganization?: string;
  /** Greeting for partner verification (contact person or organization name). */
  partnerRecipientName?: string;
  executionSummary?: string;
  facultySupervisionLine?: string;
  objectivesPreview?: string;
  /** Display string for volunteers required (e.g. "12" or "Not specified"). */
  volunteersRequired?: string;
}

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

  private wrapOfficialTemplate(opts: { heading: string; bodyHtml: string }): string {
    const headingEsc = this.escHtmlPlain(opts.heading);
    const logoUrl = this.buildFrontendLink('/iel-pk-logo.png', {});
    return `
      <div style="background: #f8fafc; padding: 32px 16px; font-family: Arial, sans-serif;">
        <div style="max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          
          <!-- Header Section -->
       
            <div style="display: flex; align-items: center; gap: 16px;">
                <div style="color: #ffffff; font-weight: 600; font-size: 14px; margin-bottom: 4px;">COMMUNITY IMPACT EDUCATION LAB</div>
            </div>
    

          <!-- Content Section -->
          <div style="padding: 28px;">
            <div style="color: #374151; font-size: 15px; line-height: 1.6;">
              ${opts.bodyHtml}
            </div>

            <!-- Separator -->
            <div style="margin: 28px 0; height: 1px; background: #e5e7eb;"></div>

            <!-- Support & Contact Section -->
            <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
              <table role="presentation" width="100%" style="border-collapse: collapse;">
                <tr>
                  <td style="vertical-align: top; padding-right: 16px;">
                    <p style="margin: 0 0 12px 0; color: #374151; font-size: 14px; font-weight: 600;">Need Help?</p>
                    <div style="color: #6b7280; font-size: 13px; line-height: 1.5;">
                      Email: <a href="mailto:support@cielpk.com" style="color: #3b82f6; text-decoration: none;">support@cielpk.com</a><br />
                      Website: <a href="${this.buildFrontendLink('/', {})}" style="color: #3b82f6; text-decoration: none;">cielpk.com</a><br />
                      WhatsApp (24/7): <a href="https://wa.me/923712243575" style="color: #059669; text-decoration: none;">0371-2243575</a>
                    </div>
                  </td>
                  <td style="vertical-align: top; text-align: right;">
                    <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.4;">
                      Official communication from<br />
                      <strong style="color: #374151;">Community Impact Education Lab (CIEL PK)</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding: 16px 0;">
              <p style="margin: 0; color: #374151; font-size: 14px; line-height: 1.5;">
                Regards,<br />
                <strong>CIEL PK Team</strong>
              </p>
            </div>
          </div>
        </div>
        
        <!-- Footer Note -->
        <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
          This email was sent by CIEL PK. Please do not reply to this email.
        </div>
      </div>
    `;
  }

  async sendAdminComposedEmail(
    to: string,
    subject: string,
    message: string,
  ): Promise<void>;
  async sendAdminComposedEmail(opts: {
    to: string[];
    subject: string;
    messageHtml: string;
    messageText?: string;
    image?: Express.Multer.File;
  }): Promise<void>;
  async sendAdminComposedEmail(
    arg1: string | { to: string[]; subject: string; messageHtml: string; messageText?: string; image?: Express.Multer.File },
    arg2?: string,
    arg3?: string,
  ): Promise<void> {
    const opts =
      typeof arg1 === 'string'
        ? {
            to: [arg1],
            subject: String(arg2 ?? ''),
            messageHtml: `<p>${this.escHtmlPlain(String(arg3 ?? '')).replace(/\r?\n/g, '<br />')}</p>`,
          }
        : arg1;

    const from =
      this.configService.get<string>('MAIL_ADMIN_FROM') ||
      'CIEL Admin <admin@cielpk.com>';
    const subjectTrim = (opts.subject || '').trim();

    const sanitizedBody = this.sanitizeAdminHtml(opts.messageHtml || '');
    const bodyWrapped = this.wrapOfficialTemplate({
      heading: subjectTrim || 'Official communication',
      bodyHtml: `<div style="margin:0;color:#0f172a;font-size:14px;line-height:1.7;">${sanitizedBody}</div>`,
    });

    const text = (opts.messageText || this.htmlToText(sanitizedBody) || '').trim();
    const toList = (opts.to || []).map((x) => String(x).trim()).filter(Boolean);

    const attachments: any[] = [];
    if (opts.image?.buffer?.length) {
      attachments.push({
        filename: opts.image.originalname || 'image',
        content: opts.image.buffer,
        contentType: opts.image.mimetype || 'application/octet-stream',
      });
    }

    await this.transporter.sendMail({
      from,
      to: toList.join(','),
      subject: subjectTrim || 'CIEL PK message',
      replyTo: from,
      text,
      html: bodyWrapped,
      attachments: attachments.length ? attachments : undefined,
    });
    this.logger.log(`Admin composed email sent to ${toList.join(', ')}`);
  }

  private sanitizeAdminHtml(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        'ul',
        'ol',
        'li',
        'a',
        'span',
        'div',
        'h1',
        'h2',
        'h3',
        'blockquote',
      ],
      allowedAttributes: {
        a: ['href', 'target', 'rel'],
        span: ['style'],
        div: ['style'],
        p: ['style'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      transformTags: {
        a: (tagName, attribs) => {
          const href = attribs.href || '';
          const safeRel = 'noopener noreferrer';
          return {
            tagName,
            attribs: {
              ...attribs,
              href,
              target: '_blank',
              rel: safeRel,
            },
          };
        },
      },
    });
  }

  private htmlToText(html: string): string {
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  // (implementation lives in overload above)

  async sendWelcomeEmail(to: string, name: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const nameEsc = this.escHtmlPlain(name?.trim() ? name.trim() : 'there');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Welcome to CIEL PK, ${nameEsc}</h2>
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
        <p>Sign in to your account to explore verified opportunities that match your interests and your institution&rsquo;s requirements.</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${this.buildFrontendLink('/login', {})}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Sign in to CIEL PK</a>
        </div>

        <p>If you need help, contact us at <a href="mailto:support@cielpk.com" style="color:#4CAF50;">support@cielpk.com</a>.</p>
        <p>Thank you for joining Community Impact Education Lab (CIEL)—where service is verified, documented, and recognised.</p>
        
        <p style="margin-top: 30px;">Warm regards,<br><strong>The CIEL PK Team</strong><br><span style="font-size:13px;color:#666;">Community Impact Education Lab</span></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Welcome to CIEL PK — your account is ready',
        html,
      });
      this.logger.log(`Welcome email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send welcome email to ${to}`, error.stack);
      // We don't throw here to avoid failing the signup process just because of an email error
    }
  }

  async sendPasswordResetEmail(to: string, resetLink: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Reset your CIEL PK password</h2>
        <p>We received a request to reset the password for your Community Impact Education Lab (CIEL PK) account.</p>
        <p>Use the button below to choose a new password. For security, this link expires after one hour.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
        </div>
        <p style="color: #666; font-size: 14px;">If the button doesn't work, you can copy and paste this link into your browser:</p>
        <p style="color: #2563eb; font-size: 14px; word-break: break-all;">${resetLink}</p>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you did not request a password reset, you can ignore this message. Your password will stay the same. For concerns, contact <a href="mailto:support@cielpk.com">support@cielpk.com</a>.</p>
        <p style="margin-top:24px;font-size:13px;color:#666;">Regards,<br><strong>CIEL PK</strong> (Community Impact Education Lab)</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Reset your CIEL PK password',
        html,
      });
      this.logger.log(`Password reset email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${to}`, error.stack);
    }
  }

  async sendExecutingOrganizationVerificationEmail(to: string, projectTitle: string, signInPortalLink: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const titleEsc = this.escHtmlPlain(projectTitle);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Executing Organization Verification Required</h2>
        <p>An opportunity has been submitted on CIEL PK and your organization was listed as the executing organization.</p>
        <p><strong>Opportunity:</strong> ${titleEsc}</p>
        <p><strong>Important:</strong> sign in to CIEL PK using <strong>this same email address</strong>, open the opportunity under <strong>Partner → My requests</strong>, review the details, then click <strong>Confirm execution details</strong>. Verification is not done from a public link.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${signInPortalLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Sign in to CIEL PK</a>
        </div>
        <p style="color: #666; font-size: 14px;">If the button does not work, copy and paste this URL into your browser:</p>
        <p style="color: #2563eb; font-size: 14px; word-break: break-all;">${signInPortalLink}</p>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you did not expect this email, you can ignore it or contact support.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Execution verification required: ${projectTitle}`,
        html,
      });
      this.logger.log(`Executing organization verification email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send executing organization verification email to ${to}`, error.stack);
    }
  }

  async sendPartnerOpportunityNotice(to: string, projectTitle: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const titleEsc = this.escHtmlPlain(projectTitle);
    const dashboardLink = this.buildFrontendLink('/login', {});

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">You are listed on a CIEL PK opportunity</h2>
        <p>Your email address appears on the record for <strong>${titleEsc}</strong> on CIEL PK (Community Impact Education Lab).</p>
        <p>If you have a partner or liaison role for this activity, sign in with this email address to review details and complete any steps assigned to you.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${dashboardLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Sign in to CIEL PK</a>
        </div>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you did not expect this email, you can ignore it or contact support.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — you are referenced on: ${projectTitle}`,
        html,
      });
      this.logger.log(`Partner opportunity notice email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send partner opportunity notice email to ${to}`, error.stack);
    }
  }

  async sendTeamMemberOtp(to: string, otp: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';

    const html = `
      <div style="font-family: Arial, sans-serif; text-align: center; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Team verification code</h2>
        <p>Your one-time verification code for CIEL PK is:</p>
        <h1 style="color: #2563eb; letter-spacing: 5px; font-size: 48px; margin: 20px 0;">${otp}</h1>
        <p style="color: #666;">This code expires in 10 minutes. If it expires, request a new code from the verification screen.</p>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you did not request this code, you can ignore this email.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Your CIEL PK team verification code',
        html,
      });
      this.logger.log(`OTP email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send OTP email to ${to}`, error.stack);
    }
  }

  async sendTeamMemberInvite(to: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const loginLink = this.buildFrontendLink('/login', {});

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">You have been added to a project team</h2>
        <p>A fellow student has added you as a team member for an opportunity on CIEL PK.</p>
        <p>Sign in with this email address to confirm your role and access the project workspace.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${loginLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Sign in to CIEL PK</a>
        </div>
        <p style="font-size:13px;color:#666;">Questions? <a href="mailto:support@cielpk.com">support@cielpk.com</a></p>
        <p>Best regards,<br><strong>The CIEL PK Team</strong></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'A student added you to their team on CIEL PK',
        html,
      });
      this.logger.log(`Team invite email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send team invite email to ${to}`, error.stack);
    }
  }

  async sendTeamMemberAddedToProject(params: {
    to: string;
    leadName: string;
    projectTitle: string;
    teamDisplayName?: string | null;
    projectId: string;
  }) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const portalLink = this.buildFrontendLink(
      `/dashboard/student/projects/${encodeURIComponent(params.projectId)}/participation`,
      {},
    );
    const leadEsc = this.escHtmlPlain(params.leadName?.trim() || 'Your team lead');
    const titleEsc = this.escHtmlPlain(params.projectTitle);
    const teamLine = params.teamDisplayName?.trim()
      ? `<p>Team: <strong>${this.escHtmlPlain(params.teamDisplayName.trim())}</strong></p>`
      : '';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">You were added to a project team</h2>
        <p>${leadEsc} added you to <strong>${titleEsc}</strong> on CIEL PK.</p>
        ${teamLine}
        <p>Open your member portal to log attendance. Your team lead submits the final report.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${portalLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open member portal</a>
        </div>
        <p style="font-size:13px;color:#666;">Questions? <a href="mailto:support@cielpk.com">support@cielpk.com</a></p>
        <p>Best regards,<br><strong>The CIEL PK Team</strong></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to: params.to,
        subject: `${params.leadName} added you to ${params.projectTitle}`,
        html,
      });
      this.logger.log(`Team member added email sent to ${params.to}`);
    } catch (error) {
      this.logger.error(`Failed to send team member added email to ${params.to}`, error.stack);
    }
  }

  async sendFacultyApprovalRequest(
    to: string,
    studentName: string,
    projectTitle: string,
    participationId: string,
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const approvalsLink = this.buildFrontendLink('/dashboard/faculty/approvals', {});
    const studentEsc = this.escHtmlPlain(studentName?.trim() ? studentName.trim() : 'Student');
    const titleEsc = this.escHtmlPlain(projectTitle);

    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #f0f0f0; border-radius: 12px; background-color: #ffffff; color: #333;">
            <div style="text-align: center; margin-bottom: 25px;">
                <h2 style="color: #2c3e50; margin-bottom: 5px;">Action required: student opportunity approval</h2>
                <div style="width: 50px; height: 3px; background: #4CAF50; margin: 0 auto;"></div>
            </div>

            <p>Dear Faculty Colleague,</p>
            <p>Greetings from <strong>Community Impact Education Lab (CIEL PK)</strong>.</p>

            <p>Your student <strong>${studentEsc}</strong> has applied for a verified community engagement opportunity on CIEL PK and has named you as the <strong>primary faculty supervisor</strong>.</p>

            <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #4CAF50; margin: 20px 0;">
                <p style="margin: 0;"><strong>Opportunity title:</strong> ${titleEsc}</p>
            </div>

            <p>Please sign in with the same email address this message was sent to, open <strong>Opportunity Request Approvals</strong>, and approve the request or return it with feedback so the workflow can continue.</p>

            <div style="text-align: center; margin: 35px 0;">
                <a href="${approvalsLink}" style="background-color: #4CAF50; color: white; padding: 14px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(76, 175, 80, 0.2);">Open approvals in CIEL PK</a>
            </div>

            <p>Until you approve (or the request is withdrawn), the student cannot move to the next steps in our verification process.</p>

            <p>Thank you for supporting structured, evidenced community learning.</p>

            <p style="margin-top: 40px; border-top: 1px solid #eee; padding-top: 20px;">
                Warm regards,<br>
                <span style="color: #4CAF50; font-weight: bold;">CIEL PK Team</span><br>
                <span style="font-size: 13px; color: #64748b;">Community Impact Education Lab</span>
            </p>
        </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — approval needed from faculty: ${projectTitle}`,
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
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const dashboardLink = this.buildFrontendLink('/dashboard/faculty/my-opportunities', {});
    const studentEsc = this.escHtmlPlain(studentName?.trim() ? studentName.trim() : 'Student');
    const titleEsc = this.escHtmlPlain(projectTitle);
    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #f0f0f0; border-radius: 12px; background-color: #ffffff; color: #333;">
            <div style="text-align: center; margin-bottom: 25px;">
                <h2 style="color: #2c3e50; margin-bottom: 5px;">You are listed as a collaborating supervisor</h2>
                <div style="width: 50px; height: 3px; background: #3498db; margin: 0 auto;"></div>
            </div>

            <p>Dear Faculty Colleague,</p>
            <p>Greetings from <strong>Community Impact Education Lab (CIEL PK)</strong>.</p>

            <p>You are recorded as a <strong>secondary / collaborating faculty supervisor</strong> on this opportunity:</p>

            <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3498db;">
                <p style="margin: 0 0 10px 0;"><strong>Student:</strong> ${studentEsc}</p>
                <p style="margin: 0;"><strong>Opportunity:</strong> ${titleEsc}</p>
            </div>

            <p>You may follow progress on CIEL PK for coordination. <strong>Primary supervisor approval</strong> is what advances the verification workflow; your role is supporting visibility unless your institution assigns you additional duties.</p>

            <div style="text-align: center; margin: 28px 0;">
                <a href="${dashboardLink}" style="background-color: #3498db; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold;">Open My Opportunities</a>
            </div>

            <p>Thank you for supporting verified community engagement.</p>

            <p style="margin-top: 40px; border-top: 1px solid #eee; padding-top: 20px;">
                Warm regards,<br>
                <span style="color: #2c3e50; font-weight: bold;">CIEL PK Team</span>
            </p>
        </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — collaborating supervisor (${projectTitle})`,
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
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const studentEsc = this.escHtmlPlain(studentName?.trim() ? studentName.trim() : 'there');
    const titleEsc = this.escHtmlPlain(projectTitle);
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #333;">We received your application</h2>
            <p>Dear ${studentEsc},</p>
            <p>Your application for <strong>${titleEsc}</strong> on CIEL PK is submitted and saved securely.</p>
            <p>Your primary faculty supervisor will review it and either approve your participation or return it with feedback. You will receive another email when the status changes.</p>
            <p><strong>Current status:</strong> Pending faculty approval</p>
            <p>Best regards,<br><strong>CIEL PK Team</strong><br><span style="font-size:13px;color:#666;">Community Impact Education Lab</span></p>
        </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — application received (pending faculty): ${projectTitle}`,
        html,
      });
      this.logger.log(`Application submission confirmation email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send application submission confirmation email to ${to}`, error.stack);
    }
  }

  async sendFacultyInvite(to: string, studentName: string, projectName: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const signupLink = this.buildFrontendLink('/signup', {
      role: 'faculty',
      email: to,
    });
    const studentEsc = this.escHtmlPlain(studentName?.trim() ? studentName.trim() : 'A student');
    const projectEsc = this.escHtmlPlain(projectName);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <p>Dear Faculty Colleague,</p>
        <p>Greetings from <strong>Community Impact Education Lab (CIEL PK)</strong>.</p>
        <p><strong>${studentEsc}</strong> has nominated you as <strong>faculty supervisor</strong> for the opportunity <strong>${projectEsc}</strong> on our verified community-engagement platform.</p>
        <p>In this role you review opportunities and student participation, provide institutional oversight, and help ensure hours and impact are documented to a consistent standard.</p>
        <p>If you already use CIEL PK, sign in with this email address. If you are new, create your faculty account using the link below (your email is prefilled where supported):</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${signupLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Complete faculty registration</a>
        </div>
        <p>For assistance, write to <a href="mailto:support@cielpk.com">support@cielpk.com</a>.</p>
        <p>Warm regards,<br><strong>CIEL PK Team</strong></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — faculty supervisor invitation (${projectName})`,
        html,
      });
      this.logger.log(`Faculty invite email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send faculty invite email to ${to}`, error.stack);
    }
  }

  /**
   * Liaison/partner verification links: default to marketing site (FRONTEND_URL + FRONTEND_VERIFY_PATH).
   * The frontend page should call GET/POST {API}/api/v1/verifications/verify with the token (Bearer JWT when
   * auth is required: see isProjectVerificationAuthRequired — production defaults to required unless
   * VERIFICATION_REQUIRE_AUTH=false).
   * Set VERIFICATION_EMAIL_LINK=api to put the API URL in the email instead (no frontend page needed).
   */
  private escHtmlPlain(s: string): string {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private opportunityVerificationDetailsHtml(details?: OpportunityVerificationEmailDetails): string {
    if (!details) return '';
    const rows: [string, string | undefined][] = [
      ['Reference ID', details.opportunityId],
      ['Student', details.studentName],
      ['Student university', details.studentUniversity],
      ['Posted by (faculty)', details.facultyAuthorName],
      ['Faculty email', details.facultyAuthorEmail],
      ['Supervision', details.facultySupervisionLine],
      ['Host / partner organization', details.partnerOrganization],
      ['Activity format', details.executionSummary],
      ['Mode', details.mode],
      ['Project types', details.typesLine],
      ['Timeline', details.timelineSummary],
      ['Location', details.locationSummary],
      ['SDG', details.sdgLabel],
      ['Objectives (summary)', details.objectivesPreview],
    ];
    const filtered = rows.filter(([, v]) => v && String(v).trim());
    if (!filtered.length) return '';
    const body = filtered
      .map(
        ([k, v]) =>
          `<tr><td style="padding:8px 14px 8px 0;vertical-align:top;color:#64748b;font-size:13px;width:38%;">${this.escHtmlPlain(k)}</td><td style="padding:8px 0;color:#0f172a;font-size:14px;">${this.escHtmlPlain(String(v).trim())}</td></tr>`,
      )
      .join('');
    return `
    <table role="presentation" width="100%" style="border-collapse:collapse;margin:20px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
      <tbody>${body}</tbody>
    </table>`;
  }

  private verificationSignInHintHtml(): string {
    return `<p style="font-size:13px;color:#475569;margin:16px 0 0 0;line-height:1.5;"><strong>Signing in:</strong> If the site asks you to log in before approving, use the <strong>same email address</strong> this message was sent to, then use the button below (or open the link again after signing in).</p>`;
  }

  private buildFrontendLink(pathname: string, params: Record<string, string | undefined>): string {
    const frontend = (this.configService.get<string>('FRONTEND_URL') || 'https://cielpk.com').replace(/\/+$/, '');
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    const query = search.toString();
    return `${frontend}${path}${query ? `?${query}` : ''}`;
  }

  private buildProjectVerificationLink(
    token: string,
    options?: { mode?: 'frontend' | 'api'; path?: string; returnTo?: string },
  ): string {
    const enc = encodeURIComponent(token);
    const linkTarget = (options?.mode || this.configService.get<string>('VERIFICATION_EMAIL_LINK') || 'frontend').toLowerCase();
    if (linkTarget === 'api') {
      const raw = this.configService.get<string>('API_URL') || 'https://api.cielpk.com';
      const base = raw.replace(/\/+$/, '');
      const withApiV1 = base.endsWith('/api/v1') ? base : `${base}/api/v1`;
      return `${withApiV1}/verifications/verify?token=${enc}`;
    }
    return this.buildFrontendLink(
      options?.path || this.configService.get<string>('FRONTEND_VERIFY_PATH') || '/verify-project',
      {
        token,
        returnTo: options?.returnTo,
      },
    );
  }

  async sendLiaisonVerification(to: string, projectTitle: string, token: string) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const verifyLink = this.buildProjectVerificationLink(token);

    const titleEsc = this.escHtmlPlain(projectTitle);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Confirm your role as institutional liaison</h2>
        <p>Dear Colleague,</p>
        <p>A student on CIEL PK has named you as the <strong>institutional liaison</strong> for <strong>${titleEsc}</strong>.</p>
        <p>Please use the secure link below to review the record and confirm whether your institution recognises this arrangement. The link may ask you to sign in with the same email address this notification was sent to.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verifyLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Review and verify</a>
        </div>
        <p style="font-size: 12px; color: #999; margin-top: 30px;">If you did not expect this request, you may disregard this message or contact <a href="mailto:support@cielpk.com">support@cielpk.com</a>.</p>
        <p style="margin-top:20px;">Regards,<br><strong>CIEL PK Team</strong></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — liaison verification: ${projectTitle}`,
        html,
      });
      this.logger.log(`Liaison verification email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send liaison verification email to ${to}`, error.stack);
    }
  }

  async sendPartnerVerification(
    to: string,
    projectTitle: string,
    token: string,
    details?: OpportunityVerificationEmailDetails,
    options?: { returnTo?: string; path?: string; introText?: string; ctaLabel?: string },
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const verifyLink = this.buildProjectVerificationLink(token, {
      mode: 'frontend',
      path: options?.path || '/verify-project',
      returnTo: options?.returnTo,
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const customLead = options?.introText?.trim();
    const postFacultyContext = !!customLead;
    const ctaLabel = (options?.ctaLabel || 'View Opportunity Details').trim();

    const partnerGreetingRaw =
      details?.partnerRecipientName?.trim() ||
      details?.partnerOrganization?.trim() ||
      'Partner';
    const dearPartner = this.escHtmlPlain(partnerGreetingRaw);

    const submittedByRaw =
      details?.studentName?.trim() ||
      details?.facultyAuthorName?.trim() ||
      '';
    const submittedByEsc = submittedByRaw ? this.escHtmlPlain(submittedByRaw) : '—';

    const institutionRaw =
      details?.institutionName?.trim() ||
      details?.studentUniversity?.trim() ||
      '';
    const institutionEsc = institutionRaw ? this.escHtmlPlain(institutionRaw) : '—';

    const facultySupervisorRaw =
      details?.facultyReviewerName?.trim() ||
      details?.facultySupervisionLine?.trim() ||
      details?.facultyAuthorName?.trim() ||
      '';
    const facultySupervisorEsc = facultySupervisorRaw ? this.escHtmlPlain(facultySupervisorRaw) : '—';

    const typeEsc = details?.typesLine?.trim() ? this.escHtmlPlain(details.typesLine.trim()) : '—';
    const modeLabel = this.formatModeForFacultyEmail(details?.mode);
    const durationEsc = details?.timelineSummary?.trim() ? this.escHtmlPlain(details.timelineSummary.trim()) : '—';
    const volunteersEsc = details?.volunteersRequired?.trim()
      ? this.escHtmlPlain(details.volunteersRequired.trim())
      : '—';

    const studentSubmittedLead = `<p style="margin: 0 0 16px 0;">A student has submitted a community engagement opportunity on CIEL PK and has listed your organization as the project partner.</p>
        <p style="margin: 0 0 20px 0;">You are requested to review the opportunity details and verify your involvement in this project.</p>`;
    const facultyOrNeutralLead = `<p style="margin: 0 0 16px 0;">A community engagement opportunity on CIEL PK lists your organization as the project partner.</p>
        <p style="margin: 0 0 20px 0;">You are requested to review the opportunity details and verify your involvement in this project.</p>`;
    const defaultLead =
      details?.studentName?.trim() || details?.institutionName?.trim() || details?.studentUniversity?.trim()
        ? studentSubmittedLead
        : facultyOrNeutralLead;
    const leadParagraph = postFacultyContext
      ? `<p style="margin: 0 0 16px 0;">${customLead}</p>`
      : defaultLead;

    const showFacultyPrerequisite =
      !postFacultyContext && !!details?.studentName?.trim();
    const facultyFirstNote = showFacultyPrerequisite
      ? `<p style="font-size: 13px; color: #4b5563; margin: 0 0 20px 0;">Please note that verification may only proceed after the faculty supervisor has approved this opportunity.</p>`
      : '';

    const html = `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 10px; color: #1f2937; line-height: 1.55;">
        <p style="margin: 0 0 16px 0;">Dear ${dearPartner},</p>
        ${leadParagraph}
        <p style="margin: 0 0 8px 0; font-weight: bold; color: #111827;">Opportunity Summary</p>
        <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #374151;">
          <li style="margin-bottom: 6px;"><strong>Project Title:</strong> ${titleEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Submitted By:</strong> ${submittedByEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Institution:</strong> ${institutionEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Faculty Supervisor:</strong> ${facultySupervisorEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Opportunity Type:</strong> ${typeEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Mode:</strong> ${modeLabel}</li>
          <li style="margin-bottom: 6px;"><strong>Duration:</strong> ${durationEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Volunteers Required:</strong> ${volunteersEsc}</li>
        </ul>
        ${facultyFirstNote}
        <p style="margin: 0 0 16px 0;">Please click the button below to review the full project details:</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${verifyLink}" style="background-color: #16a34a; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">${this.escHtmlPlain(ctaLabel)}</a>
        </div>
        ${this.verificationSignInHintHtml()}
        <p style="margin: 20px 0 8px 0;">After reviewing the opportunity in CIEL PK, you may:</p>
        <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #374151;">
          <li style="margin-bottom: 4px;"><strong>Approve</strong> if the description matches your organisation&rsquo;s involvement</li>
          <li style="margin-bottom: 4px;"><strong>Reject</strong> if you do not recognise the project or partnership</li>
          <li style="margin-bottom: 4px;"><strong>Request revision</strong> so the student or faculty contact can update details before you verify again</li>
        </ul>
        <p style="margin: 0 0 20px 0;">Your verification is required before CIEL PK can complete the approval chain for this opportunity.</p>
        <p style="margin: 0 0 4px 0;">Thank you for your collaboration.</p>
        <p style="margin: 20px 0 0 0;">Best regards,<br><strong>CIEL PK Team</strong></p>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you are unaware of this, you may safely ignore this email.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — partner verification requested: ${projectTitle}`,
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
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
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
        <p>Your faculty supervisor did not approve the following submission on CIEL PK:</p>
        <p style="font-size:16px;"><strong>${esc(projectTitle)}</strong></p>
        ${feedbackBlock}
        <p style="margin-top:20px;color:#555;">You can open your student dashboard, adjust the opportunity according to the feedback above, and resubmit if your programme allows revisions.</p>
        <p style="margin-top:24px;">Regards,<br><strong>CIEL PK Team</strong><br><span style="font-size:13px;color:#64748b;">Community Impact Education Lab</span></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — opportunity not approved: ${projectTitle}`,
        html,
      });
      this.logger.log(`Student faculty-rejection notice sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send student faculty-rejection email to ${to}`, error.stack);
    }
  }

  private formatModeForFacultyEmail(mode?: string): string {
    if (!mode || !String(mode).trim()) return '—';
    const m = String(mode).trim().toLowerCase();
    if (m.includes('remote')) return 'Remote';
    if (m.includes('hybrid')) return 'Hybrid';
    if (m.includes('on') && m.includes('site')) return 'On-site';
    if (m === 'on site' || m === 'onsite') return 'On-site';
    return this.escHtmlPlain(String(mode).trim());
  }

  async sendFacultyStudentOpportunityVerification(
    to: string,
    projectTitle: string,
    token: string,
    details?: OpportunityVerificationEmailDetails,
    options?: { returnTo?: string; path?: string },
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const verifyLink = this.buildProjectVerificationLink(token, {
      mode: 'frontend',
      path: options?.path || '/verify/faculty',
      returnTo: options?.returnTo,
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const facultyGreetingName =
      details?.facultyReviewerName?.trim() ||
      details?.facultySupervisionLine?.split('·')[0]?.trim() ||
      '';
    const dearLine = facultyGreetingName ? this.escHtmlPlain(facultyGreetingName) : 'Faculty Member';
    const studentName = details?.studentName?.trim() ? this.escHtmlPlain(details.studentName.trim()) : '—';
    const institution =
      details?.institutionName?.trim() ||
      details?.studentUniversity?.trim() ||
      '';
    const institutionEsc = institution ? this.escHtmlPlain(institution) : '—';
    const department = details?.departmentName?.trim() || '';
    const departmentEsc = department ? this.escHtmlPlain(department) : '—';
    const typeEsc = details?.typesLine?.trim() ? this.escHtmlPlain(details.typesLine.trim()) : '—';
    const modeLabel = this.formatModeForFacultyEmail(details?.mode);
    const durationEsc = details?.timelineSummary?.trim() ? this.escHtmlPlain(details.timelineSummary.trim()) : '—';
    const volunteersEsc = details?.volunteersRequired?.trim()
      ? this.escHtmlPlain(details.volunteersRequired.trim())
      : '—';

    const html = `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 10px; color: #1f2937; line-height: 1.55;">
        <p style="margin: 0 0 16px 0;">Dear ${dearLine},</p>
        <p style="margin: 0 0 16px 0;">A student has submitted a new opportunity on CIEL PK and listed you as the faculty reviewer for this project.</p>
        <p style="margin: 0 0 20px 0;">You are requested to review the opportunity details and provide your approval decision.</p>
        <p style="margin: 0 0 8px 0; font-weight: bold; color: #111827;">Opportunity Summary</p>
        <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #374151;">
          <li style="margin-bottom: 6px;"><strong>Project Title:</strong> ${titleEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Submitted By:</strong> ${studentName}</li>
          <li style="margin-bottom: 6px;"><strong>Institution:</strong> ${institutionEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Department:</strong> ${departmentEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Opportunity Type:</strong> ${typeEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Mode:</strong> ${modeLabel}</li>
          <li style="margin-bottom: 6px;"><strong>Duration:</strong> ${durationEsc}</li>
          <li style="margin-bottom: 6px;"><strong>Volunteers Required:</strong> ${volunteersEsc}</li>
        </ul>
        <p style="margin: 0 0 16px 0;">Please click the button below to view the complete opportunity details:</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${verifyLink}" style="background-color: #16a34a; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View Opportunity Details</a>
        </div>
        ${this.verificationSignInHintHtml()}
        <p style="margin: 20px 0 8px 0;">After reviewing the full opportunity record, you may:</p>
        <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #374151;">
          <li style="margin-bottom: 4px;"><strong>Approve</strong> to confirm the opportunity meets institutional expectations</li>
          <li style="margin-bottom: 4px;"><strong>Reject</strong> if it should not proceed under your supervision</li>
          <li style="margin-bottom: 4px;"><strong>Return for revision</strong> so the student can update specific sections</li>
        </ul>
        <p style="margin: 0 0 20px 0;">CIEL PK cannot advance partner verification or final publication until your decision (and any other required checks) are complete.</p>
        <p style="margin: 0 0 4px 0;">Thank you for your support.</p>
        <p style="margin: 20px 0 0 0;">Best regards,<br><strong>CIEL PK Team</strong></p>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you did not expect this email, you can ignore it.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — faculty approval requested: ${projectTitle}`,
        html,
      });
      this.logger.log(`Faculty student-opportunity verification email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send faculty verification email to ${to}`, error.stack);
    }
  }

  async sendStudentOpportunityStatusUpdate(
    to: string,
    projectTitle: string,
    subjectPrefix: string,
    title: string,
    message: string,
    reason?: string | null,
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const titleEsc = this.escHtmlPlain(projectTitle);
    const messageEsc = this.escHtmlPlain(message);
    const headingEsc = this.escHtmlPlain(title);
    const reasonBlock =
      reason && reason.trim()
        ? `<p style="margin:24px 0 0 0;font-size:14px;"><strong>Reason / feedback:</strong></p><p style="background:#f8fafc;border-left:4px solid #94a3b8;padding:12px 14px;margin:8px 0 0 0;color:#334155;font-size:14px;line-height:1.5;">${this.escHtmlPlain(
            reason.trim(),
          )}</p>`
        : '';
    const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;-webkit-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f3f4f6;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background-color:#ffffff;border:1px solid #e0e0e0;border-radius:10px;">
          <tr>
            <td style="padding:40px;color:#111827;">
              <h1 style="margin:0 0 20px 0;font-size:24px;font-weight:700;line-height:1.3;color:#000000;">${headingEsc}</h1>
              <p style="margin:0 0 18px 0;font-size:17px;font-weight:700;line-height:1.35;color:#000000;">${titleEsc}</p>
              <p style="margin:0;font-size:15px;font-weight:400;line-height:1.6;color:#111827;">${messageEsc}</p>
              ${reasonBlock}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `${subjectPrefix}: ${projectTitle}`,
        html,
      });
      this.logger.log(`Student opportunity status email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send student opportunity status email to ${to}`, error.stack);
    }
  }

  /** Sent when CIEL admin approves a student-created opportunity (fully live); directs creator to Apply Now, team members, and report. */
  async sendStudentOpportunityFullyApprovedEmail(
    to: string,
    studentName: string,
    projectTitle: string,
    opportunityId?: string,
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const nameEsc = studentName?.trim() ? this.escHtmlPlain(studentName.trim()) : 'Student';
    const titleEsc = this.escHtmlPlain(projectTitle);
    const dashboardPath =
      this.configService.get<string>('FRONTEND_STUDENT_DASHBOARD_PATH') || '/dashboard';
    const startLink = this.buildFrontendLink(dashboardPath.startsWith('/') ? dashboardPath : `/${dashboardPath}`, {
      opportunity: opportunityId,
    });

    const html = `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 10px; color: #1f2937; line-height: 1.55;">
        <p style="margin: 0 0 16px 0;">Dear ${nameEsc},</p>
        <h2 style="margin: 0 0 16px 0; font-size: 20px; color: #111827;">Your opportunity is now live!</h2>
        <p style="margin: 0 0 20px 0;">Click <strong>Apply Now</strong> to join the project, add your group members, and start updating your report. Please ensure all team members are registered on the platform before adding them.</p>
        <p style="margin: 0 0 8px 0;"><strong>Opportunity Title:</strong> ${titleEsc}</p>
        <p style="margin: 20px 0 16px 0;">Use the button below to open your dashboard and apply:</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${startLink}" style="background-color: #16a34a; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Apply Now</a>
        </div>
        <p style="margin: 20px 0 0 0;">Best regards,<br><strong>CIEL PK Team</strong></p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Your opportunity is now live!`,
        html,
      });
      this.logger.log(`Student opportunity fully approved email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send student opportunity fully approved email to ${to}`, error.stack);
    }
  }

  async sendAdminOpportunityReviewNeeded(
    projectTitle: string,
    opportunityId: string,
    stageLabel: string,
  ) {
    const recipients = this.getAdminReviewRecipientList();

    if (!recipients.length) {
      this.logger.warn(`Skipped admin review email for ${opportunityId}; no ADMIN_REVIEW_EMAILS configured.`);
      return;
    }

    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const adminLink = this.buildFrontendLink('/dashboard/admin/opportunities', {
      opportunity: opportunityId,
      tab: 'pending',
    });
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Opportunity ready for platform admin review</h2>
        <p><strong>${this.escHtmlPlain(projectTitle)}</strong> has cleared the previous verification step (<em>${this.escHtmlPlain(stageLabel)}</em>) and is now waiting in the CIEL PK admin queue.</p>
        <p>Please sign in, open the pending list, and assign <strong>Final decision</strong> (Approve, Return for edits, or Decline) according to policy.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${adminLink}" style="background-color: #2563eb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open admin queue</a>
        </div>
        <p style="margin-top:24px;font-size:13px;color:#64748b;">— CIEL PK automated notice</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to: recipients.join(', '),
        subject: `CIEL PK — admin review needed: ${projectTitle}`,
        html,
      });
      this.logger.log(`Admin review email sent for opportunity ${opportunityId}`);
    } catch (error) {
      this.logger.error(`Failed to send admin review email for ${opportunityId}`, error.stack);
    }
  }

  async sendOtpEmail(to: string, otp: string): Promise<void> {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
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

  async sendAttendancePendingReview(
    to: string,
    reviewerName: string,
    reviewerType: 'faculty' | 'partner',
    studentLabel: string,
    projectTitle: string,
    opportunityId: string,
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const dashboardPath = reviewerType === 'faculty' ? '/dashboard/faculty' : '/dashboard/partner';
    const link = this.buildFrontendLink(dashboardPath, {
      opportunity: opportunityId,
      tab: 'attendance',
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const reviewerLabel = reviewerType === 'faculty' ? 'faculty reviewer' : 'partner reviewer';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Attendance log needs your review</h2>
        <p>Hello ${this.escHtmlPlain(reviewerName)},</p>
        <p><strong>${this.escHtmlPlain(studentLabel)}</strong> logged hours against <strong>${titleEsc}</strong> on CIEL PK.</p>
        <p>As the ${this.escHtmlPlain(reviewerLabel)} for this project, please sign in to confirm or return the entry so volunteer time stays accurate and auditable.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${link}" style="background-color: #16a34a; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review attendance</a>
        </div>
      </div>
    `;
    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `CIEL PK — attendance review: ${projectTitle}`,
        html,
      });
      this.logger.log(
        `${reviewerType} attendance pending email sent to ${to} for opportunity ${opportunityId}`,
      );
    } catch (error) {
      this.logger.error(`Failed ${reviewerType} attendance pending email`, error.stack);
    }
  }

  async sendAttendancePendingPartnerReview(
    to: string,
    partnerName: string,
    studentLabel: string,
    projectTitle: string,
    opportunityId: string,
  ) {
    return this.sendAttendancePendingReview(
      to,
      partnerName,
      'partner',
      studentLabel,
      projectTitle,
      opportunityId,
    );
  }

  async sendAttendanceVerificationRequestNotice(
    to: string,
    reviewerType: 'faculty' | 'partner',
    projectTitle: string,
    opportunityId: string,
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const dashboardPath = reviewerType === 'faculty' ? '/dashboard/faculty' : '/dashboard/partner';
    const link = this.buildFrontendLink(dashboardPath, {
      opportunity: opportunityId,
      tab: 'attendance',
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const reviewerLabel = reviewerType === 'faculty' ? 'faculty reviewer' : 'partner reviewer';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">A participant requested attendance verification</h2>
        <p>Someone marked hours for <strong>${titleEsc}</strong> and selected you as the <strong>${this.escHtmlPlain(reviewerLabel)}</strong> on CIEL PK.</p>
        <p>Please review the submission promptly so the student&rsquo;s verified record stays up to date.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${link}" style="background-color: #16a34a; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review attendance</a>
        </div>
      </div>
    `;
    await this.transporter.sendMail({
      from,
      to,
      subject: `CIEL PK — attendance verification requested: ${projectTitle}`,
      html,
    });
    this.logger.log(`Attendance verification request email sent to ${to} for opportunity ${opportunityId}`);
  }

  async sendAttendanceDecisionNoticeToStudent(
    to: string,
    decision: 'approved' | 'rejected',
    projectTitle: string,
    opportunityId: string,
    reason?: string | null,
  ) {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const link = this.buildFrontendLink('/dashboard/student/report', {
      project: opportunityId,
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const approved = decision === 'approved';
    const reasonHtml =
      !approved && reason
        ? `<p><strong>Reason:</strong> ${this.escHtmlPlain(reason)}</p>`
        : '';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Attendance session ${approved ? 'approved' : 'rejected'}</h2>
        <p>A reviewer has <strong>${approved ? 'approved' : 'rejected'}</strong> an attendance session for <strong>${titleEsc}</strong>.</p>
        ${reasonHtml}
        <div style="text-align: center; margin: 28px 0;">
          <a href="${link}" style="background-color: ${approved ? '#16a34a' : '#dc2626'}; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Open your report</a>
        </div>
      </div>
    `;
    await this.transporter.sendMail({
      from,
      to,
      subject: `CIEL PK — attendance ${decision}: ${projectTitle}`,
      html,
    });
    this.logger.log(
      `Attendance ${decision} notice sent to student ${to} for opportunity ${opportunityId}`,
    );
  }

  async sendAttendancePendingAdminReview(
    projectTitle: string,
    opportunityId: string,
    logId: string,
    studentLabel: string,
  ) {
    const recipients = this.getAdminReviewRecipientList();
    if (!recipients.length) {
      this.logger.warn(`Skipped admin attendance email for log ${logId}; no admin recipients configured.`);
      return;
    }
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const adminLink = this.buildFrontendLink('/dashboard/admin', {
      opportunity: opportunityId,
      attendanceLog: logId,
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Attendance awaiting CIEL admin review</h2>
        <p><strong>${this.escHtmlPlain(studentLabel)}</strong> submitted hours on <strong>${titleEsc}</strong>. Because of how this project is hosted, the entry is routed to the <strong>platform administrator queue</strong> after faculty or internal checks.</p>
        <p>Sign in to review supporting notes and approve or decline the log.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${adminLink}" style="background-color: #2563eb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open admin dashboard</a>
        </div>
      </div>
    `;
    try {
      await this.transporter.sendMail({
        from,
        to: recipients.join(', '),
        subject: `CIEL PK — admin attendance queue: ${projectTitle}`,
        html,
      });
      this.logger.log(`Admin attendance pending email for log ${logId}`);
    } catch (error) {
      this.logger.error(`Failed admin attendance pending email for log ${logId}`, error.stack);
    }
  }

  private getAdminReviewRecipientList(): string[] {
    const primaryAdmin = 'admin@cielpk.com';
    const recipientsRaw =
      this.configService.get<string>('ADMIN_REVIEW_EMAILS') ||
      this.configService.get<string>('ADMIN_EMAILS') ||
      'support@cielpk.com';
    const fromConfig = recipientsRaw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const rest = fromConfig.filter((e) => e !== primaryAdmin);
    return [primaryAdmin, ...rest];
  }

  /** Student submitted an impact report (admin queue). */
  async sendAdminStudentReportSubmitted(
    projectTitle: string,
    opportunityId: string,
    reportId: string,
    studentName: string,
  ) {
    const recipients = this.getAdminReviewRecipientList();
    if (!recipients.length) {
      this.logger.warn(`Skipped admin student-report email for ${reportId}; no admin recipients configured.`);
      return;
    }
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const adminLink = this.buildFrontendLink('/dashboard/admin', {
      opportunity: opportunityId || undefined,
      studentReport: reportId,
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const studentEsc = this.escHtmlPlain(studentName?.trim() ? studentName.trim() : 'Student');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Student impact report submitted</h2>
        <p><strong>${studentEsc}</strong> uploaded an impact report for <strong>${titleEsc}</strong>.</p>
        <p>Use the admin dashboard to read the narrative, review evidence, and record your decision.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${adminLink}" style="background-color: #2563eb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open admin dashboard</a>
        </div>
      </div>
    `;
    try {
      await this.transporter.sendMail({
        from,
        to: recipients.join(', '),
        subject: `CIEL PK — student report submitted: ${projectTitle}`,
        html,
      });
      this.logger.log(`Admin student-report submitted email for report ${reportId}`);
    } catch (error) {
      this.logger.error(`Failed admin student-report submitted email for ${reportId}`, error.stack);
    }
  }

  /** Student-created opportunity is live; student received "Start report" email (admin FYI). */
  async sendAdminStudentMayStartReport(projectTitle: string, opportunityId: string, studentName: string) {
    const recipients = this.getAdminReviewRecipientList();
    if (!recipients.length) {
      this.logger.warn(`Skipped admin start-report notice for ${opportunityId}; no admin recipients configured.`);
      return;
    }
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const adminLink = this.buildFrontendLink('/dashboard/admin/opportunities', {
      opportunity: opportunityId,
    });
    const titleEsc = this.escHtmlPlain(projectTitle);
    const studentEsc = this.escHtmlPlain(studentName?.trim() ? studentName.trim() : 'Student');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">Student cleared to begin reporting</h2>
        <p><strong>${studentEsc}</strong>&rsquo;s opportunity <strong>${titleEsc}</strong> is fully approved and visible on CIEL PK. The student has been notified to open the reporting workflow.</p>
        <p>No further action is required unless you are monitoring this programme centrally.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${adminLink}" style="background-color: #2563eb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open admin opportunities</a>
        </div>
      </div>
    `;
    try {
      await this.transporter.sendMail({
        from,
        to: recipients.join(', '),
        subject: `CIEL PK — student may start report: ${projectTitle}`,
        html,
      });
      this.logger.log(`Admin start-report notice sent for opportunity ${opportunityId}`);
    } catch (error) {
      this.logger.error(`Failed admin start-report notice for ${opportunityId}`, error.stack);
    }
  }

  /** Public contact form: delivers inquiry to support@cielpk.com */
  async sendContactInquiry(name: string, email: string, subject: string, message: string): Promise<void> {
    const from = this.configService.get<string>('MAIL_FROM') || 'CIEL <no-reply@cielpk.com>';
    const to = 'support@cielpk.com';
    const esc = (s: string) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #333;">New message from cielpk.com</h2>
        <p>The public contact form received the following submission:</p>
        <p><strong>Name:</strong> ${esc(name)}</p>
        <p><strong>Email:</strong> ${esc(email)}</p>
        <p><strong>Subject:</strong> ${esc(subject)}</p>
        <p><strong>Message:</strong></p>
        <p style="white-space: pre-wrap; color: #444; line-height: 1.5;">${esc(message)}</p>
        <p style="margin-top:20px;font-size:12px;color:#94a3b8;">Reply directly to this email to respond to the visitor (Reply-To is set to their address).</p>
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

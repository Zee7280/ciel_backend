import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { buildImpactVerifyUrl } from '../reports/certificate-verification-code.util';
import { StudentReport } from '../reports/entities/student-report.entity';
import {
  isExternalResourceSource,
  isMixedResourceSource,
} from '../reports/report-submit-validation.util';
import { User } from '../users/entities/user.entity';
import {
  ContributionSnapshot,
  ResourceContributionAcknowledgement,
} from './entities/resource-contribution-acknowledgement.entity';

export type AcknowledgeResult = {
  sent: number;
  already: number;
  skipped: number;
  failed: number;
};

export type ContributionView = ContributionSnapshot & {
  id: string;
  contributor_name: string;
  certificate_code: string;
  certificate_url: string;
  acknowledged_at: string;
};

type LooseResource = {
  type?: unknown;
  type_other?: unknown;
  amount?: unknown;
  student_team_share?: unknown;
  unit?: unknown;
  unit_other?: unknown;
  source?: unknown;
  sources?: unknown;
  source_other?: unknown;
  purpose?: unknown;
  verification?: unknown;
  verification_other?: unknown;
  contributor_name?: unknown;
  contributor_email?: unknown;
  evidence_trail?: unknown;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Contributor's share of a resource: the total minus the student team's share on a mixed entry. */
function contributorShareText(res: LooseResource): string {
  const totalText = str(res.amount).replace(/,/g, '').trim();
  const shareRaw = str(res.student_team_share).replace(/,/g, '').trim();
  const total = Number(totalText);
  const share = Number(shareRaw);
  if (
    isMixedResourceSource(res.sources ?? res.source) &&
    totalText !== '' &&
    shareRaw !== '' &&
    Number.isFinite(total) &&
    Number.isFinite(share) &&
    share >= 0 &&
    share <= total
  ) {
    return String(Number((total - share).toFixed(6)));
  }
  return str(res.amount).trim();
}

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  const one = str(value);
  return one ? [one] : [];
}

function normalizeEmail(value: unknown): string {
  return str(value).toLowerCase();
}

/** `CIEL-CONTRIB-XXXX-XXXX-XXXX` from the certificate token: short enough to quote on a call. */
export function contributionCertificateCode(token: string): string {
  const compact = str(token)
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  const chunks = compact.match(/.{1,4}/g)?.slice(0, 3) ?? ['0000'];
  return `CIEL-CONTRIB-${chunks.join('-')}`;
}

/**
 * Appreciation loop for Section 5 resource contributors (Team Lead brief): once CIEL PK publishes a
 * report, every contributor from outside the student team who left an email gets a thank-you email
 * with a public contribution certificate, and — when the email belongs to a CIEL PK account — an
 * in-app notice plus the contribution on their own dashboard.
 */
@Injectable()
export class ResourceContributorsService {
  private readonly logger = new Logger(ResourceContributorsService.name);

  constructor(
    @InjectRepository(ResourceContributionAcknowledgement)
    private readonly ackRepository: Repository<ResourceContributionAcknowledgement>,
    @InjectRepository(StudentReport)
    private readonly reportsRepository: Repository<StudentReport>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  private frontendBase(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('APP_URL') ||
      'https://cielpk.com'
    ).replace(/\/+$/, '');
  }

  certificateUrl(token: string): string {
    return `${this.frontendBase()}/verify/contribution/${encodeURIComponent(token)}`;
  }

  private async findUserByEmail(email: string): Promise<User | null> {
    if (!email) return null;
    try {
      return await this.usersRepository.findOne({
        where: { email: ILike(email) },
      });
    } catch {
      return null;
    }
  }

  private buildSnapshot(
    report: StudentReport,
    res: LooseResource,
  ): ContributionSnapshot {
    const opportunity = report.opportunity;
    const sdgRaw = Number(opportunity?.sdg);
    const verifiedAt =
      report.adminApprovedAt instanceof Date
        ? report.adminApprovedAt
        : report.adminApprovedAt
          ? new Date(report.adminApprovedAt)
          : report.updatedAt instanceof Date
            ? report.updatedAt
            : new Date();
    return {
      project_title:
        str(opportunity?.title) ||
        str(report.project_id) ||
        'Community Service project',
      project_code: str(report.project_id) || null,
      opportunity_id: str(report.opportunityId) || null,
      lead_name: str(report.student?.name) || 'the student team lead',
      resource_type: str(res.type_other) || str(res.type),
      // A mixed-source entry (student team + this contributor) credits the contributor with their
      // share only — the remainder after the student team's share — never the whole total.
      amount: contributorShareText(res),
      unit: str(res.unit_other) || str(res.unit),
      purpose: str(res.purpose),
      sources: [
        ...list(res.sources ?? res.source),
        str(res.source_other),
      ].filter(Boolean),
      verification: [
        ...list(res.verification),
        str(res.verification_other),
      ].filter(Boolean),
      evidence_trail: str(res.evidence_trail),
      sdg:
        Number.isInteger(sdgRaw) && sdgRaw >= 1 && sdgRaw <= 17 ? sdgRaw : null,
      partner_name: str(opportunity?.organization?.name) || null,
      verified_at: verifiedAt.toISOString(),
      report_verify_url: buildImpactVerifyUrl(report.verificationPublicSlug, {
        frontendUrl: this.frontendBase(),
      }),
    };
  }

  private resourceLine(s: ContributionSnapshot): string {
    const qty = [s.amount, s.unit].filter(Boolean).join(' ');
    return (
      [qty, s.resource_type].filter(Boolean).join(' · ') || 'your contribution'
    );
  }

  /**
   * Thank every external contributor on a published report, exactly once per resource entry.
   * Never throws: a failed email is recorded on the row and retried on the next publish call.
   */
  async acknowledgeReport(reportId: string): Promise<AcknowledgeResult> {
    const result: AcknowledgeResult = {
      sent: 0,
      already: 0,
      skipped: 0,
      failed: 0,
    };
    const report = await this.reportsRepository.findOne({
      where: { id: reportId },
      relations: ['student', 'opportunity', 'opportunity.organization'],
    });
    if (!report) return result;
    const raw = report.section6?.resources;
    const resources: LooseResource[] = Array.isArray(raw)
      ? (raw as LooseResource[])
      : [];

    for (let index = 0; index < resources.length; index += 1) {
      const res = resources[index] || {};
      const sources = list(res.sources ?? res.source);
      const email = normalizeEmail(res.contributor_email);
      if (!isExternalResourceSource(sources) || !EMAIL_RE.test(email)) {
        result.skipped += 1;
        continue;
      }
      let row = await this.ackRepository.findOne({
        where: { reportId: report.id, resourceIndex: index },
      });
      if (row?.emailSentAt) {
        result.already += 1;
        continue;
      }
      const snapshot = this.buildSnapshot(report, res);
      const contributorName = str(res.contributor_name) || email;
      if (!row) {
        row = this.ackRepository.create({
          reportId: report.id,
          resourceIndex: index,
          email,
          contributorName,
          token: randomUUID(),
          linkedUserId: null,
          snapshot,
          emailSentAt: null,
          notifiedAt: null,
          error: null,
        });
      } else {
        row.email = email;
        row.contributorName = contributorName;
        row.snapshot = snapshot;
      }
      const user = await this.findUserByEmail(email);
      row.linkedUserId = user?.id ?? null;
      const certificateHref = this.certificateUrl(row.token);
      try {
        await this.mailService.sendResourceContributorAppreciation({
          to: email,
          contributorName,
          projectTitle: snapshot.project_title,
          leadName: snapshot.lead_name,
          resourceLine: this.resourceLine(snapshot),
          purpose: snapshot.purpose,
          certificateHref,
          reportVerifyHref: snapshot.report_verify_url,
          existingAccount: Boolean(user),
        });
        row.emailSentAt = new Date();
        row.error = null;
        result.sent += 1;
      } catch (error) {
        row.error = (error as Error)?.message || 'email failed';
        result.failed += 1;
        this.logger.warn(
          `Contributor appreciation email failed for report ${report.id} #${index}: ${row.error}`,
        );
      }
      if (user && this.notificationsService && !row.notifiedAt) {
        try {
          await this.notificationsService.createNotification(user.id, {
            type: 'contribution',
            title: 'Your contribution was verified',
            message: `CIEL PK verified "${snapshot.project_title}". Your contribution (${this.resourceLine(snapshot)}) now appears on your impact wall, with a certificate: ${certificateHref}`,
          });
          row.notifiedAt = new Date();
        } catch (error) {
          this.logger.warn(
            `Contributor notification failed for ${user.id}: ${(error as Error)?.message}`,
          );
        }
      }
      try {
        await this.ackRepository.save(row);
      } catch (error) {
        this.logger.warn(
          `Could not persist contributor acknowledgement for report ${report.id} #${index}: ${(error as Error)?.message}`,
        );
      }
    }
    return result;
  }

  private toView(row: ResourceContributionAcknowledgement): ContributionView {
    return {
      ...row.snapshot,
      id: row.id,
      contributor_name: row.contributorName,
      certificate_code: contributionCertificateCode(row.token),
      certificate_url: this.certificateUrl(row.token),
      acknowledged_at: (
        row.emailSentAt ||
        row.createdAt ||
        new Date()
      ).toISOString(),
    };
  }

  /** Public certificate payload: contributor name + what/where/when; never the email or phone. */
  async getPublicCertificate(
    token: string,
  ): Promise<ContributionView & { verified: true }> {
    const key = str(token);
    if (!key) throw new NotFoundException();
    const row = await this.ackRepository.findOne({ where: { token: key } });
    if (!row) throw new NotFoundException();
    return { ...this.toView(row), verified: true };
  }

  /** Contributions acknowledged to this account (by linked id or by the account's email). */
  async listForUser(user: {
    id: string;
    email?: string | null;
  }): Promise<ContributionView[]> {
    let email = normalizeEmail(user.email);
    if (!email && user.id) {
      const found = await this.usersRepository.findOne({
        where: { id: user.id },
      });
      email = normalizeEmail(found?.email);
    }
    const where: FindOptionsWhere<ResourceContributionAcknowledgement>[] = [
      { linkedUserId: user.id },
    ];
    if (email) where.push({ email });
    const rows = await this.ackRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
    const seen = new Set<string>();
    const out: ContributionView[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (!row.linkedUserId && user.id) {
        row.linkedUserId = user.id;
        try {
          await this.ackRepository.save(row);
        } catch {
          /* linking is best-effort */
        }
      }
      out.push(this.toView(row));
    }
    return out;
  }
}

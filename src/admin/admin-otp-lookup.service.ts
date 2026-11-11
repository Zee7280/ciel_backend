import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { EmailOtp } from '../auth/entities/email-otp.entity';
import { Otp } from '../students/entities/otp.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { decryptPasswordRecord } from '../users/password-record.util';
import { escapeLikePattern } from '../users/users.service';

export type AdminOtpPurpose = 'signup' | 'team_verification';

/** One live verification code, as Super Admin sees it in User Management. */
export interface AdminActiveOtp {
  email: string;
  code: string;
  purpose: AdminOtpPurpose;
  expiresAt: string;
  /** The person already entered this code correctly. */
  verified: boolean;
  projectId: string | null;
  projectTitle: string | null;
}

export interface AdminActiveOtpRow extends AdminActiveOtp {
  hasAccount: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 50;

/**
 * Read-only lookup of unexpired OTP codes for Super Admin support ("the code never arrived").
 * Signup codes come from the encrypted copy (rows created before it existed have only a hash and
 * are skipped); teammate / project verification codes are stored as issued. Verification itself
 * is untouched.
 */
@Injectable()
export class AdminOtpLookupService {
  private readonly logger = new Logger(AdminOtpLookupService.name);

  constructor(
    @InjectRepository(EmailOtp)
    private readonly emailOtpRepo: Repository<EmailOtp>,
    @InjectRepository(Otp)
    private readonly otpRepo: Repository<Otp>,
    @InjectRepository(Opportunity)
    private readonly opportunityRepo: Repository<Opportunity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  private static norm(email: string | null | undefined): string {
    return String(email || '')
      .trim()
      .toLowerCase();
  }

  /** Live codes for these account emails, newest first per email. Never throws. */
  async activeOtpsByEmail(
    emails: Array<string | null | undefined>,
  ): Promise<Map<string, AdminActiveOtp[]>> {
    const wanted = [
      ...new Set(
        emails.map((e) => AdminOtpLookupService.norm(e)).filter(Boolean),
      ),
    ];
    const out = new Map<string, AdminActiveOtp[]>();
    if (!wanted.length) return out;
    const rows = await this.collect({ emails: wanted });
    for (const row of rows) {
      const list = out.get(row.email) ?? [];
      list.push(row);
      out.set(row.email, list);
    }
    return out;
  }

  /** Every live code (optionally filtered by email text), newest first, capped. Never throws. */
  async listActive(search?: string): Promise<AdminActiveOtpRow[]> {
    const rows = (await this.collect({ search })).slice(0, LIST_LIMIT);
    const emails = [...new Set(rows.map((r) => r.email))];
    let registered = new Set<string>();
    if (emails.length) {
      try {
        const users = await this.userRepo
          .createQueryBuilder('user')
          .select('LOWER(user.email)', 'email')
          .where('LOWER(user.email) IN (:...emails)', { emails })
          .getRawMany<{ email: string }>();
        registered = new Set(users.map((u) => u.email));
      } catch (err) {
        this.logger.warn(
          `Account lookup for OTP list failed: ${(err as Error)?.message || err}`,
        );
      }
    }
    return rows.map((r) => ({ ...r, hasAccount: registered.has(r.email) }));
  }

  private async collect(filter: {
    emails?: string[];
    search?: string;
  }): Promise<AdminActiveOtp[]> {
    const now = new Date();
    const search = String(filter.search || '')
      .trim()
      .toLowerCase();
    const like = search ? `%${escapeLikePattern(search)}%` : '';

    const signupRows = await this.emailOtpRepo
      .createQueryBuilder('o')
      .where('o.expiresAt > :now', { now })
      .andWhere(
        filter.emails
          ? 'LOWER(o.email) IN (:...emails)'
          : like
            ? 'LOWER(o.email) LIKE :like'
            : 'TRUE',
        { emails: filter.emails, like },
      )
      .orderBy('o.createdAt', 'DESC')
      .take(LIST_LIMIT * 2)
      .getMany()
      .catch((err: Error) => {
        this.logger.warn(`Signup OTP lookup failed: ${err?.message || err}`);
        return [] as EmailOtp[];
      });

    const teamRows = await this.otpRepo
      .find({
        where: filter.emails
          ? { email: In(filter.emails), expiresAt: MoreThan(now) }
          : { expiresAt: MoreThan(now) },
        order: { expiresAt: 'DESC' },
        take: like ? 500 : LIST_LIMIT * 2,
      })
      .then((rows) =>
        like
          ? rows.filter((r) =>
              AdminOtpLookupService.norm(r.email).includes(search),
            )
          : rows,
      )
      .catch((err: Error) => {
        this.logger.warn(`Team OTP lookup failed: ${err?.message || err}`);
        return [] as Otp[];
      });

    const titles = await this.projectTitles(teamRows.map((r) => r.projectId));

    const signup: Array<AdminActiveOtp & { at: number }> = [];
    for (const row of signupRows) {
      const code = decryptPasswordRecord(row.otpRecord) || row.otp || '';
      if (!code) continue;
      signup.push({
        email: AdminOtpLookupService.norm(row.email),
        code,
        purpose: 'signup',
        expiresAt: new Date(row.expiresAt).toISOString(),
        verified: Boolean(row.verified),
        projectId: null,
        projectTitle: null,
        at: new Date(row.createdAt).getTime() || 0,
      });
    }
    const team: Array<AdminActiveOtp & { at: number }> = teamRows
      .filter((row) => row.otp)
      .map((row) => ({
        email: AdminOtpLookupService.norm(row.email),
        code: row.otp,
        purpose: 'team_verification' as const,
        expiresAt: new Date(row.expiresAt).toISOString(),
        verified: Boolean(row.verifiedAt),
        projectId: row.projectId ?? null,
        projectTitle: row.projectId
          ? (titles.get(row.projectId) ?? null)
          : null,
        // Team rows are re-used on resend (createdAt is the first send), so order by expiry.
        at: new Date(row.expiresAt).getTime() || 0,
      }));

    return [...signup, ...team]
      .sort((a, b) => b.at - a.at)
      .map((row) => {
        const rest: AdminActiveOtp & { at?: number } = { ...row };
        delete rest.at;
        return rest;
      });
  }

  private async projectTitles(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const valid = [
      ...new Set(ids.filter((id): id is string => !!id && UUID_RE.test(id))),
    ];
    const map = new Map<string, string>();
    if (!valid.length) return map;
    try {
      const rows = await this.opportunityRepo.find({
        where: { id: In(valid) },
        select: { id: true, title: true },
      });
      for (const row of rows) if (row.title) map.set(row.id, row.title);
    } catch (err) {
      this.logger.warn(
        `Project title lookup for OTPs failed: ${(err as Error)?.message || err}`,
      );
    }
    return map;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { QuickWorkLog } from './entities/quick-work-log.entity';
import { quickImpactFlashcardPdf } from './quick-impact-flashcard-pdf.util';
import {
  isPartnerEmailOnLog,
  partnerImpactFacts,
  partnerRecipients,
} from './quick-impact-partner.util';

const PARTNER_ROLES: string[] = [
  UserRole.NGO,
  UserRole.CORPORATE,
  UserRole.UNIVERSITY,
  UserRole.ORGANIZATION_ADMIN,
];
const WALL_MAX = 200;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Quick Community Impact → host / partner organisations.
 *  - `onApproved`: right after CIEL PK's final approval, email each host / partner the flashcard (PDF)
 *    and, for one that already has a partner account, add an in-app notice.
 *  - `listForPartner`: the approved logs naming the signed-in partner's email, for My Impact Wall.
 * Everything is best-effort: a failure here is logged and never affects the approval.
 */
@Injectable()
export class QuickImpactPartnerService {
  private readonly logger = new Logger(QuickImpactPartnerService.name);

  constructor(
    @InjectRepository(QuickWorkLog)
    private readonly logRepo: Repository<QuickWorkLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /** Emails and notices for a log that has just been approved. Set QCI_PARTNER_EMAIL=off to switch it off. */
  async onApproved(
    logId: string,
  ): Promise<{ recipients: number; emailed: number; notified: number }> {
    const result = { recipients: 0, emailed: 0, notified: 0 };
    try {
      if (
        String(this.config.get<string>('QCI_PARTNER_EMAIL') ?? '')
          .trim()
          .toLowerCase() === 'off'
      ) {
        return result;
      }
      const log = await this.logRepo.findOne({
        where: { id: logId },
        relations: ['participants'],
      });
      if (!log || log.status !== 'approved') return result;
      const recipients = partnerRecipients(log);
      result.recipients = recipients.length;
      if (!recipients.length) return result;
      const facts = partnerImpactFacts(log);

      for (const r of recipients) {
        try {
          const account = await this.partnerAccountByEmail(r.email);
          if (account) {
            await this.notifications.createNotification(account.id, {
              type: 'quick_work',
              title: 'Quick Community Impact flashcard ready',
              message: `"${facts.title}" was approved. Open My Impact Wall to see its flashcard.`,
            });
            result.notified += 1;
          }
          const pdf = await quickImpactFlashcardPdf(facts, {
            partnerName: r.name,
          });
          const sent = await this.mail.sendQuickImpactPartnerFlashcard({
            to: r.email,
            contactName: r.name,
            opportunity: facts.title,
            venue: facts.venue,
            date: facts.date,
            description: facts.summary,
            hours: facts.hours,
            students: facts.students,
            existingAccount: Boolean(account),
            pdf,
          });
          if (sent) result.emailed += 1;
        } catch (e) {
          this.logger.warn(
            `Quick Impact partner flashcard failed for log ${logId}: ${(e as Error).message}`,
          );
        }
      }
      this.logger.log(
        `Quick Impact partner flashcards for log ${logId}: ${result.emailed}/${result.recipients} emailed, ${result.notified} notified`,
      );
    } catch (e) {
      this.logger.error(
        `Quick Impact partner flashcards failed for log ${logId}: ${(e as Error).message}`,
      );
    }
    return result;
  }

  /** `onApproved`, but never holding the approving admin's request for more than `ms`. */
  async onApprovedWithin(logId: string, ms = 20_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.onApproved(logId),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** An existing partner-type account for this address, if any. */
  private async partnerAccountByEmail(email: string): Promise<User | null> {
    const user = await this.userRepo
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email: email.toLowerCase() })
      .getOne();
    return user && PARTNER_ROLES.includes(String(user.role)) ? user : null;
  }

  /** Approved logs that name this partner account's email as host or partner; students' names and contacts are never included. */
  async listForPartner(userId: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'email', 'role'],
    });
    const email = String(user?.email ?? '')
      .trim()
      .toLowerCase();
    if (!user || !email || !PARTNER_ROLES.includes(String(user.role))) {
      return [];
    }
    const pattern = `"email"\\s*:\\s*"${escapeRegex(email)}"`;
    const rows = await this.logRepo
      .createQueryBuilder('log')
      .leftJoinAndSelect('log.participants', 'p')
      .where("log.status = 'approved'")
      .andWhere(
        new Brackets((w) => {
          w.where('LOWER(log."hostEmail") = :email', { email }).orWhere(
            'log.partners::text ~* :pattern',
            { pattern },
          );
        }),
      )
      .orderBy('log.activityDate', 'DESC', 'NULLS LAST')
      .addOrderBy('log.createdAt', 'DESC')
      .take(WALL_MAX)
      .getMany();
    return rows
      .filter((log) => isPartnerEmailOnLog(log, email))
      .map((log) => partnerImpactFacts(log));
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AttendanceLog } from './entities/attendance-log.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  extractPartnerContactEmailsForAttendance,
  opportunityHasActionablePartnerForAttendance,
} from './attendance-approver.util';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Opportunity } from '../opportunities/entities/opportunity.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AttendanceSlaService {
  private readonly logger = new Logger(AttendanceSlaService.name);

  constructor(
    @InjectRepository(AttendanceLog)
    private readonly attendanceLogRepo: Repository<AttendanceLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async processPartnerAttendanceSla(): Promise<{
    reminders_sent: number;
    escalated: number;
    scanned: number;
  }> {
    const now = Date.now();

    const pendingPartnerLogs = await this.attendanceLogRepo.find({
      where: {
        approvalStatus: 'pending',
        assignedApproverType: 'partner',
        escalatedAt: IsNull(),
      },
      relations: ['project', 'participant'],
      take: 500,
    });

    let remindersSent = 0;
    let escalated = 0;

    for (const log of pendingPartnerLogs) {
      const opportunity = log.project;
      if (
        !opportunity ||
        !opportunityHasActionablePartnerForAttendance(opportunity)
      ) {
        continue;
      }

      const createdAt = log.createdAt?.getTime() ?? now;
      const ageMs = now - createdAt;

      if (ageMs >= 8 * DAY_MS && !log.escalatedAt) {
        log.escalatedAt = new Date();
        log.assignedApproverType = 'admin';
        log.opportunityCreatorKind = 'admin';
        await this.attendanceLogRepo.save(log);
        await this.notifyAdminEscalation(log, opportunity);
        escalated += 1;
        continue;
      }

      const shouldSendDay3Reminder =
        ageMs >= 3 * DAY_MS && (log.slaReminderCount || 0) < 1;
      const shouldSendDay7Reminder =
        ageMs >= 7 * DAY_MS && (log.slaReminderCount || 0) < 2;

      if (!shouldSendDay3Reminder && !shouldSendDay7Reminder) {
        continue;
      }

      const partnerEmails =
        extractPartnerContactEmailsForAttendance(opportunity);
      if (!partnerEmails.length) continue;

      for (const email of partnerEmails) {
        await this.mailService.sendAttendancePendingPartnerReview(
          email,
          opportunity.title,
          log.participant?.fullName || 'Student',
          opportunity.title,
          opportunity.id,
        );
      }

      log.slaReminderCount = (log.slaReminderCount || 0) + 1;
      log.slaLastReminderAt = new Date();
      await this.attendanceLogRepo.save(log);
      remindersSent += 1;
    }

    this.logger.log(
      `Partner attendance SLA processed: scanned=${pendingPartnerLogs.length}, reminders=${remindersSent}, escalated=${escalated}`,
    );

    return {
      scanned: pendingPartnerLogs.length,
      reminders_sent: remindersSent,
      escalated,
    };
  }

  private async notifyAdminEscalation(
    log: AttendanceLog,
    opportunity: Opportunity,
  ) {
    const admins = await this.userRepo.find({
      where: { role: UserRole.SUPER_ADMIN },
      take: 10,
    });
    for (const admin of admins) {
      await this.notificationsService.createNotification(admin.id, {
        type: 'attendance_escalation',
        title: 'Attendance escalated to admin',
        message: `Partner queue pending >7 days on ${opportunity.title}. Log ${log.id.slice(0, 8)} needs admin review.`,
      });
    }
    await this.mailService.sendAttendancePendingAdminReview(
      opportunity.title,
      opportunity.id,
      log.id,
      log.participant?.fullName || 'Student',
    );
  }
}

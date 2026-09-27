import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttendanceLog } from './entities/attendance-log.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AttendanceSlaService {
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
    // Stakeholder flow: attendance is approved on the faculty / CIEL PK flash card,
    // not a partner pending queue — do not remind or escalate log-by-log.
    void this.attendanceLogRepo;
    void this.userRepo;
    void this.mailService;
    void this.notificationsService;
    return { reminders_sent: 0, escalated: 0, scanned: 0 };
  }
}

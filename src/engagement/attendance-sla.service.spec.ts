import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AttendanceSlaService } from './attendance-sla.service';
import { AttendanceLog } from './entities/attendance-log.entity';
import { User } from '../users/entities/user.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('AttendanceSlaService', () => {
  let service: AttendanceSlaService;
  let attendanceLogRepo: { find: jest.Mock; save: jest.Mock };

  const mailService = {
    sendAttendancePendingPartnerReview: jest.fn().mockResolvedValue(undefined),
    sendAttendancePendingAdminReview: jest.fn().mockResolvedValue(undefined),
  };
  const notificationsService = {
    createNotification: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    attendanceLogRepo = {
      find: jest.fn(),
      save: jest.fn((row: AttendanceLog) => Promise.resolve(row)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceSlaService,
        {
          provide: getRepositoryToken(AttendanceLog),
          useValue: attendanceLogRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            find: jest
              .fn()
              .mockResolvedValue([{ id: 'admin-1', email: 'admin@test.com' }]),
          },
        },
        { provide: MailService, useValue: mailService },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();
    service = module.get(AttendanceSlaService);
  });

  it('does not escalate partner-queue logs — attendance is confirmed on the flash card', async () => {
    const result = await service.processPartnerAttendanceSla();
    expect(result).toEqual({
      reminders_sent: 0,
      escalated: 0,
      scanned: 0,
    });
    expect(attendanceLogRepo.find).not.toHaveBeenCalled();
    expect(attendanceLogRepo.save).not.toHaveBeenCalled();
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
  });

  it('does not send partner day-3 reminders', async () => {
    const result = await service.processPartnerAttendanceSla();
    expect(result.reminders_sent).toBe(0);
    expect(mailService.sendAttendancePendingPartnerReview).not.toHaveBeenCalled();
  });
});

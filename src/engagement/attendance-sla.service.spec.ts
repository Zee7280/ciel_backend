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

  it('escalates partner-queue logs older than 8 days', async () => {
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const log = {
      id: 'log-1',
      approvalStatus: 'pending',
      assignedApproverType: 'partner',
      escalatedAt: null,
      slaReminderCount: 1,
      createdAt: old,
      participant: { fullName: 'Sara' },
      project: {
        id: 'proj-1',
        title: 'Clean Water',
        partner_organization: { official_email: 'partner@ngo.org' },
      },
    } as unknown as AttendanceLog;

    attendanceLogRepo.find.mockResolvedValue([log]);

    const result = await service.processPartnerAttendanceSla();
    expect(result.escalated).toBe(1);
    expect(attendanceLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedApproverType: 'admin',
        escalatedAt: expect.any(Date),
      }),
    );
    expect(notificationsService.createNotification).toHaveBeenCalled();
  });

  it('sends day-3 reminder for pending partner logs', async () => {
    const createdAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const log = {
      id: 'log-2',
      approvalStatus: 'pending',
      assignedApproverType: 'partner',
      escalatedAt: null,
      slaReminderCount: 0,
      createdAt,
      participant: { fullName: 'Ali' },
      project: {
        id: 'proj-2',
        title: 'Tree Planting',
        partner_organization: { official_email: 'partner@ngo.org' },
      },
    } as unknown as AttendanceLog;

    attendanceLogRepo.find.mockResolvedValue([log]);

    const result = await service.processPartnerAttendanceSla();
    expect(result.reminders_sent).toBe(1);
    expect(mailService.sendAttendancePendingPartnerReview).toHaveBeenCalled();
  });
});

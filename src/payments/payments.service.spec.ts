import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentStatus } from './entities/payment.entity';

describe('PaymentsService manual payment decisions', () => {
  function build(updateAffected = 1) {
    const payment = {
      id: 'p1',
      studentId: 's1',
      projectId: 'o1',
      status: PaymentStatus.PENDING,
      student: { email: 's@x.com' },
      opportunity: { title: 'Proj' },
    };
    const paymentRepo = {
      findOne: jest.fn(() => Promise.resolve(payment)),
      find: jest.fn(() => Promise.resolve([payment])),
      update: jest.fn(() => Promise.resolve({ affected: updateAffected })),
    };
    const notifications = {
      createApprovalNotification: jest
        .fn()
        .mockRejectedValue(new Error('boom')),
    };
    const mail = {
      sendStudentOpportunityStatusUpdate: jest
        .fn()
        .mockRejectedValue(new Error('smtp')),
    };
    const reportRepo = { findOne: jest.fn(() => Promise.resolve(null)) };
    const service = new PaymentsService(
      {} as never,
      {} as never,
      paymentRepo as never,
      reportRepo as never,
      {} as never,
      mail as never,
      notifications as never,
    );
    return { service, paymentRepo, notifications, mail };
  }

  it('uses a conditional update, stores reviewer and survives notification failures', async () => {
    const { service, paymentRepo, notifications, mail } = build();
    const res = await service.verifyManualPayment(
      'p1',
      PaymentStatus.APPROVED,
      undefined,
      {
        id: 'admin-1',
      },
    );
    expect(res.success).toBe(true);
    expect(paymentRepo.update).toHaveBeenCalledWith(
      { id: 'p1', status: PaymentStatus.PENDING },
      expect.objectContaining({
        status: PaymentStatus.APPROVED,
        reviewedBy: 'admin-1',
      }),
    );
    expect(notifications.createApprovalNotification).toHaveBeenCalled();
    expect(mail.sendStudentOpportunityStatusUpdate).toHaveBeenCalled();
  });

  it('rejects the loser of a concurrent verify', async () => {
    const { service } = build(0);
    await expect(
      service.verifyManualPayment('p1', PaymentStatus.APPROVED),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PaymentsService.submitManualPayment — only a submitted report moves into payment review', () => {
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const file = { originalname: 'slip.png', mimetype: 'image/png' } as never;
  function build(opts: {
    report?: { status: string } | null;
    seat?: { id: string } | null;
  }) {
    const report = opts.report ? { ...opts.report } : null;
    const participantRepo = {
      findOne: jest.fn(() => Promise.resolve(opts.seat ?? null)),
    };
    const paymentRepo = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: Record<string, unknown>) =>
        Promise.resolve({ id: 'pay-1', ...row }),
      ),
    };
    const reportRepo = {
      findOne: jest.fn(() => Promise.resolve(report)),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };
    const s3 = { uploadFile: jest.fn(() => Promise.resolve('https://s3/x')) };
    const service = new PaymentsService(
      participantRepo as never,
      {} as never,
      paymentRepo as never,
      reportRepo as never,
      s3 as never,
    );
    return { service, report, reportRepo, s3, paymentRepo };
  }

  it('moves a submitted report to payment_under_review', async () => {
    const { service, report } = build({ report: { status: 'submitted' } });
    await service.submitManualPayment('s1', PROJECT, file, 500);
    expect(report?.status).toBe('payment_under_review');
  });

  it('records the payment but leaves a draft or returned report where it is', async () => {
    for (const status of ['draft', 'revision', 'rejected']) {
      const { service, report, reportRepo, paymentRepo } = build({
        report: { status },
      });
      await service.submitManualPayment('s1', PROJECT, file, 500);
      expect(paymentRepo.save).toHaveBeenCalled();
      expect(report?.status).toBe(status);
      expect(reportRepo.save).not.toHaveBeenCalled();
    }
  });

  it('refuses a project the student has neither a seat nor a report on, before uploading', async () => {
    const { service, s3 } = build({ report: null, seat: null });
    await expect(
      service.submitManualPayment('s1', PROJECT, file, 500),
    ).rejects.toThrow(BadRequestException);
    expect(s3.uploadFile).not.toHaveBeenCalled();
  });
});

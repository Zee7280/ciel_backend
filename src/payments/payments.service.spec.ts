import { ConflictException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentStatus } from './entities/payment.entity';

describe('PaymentsService manual payment decisions', () => {
  function build(updateAffected = 1) {
    const payment: any = {
      id: 'p1',
      studentId: 's1',
      projectId: 'o1',
      status: PaymentStatus.PENDING,
      student: { email: 's@x.com' },
      opportunity: { title: 'Proj' },
    };
    const paymentRepo: any = {
      findOne: jest.fn(async () => payment),
      find: jest.fn(async () => [payment]),
      update: jest.fn(async () => ({ affected: updateAffected })),
    };
    const notifications: any = {
      createApprovalNotification: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const mail: any = {
      sendStudentOpportunityStatusUpdate: jest.fn().mockRejectedValue(new Error('smtp')),
    };
    const reportRepo: any = { findOne: jest.fn(async () => null) };
    const service = new PaymentsService(
      {} as any,
      {} as any,
      paymentRepo,
      reportRepo,
      {} as any,
      mail,
      notifications,
    );
    return { service, paymentRepo, notifications, mail };
  }

  it('uses a conditional update, stores reviewer and survives notification failures', async () => {
    const { service, paymentRepo, notifications, mail } = build();
    const res = await service.verifyManualPayment('p1', PaymentStatus.APPROVED, undefined, {
      id: 'admin-1',
    });
    expect(res.success).toBe(true);
    expect(paymentRepo.update).toHaveBeenCalledWith(
      { id: 'p1', status: PaymentStatus.PENDING },
      expect.objectContaining({ status: PaymentStatus.APPROVED, reviewedBy: 'admin-1' }),
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

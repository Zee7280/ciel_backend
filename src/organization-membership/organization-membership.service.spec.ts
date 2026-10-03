import { BadRequestException } from '@nestjs/common';
import { OrganizationMembershipService } from './organization-membership.service';

describe('OrganizationMembershipService approvals', () => {
  function build(paid: number) {
    const row: any = {
      id: 'f1',
      userId: 'u1',
      organizationId: null,
      status: 'pending_review',
      paidAmountPkr: paid,
      user: { id: 'u1', role: 'university', email: 'u@x.com' },
    };
    const feeRepo: any = {
      findOne: jest.fn(async () => row),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const userRepo: any = { update: jest.fn(async () => ({})) };
    const settingRepo: any = { findOne: jest.fn(async () => ({ value: '10000' })) };
    const service = new OrganizationMembershipService(
      feeRepo,
      userRepo,
      settingRepo,
      {} as any,
      { sendStudentOpportunityStatusUpdate: jest.fn().mockRejectedValue(new Error('x')) } as any,
      { createApprovalNotification: jest.fn().mockRejectedValue(new Error('x')) } as any,
    );
    return { service, userRepo, feeRepo };
  }

  it('refuses an amount mismatch unless explicitly allowed', async () => {
    const { service } = build(500);
    await expect(service.approveSubmission('f1', 'a1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.approveSubmission('f1', 'a1', { allowAmountMismatch: true }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('only activates users still pending_membership_payment', async () => {
    const { service, userRepo } = build(10000);
    await service.approveSubmission('f1', 'a1');
    expect(userRepo.update).toHaveBeenCalledWith(
      { id: 'u1', status: 'pending_membership_payment' },
      { status: 'active' },
    );
  });
});

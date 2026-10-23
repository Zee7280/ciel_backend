import { BadRequestException } from '@nestjs/common';
import { OrganizationMembershipService } from './organization-membership.service';

type MembershipServiceArgs = ConstructorParameters<
  typeof OrganizationMembershipService
>;

describe('OrganizationMembershipService approvals', () => {
  function build(paid: number) {
    const row = {
      id: 'f1',
      userId: 'u1',
      organizationId: null,
      status: 'pending_review',
      paidAmountPkr: paid,
      user: { id: 'u1', role: 'university', email: 'u@x.com' },
    };
    const feeRepo = {
      findOne: jest.fn(() => Promise.resolve(row)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const orgUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const userRepo = {
      update: jest.fn(() => Promise.resolve({})),
      createQueryBuilder: jest.fn(() => orgUpdateQb),
    };
    const settingRepo = {
      findOne: jest.fn(() => Promise.resolve({ value: '10000' })),
    };
    const args = [
      feeRepo,
      userRepo,
      settingRepo,
      {},
      {
        sendStudentOpportunityStatusUpdate: jest
          .fn()
          .mockRejectedValue(new Error('x')),
      },
      {
        createApprovalNotification: jest.fn().mockRejectedValue(new Error('x')),
      },
    ] as unknown as MembershipServiceArgs;
    const service = new OrganizationMembershipService(...args);
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

  it('releases a partner still pending once the admin turns the partner fee off', async () => {
    const { service, userRepo } = build(10000);
    (
      service as unknown as {
        partnerMembershipSettings: {
          isPartnerMembershipRequired: () => Promise<boolean>;
        };
      }
    ).partnerMembershipSettings = {
      isPartnerMembershipRequired: () => Promise.resolve(false),
    };
    const user = {
      id: 'u1',
      role: 'ngo',
      status: 'pending_membership_payment',
      organization: { id: 'o1' },
    };
    const flags = await service.getUiFlags(user as never);
    expect(flags).toEqual({
      requires_membership_payment: false,
      membership_fee_submission_status: null,
      membership_fee_amount_pkr: null,
    });
    expect(user.status).toBe('active');
    expect(userRepo.update).toHaveBeenCalledWith(
      { id: 'u1', status: 'pending_membership_payment' },
      { status: 'active' },
    );
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

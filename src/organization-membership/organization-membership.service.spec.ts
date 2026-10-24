import { BadRequestException } from '@nestjs/common';
import { In } from 'typeorm';
import { OrganizationMembershipService } from './organization-membership.service';
import { UserRole } from '../users/enums/user-role.enum';

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

  it('only activates users still waiting on the fee or on verification', async () => {
    const { service, userRepo } = build(10000);
    await service.approveSubmission('f1', 'a1');
    expect(userRepo.update).toHaveBeenCalledWith(
      {
        id: 'u1',
        status: In(['pending_membership_payment', 'pending_org_verification']),
      },
      { status: 'active' },
    );
  });
});

describe('OrganizationMembershipService university / corporate fee switch', () => {
  function build(required: Record<string, boolean> = {}) {
    const userRepo = {
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      find: jest.fn(() => Promise.resolve([] as unknown[])),
    };
    const settings = {
      isPartnerMembershipRequired: () =>
        Promise.resolve(!!required.PARTNER_MEMBERSHIP_REQUIRED),
      isRequired: (key: string) => Promise.resolve(!!required[key]),
    };
    const args = [
      {},
      userRepo,
      { findOne: jest.fn(() => Promise.resolve(null)) },
      settings,
    ] as unknown as MembershipServiceArgs;
    return { service: new OrganizationMembershipService(...args), userRepo };
  }

  it('university and corporate pay only while their admin switch is on', async () => {
    const off = build().service;
    expect(await off.roleRequiresMembershipPayment(UserRole.UNIVERSITY)).toBe(
      false,
    );
    expect(await off.roleRequiresMembershipPayment(UserRole.CORPORATE)).toBe(
      false,
    );
    const on = build({
      UNIVERSITY_MEMBERSHIP_REQUIRED: true,
      CORPORATE_MEMBERSHIP_REQUIRED: true,
    }).service;
    expect(await on.roleRequiresMembershipPayment(UserRole.UNIVERSITY)).toBe(
      true,
    );
    expect(await on.roleRequiresMembershipPayment(UserRole.CORPORATE)).toBe(
      true,
    );
    expect(await on.roleRequiresMembershipPayment(UserRole.STUDENT)).toBe(
      false,
    );
  });

  it('with the fee off, a pending university waits for verification unless its organization is approved', async () => {
    for (const [verificationStatus, expected] of [
      ['PENDING', 'pending_org_verification'],
      ['APPROVED', 'active'],
    ]) {
      const { service, userRepo } = build();
      const user = {
        id: 'u1',
        role: 'university',
        status: 'pending_membership_payment',
        organization: { id: 'o1', verificationStatus },
      };
      const flags = await service.getUiFlags(user as never);
      expect(flags.requires_membership_payment).toBe(false);
      expect(user.status).toBe(expected);
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 'u1', status: 'pending_membership_payment' },
        { status: expected },
      );
    }
  });

  it('switching the university fee off releases pending universities by organization status', async () => {
    const { service, userRepo } = build();
    userRepo.find.mockResolvedValue([
      {
        id: 'a',
        role: 'university',
        organization: { verificationStatus: 'PENDING' },
      },
      {
        id: 'b',
        role: 'university',
        organization: { verificationStatus: 'APPROVED' },
      },
    ]);
    await expect(
      service.releasePendingMembershipAccounts(UserRole.UNIVERSITY),
    ).resolves.toBe(2);
    expect(userRepo.find).toHaveBeenCalledWith({
      where: { role: 'university', status: 'pending_membership_payment' },
      relations: ['organization'],
    });
    expect(userRepo.update).toHaveBeenCalledWith(
      { id: 'a', status: 'pending_membership_payment' },
      { status: 'pending_org_verification' },
    );
    expect(userRepo.update).toHaveBeenCalledWith(
      { id: 'b', status: 'pending_membership_payment' },
      { status: 'active' },
    );
  });

  it('switching the partner fee off still activates every pending NGO in one update', async () => {
    const { service, userRepo } = build();
    await service.releasePendingMembershipAccounts(UserRole.NGO);
    expect(userRepo.update).toHaveBeenCalledWith(
      { role: 'ngo', status: 'pending_membership_payment' },
      { status: 'active' },
    );
    expect(userRepo.find).not.toHaveBeenCalled();
  });
});

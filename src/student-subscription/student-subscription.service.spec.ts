import { BadRequestException, ConflictException } from '@nestjs/common';
import { StudentSubscriptionService } from './student-subscription.service';
import { PENDING_SUBSCRIPTION_STATUS } from './student-subscription.util';

function build(opts: {
  settings?: Record<string, string | null>;
  memberOrgs?: Array<{ name: string; orgType?: string; verificationStatus?: string }>;
  feeRows?: any[];
  user?: any;
} = {}) {
  const settings = opts.settings ?? {};
  const platformSettings = {
    getString: jest.fn(async (key: string) => settings[key] ?? null),
  } as any;
  const feeRows = opts.feeRows ?? [];
  const feeRepo: any = {
    findOne: jest.fn(async ({ where }: any) => {
      const rows = feeRows.filter((r) => r.userId === where.userId && (!where.status || r.status === where.status));
      return rows[0] ?? null;
    }),
    find: jest.fn(async () => feeRows),
    create: jest.fn((x: any) => ({ id: 'fee-1', ...x })),
    save: jest.fn(async (x: any) => x),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const userRepo: any = {
    findOne: jest.fn(async () => opts.user ?? null),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const organizationRepo: any = {
    find: jest.fn(async () =>
      (opts.memberOrgs ?? []).map((o) => ({ orgType: 'university', verificationStatus: 'APPROVED', ...o })),
    ),
  };
  const notifications = { createApprovalNotification: jest.fn() } as any;
  const mail = { sendStudentOpportunityStatusUpdate: jest.fn() } as any;
  const svc = new StudentSubscriptionService(feeRepo, userRepo, organizationRepo, platformSettings, mail, notifications);
  return { svc, feeRepo, userRepo, organizationRepo, notifications, mail };
}

describe('StudentSubscriptionService — signup decision', () => {
  it('defaults: required ON and fee 300 when no settings rows exist', async () => {
    const { svc } = build();
    expect(await svc.isRequired()).toBe(true);
    expect(await svc.getFeePkr()).toBe(300);
  });

  it('reads the admin-set fee and switch', async () => {
    const { svc } = build({ settings: { STUDENT_SUBSCRIPTION_FEE_PKR: '450', STUDENT_SUBSCRIPTION_REQUIRED: 'false' } });
    expect(await svc.getFeePkr()).toBe(450);
    expect(await svc.isRequired()).toBe(false);
  });

  it('charges a student whose university is not a member organization', async () => {
    const { svc } = build({ memberOrgs: [{ name: 'Beaconhouse National University (BNU)' }] });
    expect(await svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: 'Some Other University' })).toBe(true);
  });

  it('does not charge a student of an approved member university (exact, acronym, or short-name match)', async () => {
    const exact = build({ memberOrgs: [{ name: 'Beaconhouse National University (BNU)' }] });
    expect(await exact.svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: 'Beaconhouse National University (BNU)' })).toBe(false);
    const acronym = build({ memberOrgs: [{ name: 'bnu' }] });
    expect(await acronym.svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: 'Beaconhouse National University (BNU)' })).toBe(false);
    const short = build({ memberOrgs: [{ name: 'Lahore University of Management Sciences' }] });
    expect(await short.svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: 'Lahore University of Management Sciences (LUMS)' })).toBe(false);
  });

  it('ignores pending / rejected university organizations and non-university organizations', async () => {
    const pending = build({ memberOrgs: [{ name: 'Lahore University of Management Sciences (LUMS)', verificationStatus: 'PENDING' }] });
    expect(await pending.svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: 'Lahore University of Management Sciences (LUMS)' })).toBe(true);
    const ngo = build({ memberOrgs: [{ name: 'Beaconhouse National University (BNU)', orgType: 'ngo' }] });
    expect(await ngo.svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: 'Beaconhouse National University (BNU)' })).toBe(true);
  });

  it('never charges non-students, and nobody when the switch is off', async () => {
    const { svc } = build();
    expect(await svc.studentNeedsSubscriptionAtSignup({ role: 'faculty', institution: 'X' })).toBe(false);
    const off = build({ settings: { STUDENT_SUBSCRIPTION_REQUIRED: 'off' } });
    expect(await off.svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: 'X' })).toBe(false);
  });

  it('treats a blank university as non-member (fee applies) rather than crashing', async () => {
    const { svc, organizationRepo } = build();
    expect(await svc.studentNeedsSubscriptionAtSignup({ role: 'student', institution: '  ' })).toBe(true);
    expect(organizationRepo.find).not.toHaveBeenCalled();
  });
});

describe('StudentSubscriptionService — proof submission', () => {
  const pendingUser = { id: 'u1', role: 'student', status: PENDING_SUBSCRIPTION_STATUS, university: 'Other Uni', email: 'a@b.c' };

  it('stores the proof with the configured fee as expected amount', async () => {
    const { svc, feeRepo } = build({ user: pendingUser, settings: { STUDENT_SUBSCRIPTION_FEE_PKR: '300' } });
    const res = await svc.submitProof('u1', 'https://s3/proof.png', '300');
    expect(res.success).toBe(true);
    expect(feeRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', paidAmountPkr: 300, expectedAmountPkr: 300, universityName: 'Other Uni', status: 'pending_review' }),
    );
  });

  it('refuses a second proof while one is pending', async () => {
    const { svc } = build({ user: pendingUser, feeRows: [{ userId: 'u1', status: 'pending_review' }] });
    await expect(svc.submitProof('u1', 'https://s3/p.png')).rejects.toThrow(ConflictException);
  });

  it('refuses when the account is not waiting on the fee', async () => {
    const { svc } = build({ user: { ...pendingUser, status: 'active' } });
    await expect(svc.submitProof('u1', 'https://s3/p.png')).rejects.toThrow(BadRequestException);
  });
});

describe('StudentSubscriptionService — admin decisions and flags', () => {
  it('approve activates only an account still pending the fee, and notifies', async () => {
    const row = { id: 'f1', userId: 'u1', status: 'pending_review', paidAmountPkr: 300, expectedAmountPkr: 300, user: { email: 'a@b.c' } };
    const { svc, feeRepo, userRepo, notifications, mail } = build();
    feeRepo.findOne = jest.fn(async () => row);
    const out = await svc.approveSubmission('f1', 'admin-1');
    expect(out.status).toBe('approved');
    expect(userRepo.update).toHaveBeenCalledWith({ id: 'u1', status: PENDING_SUBSCRIPTION_STATUS }, { status: 'active' });
    expect(notifications.createApprovalNotification).toHaveBeenCalled();
    expect(mail.sendStudentOpportunityStatusUpdate).toHaveBeenCalled();
  });

  it('approve blocks an amount mismatch unless the admin overrides', async () => {
    const row = { id: 'f1', userId: 'u1', status: 'pending_review', paidAmountPkr: 250, expectedAmountPkr: 300, user: {} };
    const { svc, feeRepo } = build();
    feeRepo.findOne = jest.fn(async () => row);
    await expect(svc.approveSubmission('f1', 'admin-1')).rejects.toThrow(/does not match/);
    const ok = await svc.approveSubmission('f1', 'admin-1', { allowAmountMismatch: true });
    expect(ok.status).toBe('approved');
  });

  it('reject records feedback and leaves the account pending so the student can retry', async () => {
    const row = { id: 'f1', userId: 'u1', status: 'pending_review', paidAmountPkr: 300, expectedAmountPkr: 300, user: {} };
    const { svc, feeRepo, userRepo } = build();
    feeRepo.findOne = jest.fn(async () => row);
    const out = await svc.rejectSubmission('f1', 'admin-1', ' wrong receipt ');
    expect(out.status).toBe('rejected');
    expect(out.adminFeedback).toBe('wrong receipt');
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('ui flags: pending student gets amount + latest submission state; others get nothing', async () => {
    const { svc } = build({ feeRows: [{ userId: 'u1', status: 'rejected', createdAt: new Date() }] });
    const flags = await svc.getUiFlags({ id: 'u1', role: 'student', status: PENDING_SUBSCRIPTION_STATUS, university: 'Other Uni' } as any);
    expect(flags).toEqual(
      expect.objectContaining({ requires_subscription_payment: true, subscription_fee_submission_status: 'rejected', subscription_fee_amount_pkr: 300 }),
    );
    expect(flags.subscription_reason).toContain('Other Uni');
    const active = await svc.getUiFlags({ id: 'u2', role: 'student', status: 'active' } as any);
    expect(active.requires_subscription_payment).toBe(false);
    const faculty = await svc.getUiFlags({ id: 'u3', role: 'faculty', status: PENDING_SUBSCRIPTION_STATUS } as any);
    expect(faculty.requires_subscription_payment).toBe(false);
  });

  it('ui flags self-heal: approved proof but status still pending → activates', async () => {
    const { svc, userRepo } = build({ feeRows: [{ userId: 'u1', status: 'approved' }] });
    const flags = await svc.getUiFlags({ id: 'u1', role: 'student', status: PENDING_SUBSCRIPTION_STATUS } as any);
    expect(flags.requires_subscription_payment).toBe(false);
    expect(userRepo.update).toHaveBeenCalledWith({ id: 'u1', status: PENDING_SUBSCRIPTION_STATUS }, { status: 'active' });
  });

  it('ui flags release a pending student whose university became a member, or when the switch is off', async () => {
    const member = build({ memberOrgs: [{ name: 'Lahore University of Management Sciences (LUMS)' }] });
    const f1 = await member.svc.getUiFlags({ id: 'u1', role: 'student', status: PENDING_SUBSCRIPTION_STATUS, university: 'Lahore University of Management Sciences (LUMS)' } as any);
    expect(f1.requires_subscription_payment).toBe(false);
    expect(member.userRepo.update).toHaveBeenCalledWith({ id: 'u1', status: PENDING_SUBSCRIPTION_STATUS }, { status: 'active' });
    const off = build({ settings: { STUDENT_SUBSCRIPTION_REQUIRED: 'false' } });
    const f2 = await off.svc.getUiFlags({ id: 'u2', role: 'student', status: PENDING_SUBSCRIPTION_STATUS, university: 'Other' } as any);
    expect(f2.requires_subscription_payment).toBe(false);
    expect(off.userRepo.update).toHaveBeenCalled();
  });

  it('ui flags use the generic reason for the "Other" university option', async () => {
    const { svc } = build();
    const flags = await svc.getUiFlags({ id: 'u1', role: 'student', status: PENDING_SUBSCRIPTION_STATUS, university: 'Other' } as any);
    expect(flags.requires_subscription_payment).toBe(true);
    expect(flags.subscription_reason).toMatch(/^Your university is not a CIEL member/);
  });

  it('release moves every pending student to active', async () => {
    const { svc, userRepo } = build();
    userRepo.update = jest.fn(async () => ({ affected: 3 }));
    expect(await svc.releasePendingStudentAccounts()).toBe(3);
    expect(userRepo.update).toHaveBeenCalledWith({ role: 'student', status: PENDING_SUBSCRIPTION_STATUS }, { status: 'active' });
  });
});

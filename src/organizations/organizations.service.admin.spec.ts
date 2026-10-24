import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { AdminRejectOrganizationDto } from './dto/organization.dto';

type OrganizationsServiceArgs = ConstructorParameters<
  typeof OrganizationsService
>;

function build(orgRepo: unknown, usersRepo: unknown) {
  const args: unknown[] = new Array<unknown>(9).fill({});
  args[0] = orgRepo;
  args[1] = usersRepo;
  return new OrganizationsService(
    ...(args as unknown as OrganizationsServiceArgs),
  );
}
const qb = () => {
  const q = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  return q;
};

describe('OrganizationsService admin flows', () => {
  it('approve is idempotent', async () => {
    const org = {
      id: 'o',
      verificationStatus: 'APPROVED',
      verifiedBy: 'first',
    };
    const repo = { findOne: jest.fn().mockResolvedValue(org), save: jest.fn() };
    const res = await build(repo, {}).approveOrganization('o', 'second');
    expect(res.verifiedBy).toBe('first');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('updateStatus rejects unknown values with 400', async () => {
    const repo = { findOne: jest.fn(), save: jest.fn() };
    await expect(build(repo, {}).updateStatus('o', 'banana')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejecting revokes org sessions (rejected accounts lose access)', async () => {
    const q = qb();
    const repo = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'o', verificationStatus: 'PENDING' }),
      ),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const svc = build(repo, { createQueryBuilder: () => q });
    await svc.rejectOrganization('o', 'adm', { notes: 'n' } as never);
    expect(q.execute).toHaveBeenCalledTimes(1);
    await svc.updateStatus('o', 'rejected');
    expect(q.execute).toHaveBeenCalledTimes(2);
  });

  it('blocking revokes org sessions', async () => {
    const q = qb();
    const repo = {
      findOne: jest.fn().mockResolvedValue({ id: 'o' }),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    await build(repo, { createQueryBuilder: () => q }).blockOrganization('o');
    expect(q.execute).toHaveBeenCalled();
  });

  it('createForAdmin validates password and duplicate email, stores contact in contactName', async () => {
    const usersRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const manager = {
      create: jest.fn((_e: unknown, x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) =>
        Promise.resolve({ id: 'id', ...x }),
      ),
    };
    const repo = {
      manager: {
        transaction: (fn: (m: typeof manager) => unknown) => fn(manager),
      },
    };
    const svc = build(repo, usersRepo);
    await expect(
      svc.createForAdmin(
        { name: 'N', type: 'ngo', email: 'a@b.c', password: 'short' },
        'adm',
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.createForAdmin(
        { name: 'N', type: 'ngo', email: 'a@b.c', password: '12345678' },
        'adm',
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.createForAdmin(
        { name: 'N', type: 'school', email: 'a@b.c', password: 'longenough' },
        'adm',
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.createForAdmin(
        { type: 'ngo', email: 'a@b.c', password: 'longenough' },
        'adm',
      ),
    ).rejects.toThrow(BadRequestException);
    await svc.createForAdmin(
      {
        name: 'N',
        type: 'NGO',
        email: 'A@B.C',
        password: 'longenough',
        contact: 'Jane',
      },
      'adm',
    );
    const orgArg = manager.create.mock.calls[0][1];
    expect(orgArg.contactName).toBe('Jane');
    expect(orgArg.orgType).toBe('ngo');
    expect(orgArg.contactPhone).toBeUndefined();
    const userArg = manager.create.mock.calls[1][1];
    expect(userArg.name).toBe('Jane');
    expect(userArg.email).toBe('a@b.c');
    usersRepo.findOne.mockResolvedValue({ id: 'x' });
    await expect(
      svc.createForAdmin(
        { name: 'N', type: 'ngo', email: 'a@b.c', password: 'longenough' },
        'adm',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('delete turns a foreign-key violation into 409', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue({ id: 'o' }),
      remove: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('fk'), { code: '23503' })),
    };
    await expect(build(repo, {}).remove('o')).rejects.toThrow(
      ConflictException,
    );
  });

  it('approve and reject email the organization contacts without failing the decision', async () => {
    const mail = {
      sendOrganizationDecisionEmail: jest
        .fn<Promise<void>, [{ to: string; decision: string }]>()
        .mockResolvedValue(undefined),
    };
    const org = {
      id: 'o',
      name: 'Helping Hands',
      verificationStatus: 'PENDING',
      contactEmail: 'Contact@Org.pk',
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(org),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const revoke = qb();
    const users = {
      find: jest
        .fn()
        .mockResolvedValue([
          { email: 'admin@org.pk' },
          { email: 'contact@org.pk' },
        ]),
      createQueryBuilder: () => revoke,
    };
    const args: unknown[] = new Array<unknown>(9).fill({});
    args[0] = repo;
    args[1] = users;
    args[9] = mail;
    const svc = new OrganizationsService(
      ...(args as unknown as OrganizationsServiceArgs),
    );
    await svc.approveOrganization('o', 'adm');
    await new Promise((r) => setImmediate(r));
    const sent = mail.sendOrganizationDecisionEmail.mock.calls.map((c) => [
      c[0].to,
      c[0].decision,
    ]);
    expect(sent).toEqual([
      ['contact@org.pk', 'approved'],
      ['admin@org.pk', 'approved'],
    ]);
    mail.sendOrganizationDecisionEmail.mockRejectedValue(
      new Error('smtp down'),
    );
    await expect(
      svc.rejectOrganization('o', 'adm', {
        notes: 'Missing docs',
      } as AdminRejectOrganizationDto),
    ).resolves.toBeDefined();
  });

  it('rename holds university names to the approved list and keeps them unique', async () => {
    const orgs = [
      { id: 'o', name: 'uni', orgType: 'university' },
      { id: 'other', name: 'Aga Khan University', orgType: 'university' },
    ];
    const repo = {
      findOne: jest.fn(() => Promise.resolve({ ...orgs[0] })),
      find: jest.fn(() => Promise.resolve(orgs)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const q = qb();
    const svc = build(repo, { createQueryBuilder: () => q });
    await expect(svc.renameOrganization('o', 'uni2')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      svc.renameOrganization('o', 'aga khan university'),
    ).rejects.toThrow(ConflictException);
    const saved = await svc.renameOrganization(
      'o',
      'beaconhouse national university (bnu)',
    );
    // Stored in the canonical list spelling, and copied onto member accounts.
    expect(saved.name).toBe('Beaconhouse National University (BNU)');
    expect(q.set).toHaveBeenCalledWith({
      orgName: 'Beaconhouse National University (BNU)',
    });
  });

  it('admin onboarding of a university requires a listed name', async () => {
    const svc = build(
      { find: jest.fn(() => Promise.resolve([])) },
      { findOne: jest.fn().mockResolvedValue(null) },
    );
    await expect(
      svc.createForAdmin(
        {
          name: 'uni',
          type: 'university',
          email: 'a@b.c',
          password: 'longenough',
        },
        'adm',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('admin detail returns uploaded files, the signup proof link and member contact fields', async () => {
    const org = {
      id: 'o',
      name: 'Hope',
      verificationStatus: 'PENDING',
      logoUrl: 'https://b.s3/logos/l.png',
      verificationNotes:
        'Signup proof method: link\nSignup proof detail: LinkedIn\nSignup proof URL: https://linkedin.com/in/x',
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(org),
      createQueryBuilder: () => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          signupProofDocuments: [{ label: 'Proof', url: 'u', fileName: 'f' }],
        }),
      }),
    };
    const users = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'u1',
          name: 'Ali',
          phone: '+923001234567',
          contactPerson: 'CEO',
        },
      ]),
      findOne: jest.fn(),
    };
    const fees = {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'f1', paidAmountPkr: 5000, proofUrl: 'p', status: 'approved' },
        ]),
    };
    const args: unknown[] = new Array<unknown>(9).fill({});
    args[0] = repo;
    args[1] = users;
    args[2] = { count: jest.fn().mockResolvedValue(0) };
    args[7] = fees;
    const svc = new OrganizationsService(
      ...(args as unknown as OrganizationsServiceArgs),
    );
    const d = await svc.getAdminOrganizationDetails('o');
    expect(d.logo_url).toBe(org.logoUrl);
    expect(d.signup_proof_documents).toHaveLength(1);
    expect(d.signup_proof).toEqual({
      method: 'link',
      detail: 'LinkedIn',
      url: 'https://linkedin.com/in/x',
    });
    expect(d.membership_fee_payments[0]).toMatchObject({
      amount_pkr: 5000,
      proof_url: 'p',
      status: 'approved',
    });
    expect(d.members[0]).toMatchObject({
      phone: '+923001234567',
      designation: 'CEO',
    });
  });
});

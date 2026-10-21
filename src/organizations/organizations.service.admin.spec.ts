import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { AdminRejectOrganizationDto } from './dto/organization.dto';

type OrganizationsServiceArgs = ConstructorParameters<
  typeof OrganizationsService
>;

function build(orgRepo: unknown, usersRepo: unknown) {
  const args: unknown[] = new Array<unknown>(8).fill({});
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
    const users = {
      find: jest
        .fn()
        .mockResolvedValue([
          { email: 'admin@org.pk' },
          { email: 'contact@org.pk' },
        ]),
    };
    const args: unknown[] = new Array<unknown>(8).fill({});
    args[0] = repo;
    args[1] = users;
    args[8] = mail;
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
});

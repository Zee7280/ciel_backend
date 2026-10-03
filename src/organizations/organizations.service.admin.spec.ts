import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';

function build(orgRepo: any, usersRepo: any) {
  const args: any[] = new Array(8).fill({});
  args[0] = orgRepo;
  args[1] = usersRepo;
  return new (OrganizationsService as any)(...args) as OrganizationsService;
}
const qb = () => {
  const q: any = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), execute: jest.fn() };
  return q;
};

describe('OrganizationsService admin flows', () => {
  it('approve is idempotent', async () => {
    const org = { id: 'o', verificationStatus: 'APPROVED', verifiedBy: 'first' };
    const repo = { findOne: jest.fn().mockResolvedValue(org), save: jest.fn() };
    const res: any = await build(repo, {}).approveOrganization('o', 'second');
    expect(res.verifiedBy).toBe('first');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('updateStatus rejects unknown values with 400', async () => {
    const repo = { findOne: jest.fn(), save: jest.fn() };
    await expect(build(repo, {}).updateStatus('o', 'banana')).rejects.toThrow(BadRequestException);
  });

  it('blocking revokes org sessions', async () => {
    const q = qb();
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 'o' }), save: jest.fn(async (x) => x) };
    await build(repo, { createQueryBuilder: () => q }).blockOrganization('o');
    expect(q.execute).toHaveBeenCalled();
  });

  it('createForAdmin validates password and duplicate email, stores contact in contactName', async () => {
    const usersRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const manager = {
      create: jest.fn((_e, x) => x),
      save: jest.fn(async (x) => ({ id: 'id', ...x })),
    };
    const repo: any = { manager: { transaction: (fn: any) => fn(manager) } };
    const svc = build(repo, usersRepo);
    await expect(svc.createForAdmin({ email: 'a@b.c', password: 'short' }, 'adm')).rejects.toThrow(BadRequestException);
    await svc.createForAdmin({ name: 'N', type: 'NGO', email: 'A@B.C', password: 'longenough', contact: 'Jane' }, 'adm');
    const orgArg = manager.create.mock.calls[0][1];
    expect(orgArg.contactName).toBe('Jane');
    expect(orgArg.contactPhone).toBeUndefined();
    usersRepo.findOne.mockResolvedValue({ id: 'x' });
    await expect(svc.createForAdmin({ email: 'a@b.c', password: 'longenough' }, 'adm')).rejects.toThrow(ConflictException);
  });

  it('approve and reject email the organization contacts without failing the decision', async () => {
    const mail = { sendOrganizationDecisionEmail: jest.fn().mockResolvedValue(undefined) };
    const org = { id: 'o', name: 'Helping Hands', verificationStatus: 'PENDING', contactEmail: 'Contact@Org.pk' };
    const repo = { findOne: jest.fn().mockResolvedValue(org), save: jest.fn(async (x) => x) };
    const users = { find: jest.fn().mockResolvedValue([{ email: 'admin@org.pk' }, { email: 'contact@org.pk' }]) };
    const args: any[] = new Array(8).fill({});
    args[0] = repo; args[1] = users; args[8] = mail;
    const svc = new (OrganizationsService as any)(...args) as OrganizationsService;
    await svc.approveOrganization('o', 'adm');
    await new Promise((r) => setImmediate(r));
    const sent = mail.sendOrganizationDecisionEmail.mock.calls.map((c) => [c[0].to, c[0].decision]);
    expect(sent).toEqual([['contact@org.pk', 'approved'], ['admin@org.pk', 'approved']]);
    mail.sendOrganizationDecisionEmail.mockRejectedValue(new Error('smtp down'));
    await expect(svc.rejectOrganization('o', 'adm', { notes: 'Missing docs' } as any)).resolves.toBeDefined();
  });
});

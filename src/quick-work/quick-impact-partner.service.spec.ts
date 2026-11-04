import { QuickImpactPartnerService } from './quick-impact-partner.service';
import { UserRole } from '../users/enums/user-role.enum';
import type { MailService } from '../mail/mail.service';

type MailInput = Parameters<MailService['sendQuickImpactPartnerFlashcard']>[0];
type Account = { id: string; role: UserRole };

const approvedLog = (over: Record<string, unknown> = {}) => ({
  id: 'abcdef12-0000-0000-0000-000000000000',
  status: 'approved',
  title: 'Pinktober awareness circle',
  activityType: 'Pinktober event',
  activityTypeOther: null,
  activityDate: '2026-11-03',
  location: 'Lahore',
  summary: 'We ran a desk.',
  sdg: 3,
  peopleReached: 40,
  peopleTarget: null,
  host: 'BNU Health Society',
  hostEmail: 'health@bnu.edu.pk',
  partners: [
    { name: 'Shaukat Khanum', email: 'info@skm.org.pk', contact: null },
  ],
  facultyEmail: 'dr@bnu.edu.pk',
  evidence: [{}],
  participants: [{ email: 'a@bnu.edu.pk', present: true, minutes: 90 }],
  ...over,
});

function setup(opts: {
  log?: ReturnType<typeof approvedLog> | null;
  accounts?: Record<string, { id: string; role: UserRole }>;
  env?: Record<string, string>;
  sendOk?: boolean;
}) {
  const logRepo = {
    findOne: jest
      .fn<Promise<unknown>, [unknown]>()
      .mockResolvedValue(opts.log === undefined ? approvedLog() : opts.log),
  };
  const userRepo = {
    createQueryBuilder: jest.fn(() => {
      let email = '';
      const qb = {
        where: (_sql: string, p: { email: string }) => {
          email = p.email;
          return qb;
        },
        getOne: () =>
          Promise.resolve<Account | null>(opts.accounts?.[email] ?? null),
      };
      return qb;
    }),
    findOne: jest.fn<Promise<unknown>, [unknown]>(),
  };
  const mail = {
    sendQuickImpactPartnerFlashcard: jest
      .fn<Promise<boolean>, [MailInput]>()
      .mockResolvedValue(opts.sendOk ?? true),
  };
  const notifications = { createNotification: jest.fn().mockResolvedValue({}) };
  const config = { get: jest.fn((k: string) => opts.env?.[k]) };
  const service = new QuickImpactPartnerService(
    logRepo as never,
    userRepo as never,
    mail as never,
    notifications as never,
    config as never,
  );
  return { service, logRepo, userRepo, mail, notifications };
}

describe('QuickImpactPartnerService.onApproved', () => {
  it('emails the host and each partner a PDF flashcard, with a register link for new organisations', async () => {
    const { service, mail, notifications } = setup({});
    const res = await service.onApproved('x');
    expect(res).toEqual({ recipients: 2, emailed: 2, notified: 0 });
    const first = mail.sendQuickImpactPartnerFlashcard.mock.calls[0][0];
    expect(first.to).toBe('health@bnu.edu.pk');
    expect(first.existingAccount).toBe(false);
    expect(first.hours).toBe(1.5);
    expect(first.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('notifies an organisation that already has a partner account and links it to sign in', async () => {
    const { service, mail, notifications } = setup({
      accounts: { 'info@skm.org.pk': { id: 'u1', role: UserRole.NGO } },
    });
    const res = await service.onApproved('x');
    expect(res.notified).toBe(1);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'quick_work' }),
    );
    const call = mail.sendQuickImpactPartnerFlashcard.mock.calls.find(
      ([c]) => c.to === 'info@skm.org.pk',
    )![0];
    expect(call.existingAccount).toBe(true);
  });

  it('does not treat a student or faculty account as a partner account', async () => {
    const { service, notifications } = setup({
      accounts: { 'health@bnu.edu.pk': { id: 'u9', role: UserRole.STUDENT } },
    });
    const res = await service.onApproved('x');
    expect(res.notified).toBe(0);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('does nothing when switched off, not approved, missing, or nobody has an email', async () => {
    for (const s of [
      setup({ env: { QCI_PARTNER_EMAIL: 'off' } }),
      setup({ log: approvedLog({ status: 'admin_review' }) }),
      setup({ log: null }),
      setup({ log: approvedLog({ hostEmail: null, partners: [] }) }),
    ]) {
      await s.service.onApproved('x');
      expect(s.mail.sendQuickImpactPartnerFlashcard).not.toHaveBeenCalled();
    }
  });

  it('never throws: a mail failure for one organisation does not stop the next', async () => {
    const { service, mail } = setup({});
    mail.sendQuickImpactPartnerFlashcard
      .mockRejectedValueOnce(new Error('smtp down'))
      .mockResolvedValueOnce(true);
    const res = await service.onApproved('x');
    expect(res).toEqual({ recipients: 2, emailed: 1, notified: 0 });
    const { service: s2, logRepo } = setup({});
    logRepo.findOne.mockRejectedValue(new Error('db down'));
    await expect(s2.onApproved('x')).resolves.toEqual({
      recipients: 0,
      emailed: 0,
      notified: 0,
    });
  });
});

describe('QuickImpactPartnerService.listForPartner', () => {
  it('returns nothing for a non-partner account or one with no email', async () => {
    const { service, userRepo } = setup({});
    userRepo.findOne.mockResolvedValue({
      id: 's',
      email: 's@x.pk',
      role: UserRole.STUDENT,
    });
    expect(await service.listForPartner('s')).toEqual([]);
    userRepo.findOne.mockResolvedValue({
      id: 'p',
      email: '',
      role: UserRole.NGO,
    });
    expect(await service.listForPartner('p')).toEqual([]);
    userRepo.findOne.mockResolvedValue(null);
    expect(await service.listForPartner('none')).toEqual([]);
  });
});

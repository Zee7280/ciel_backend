import { ConfigService } from '@nestjs/config';
import type { SendMailOptions } from 'nodemailer';
import { MailService } from './mail.service';

/** Private members the reliability tests reach into. */
type MailServiceInternals = {
  transporter: { sendMail: jest.Mock; verify: jest.Mock };
  fallbackTransporter: { sendMail: jest.Mock; verify: jest.Mock } | null;
  sendMailReliable: (mailOptions: SendMailOptions) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
};

describe('MailService — SMTP reliability', () => {
  function makeService() {
    const config = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          MAIL_USER: 'noreply@cielpk.com',
          MAIL_PASS: 'secret',
          MAIL_HOST: 'smtpout.secureserver.net',
          MAIL_PORT: '587',
          MAIL_SECURE: 'false',
          MAIL_FROM: 'CIEL <noreply@cielpk.com>',
          FRONTEND_URL: 'https://cielpk.com',
        };
        return map[key];
      }),
    } as unknown as ConfigService;
    const service = new MailService(config);
    return {
      service,
      internals: service as unknown as MailServiceInternals,
    };
  }

  it('retries transient primary SMTP failures then succeeds', async () => {
    const { internals } = makeService();
    jest.spyOn(internals, 'sleep').mockResolvedValue(undefined);
    const sendMail = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      )
      .mockResolvedValueOnce({ messageId: 'ok-1' });
    internals.transporter = { sendMail, verify: jest.fn() };
    internals.fallbackTransporter = null;

    await internals.sendMailReliable({
      from: 'CIEL <noreply@cielpk.com>',
      to: 'faculty@uni.edu',
      subject: 'test',
      html: '<p>hi</p>',
    });

    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('uses fallback SMTP when primary retries are exhausted', async () => {
    const { internals } = makeService();
    jest.spyOn(internals, 'sleep').mockResolvedValue(undefined);
    const primarySend = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('conn reset'), { code: 'ECONNRESET' }),
      );
    const fallbackSend = jest.fn().mockResolvedValue({ messageId: 'fb-1' });
    internals.transporter = { sendMail: primarySend, verify: jest.fn() };
    internals.fallbackTransporter = {
      sendMail: fallbackSend,
      verify: jest.fn(),
    };

    await internals.sendMailReliable({
      from: 'CIEL <noreply@cielpk.com>',
      to: 'partner@ngo.org',
      subject: 'partner verify',
      html: '<p>hi</p>',
    });

    expect(primarySend).toHaveBeenCalled();
    expect(fallbackSend).toHaveBeenCalledTimes(1);
  });

  it('sendPartnerVerification and sendFacultyStudentOpportunityVerification go through reliable send', async () => {
    const { service, internals } = makeService();
    const sendMailReliable = jest.fn<Promise<unknown>, [SendMailOptions]>(() =>
      Promise.resolve({ messageId: 'x' }),
    );
    internals.sendMailReliable = sendMailReliable;

    await service.sendPartnerVerification(
      'partner@ngo.org',
      'Beach cleanup',
      'tok-partner',
    );
    await service.sendFacultyStudentOpportunityVerification(
      'faculty@uni.edu',
      'Beach cleanup',
      'tok-faculty',
    );

    expect(sendMailReliable).toHaveBeenCalledTimes(2);
    expect(sendMailReliable.mock.calls[0][0].to).toBe('partner@ngo.org');
    expect(sendMailReliable.mock.calls[1][0].to).toBe('faculty@uni.edu');
  });
  it('admin bulk email: one message per recipient, dedupes, skips invalid, survives failures', async () => {
    const { service, internals } = makeService();
    const send = jest
      .spyOn(internals, 'sendMailReliable')
      .mockImplementation((m: SendMailOptions) => {
        if (m.to === 'bad@x.com') return Promise.reject(new Error('smtp'));
        return Promise.resolve(undefined);
      });
    const result = await service.sendAdminComposedEmail({
      to: ['a@x.com', 'A@x.com', 'bad@x.com', 'not-an-email', 'b@x.com'],
      subject: 'Hi',
      messageHtml: '<p>x</p>',
    });
    expect(result).toEqual({
      sent: ['a@x.com', 'b@x.com'],
      failed: ['bad@x.com'],
      skipped: ['not-an-email'],
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0].to).toBe('a@x.com');
  });

  it('admin bulk email: rejects more than 200 recipients', async () => {
    const { service } = makeService();
    const to = Array.from({ length: 201 }, (_, i) => `u${i}@x.com`);
    await expect(
      service.sendAdminComposedEmail({
        to,
        subject: 'Hi',
        messageHtml: '<p>x</p>',
      }),
    ).rejects.toThrow(/Too many recipients/);
  });
});

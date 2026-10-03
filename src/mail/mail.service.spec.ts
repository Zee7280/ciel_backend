import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';

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
    return new MailService(config);
  }

  it('retries transient primary SMTP failures then succeeds', async () => {
    const service = makeService();
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    const sendMail = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ messageId: 'ok-1' });
    (service as any).transporter = { sendMail, verify: jest.fn() };
    (service as any).fallbackTransporter = null;

    await (service as any).sendMailReliable({
      from: 'CIEL <noreply@cielpk.com>',
      to: 'faculty@uni.edu',
      subject: 'test',
      html: '<p>hi</p>',
    });

    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('uses fallback SMTP when primary retries are exhausted', async () => {
    const service = makeService();
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    const primarySend = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('conn reset'), { code: 'ECONNRESET' }));
    const fallbackSend = jest.fn().mockResolvedValue({ messageId: 'fb-1' });
    (service as any).transporter = { sendMail: primarySend, verify: jest.fn() };
    (service as any).fallbackTransporter = {
      sendMail: fallbackSend,
      verify: jest.fn(),
    };

    await (service as any).sendMailReliable({
      from: 'CIEL <noreply@cielpk.com>',
      to: 'partner@ngo.org',
      subject: 'partner verify',
      html: '<p>hi</p>',
    });

    expect(primarySend).toHaveBeenCalled();
    expect(fallbackSend).toHaveBeenCalledTimes(1);
  });

  it('sendPartnerVerification and sendFacultyStudentOpportunityVerification go through reliable send', async () => {
    const service = makeService();
    const sendMailReliable = jest.fn().mockResolvedValue({ messageId: 'x' });
    (service as any).sendMailReliable = sendMailReliable;

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
    const service = makeService();
    const send = jest
      .spyOn(service as any, 'sendMailReliable')
      .mockImplementation(async (m: any) => {
        if (m.to === 'bad@x.com') throw new Error('smtp');
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
    expect((send.mock.calls[0][0] as any).to).toBe('a@x.com');
  });

  it('admin bulk email: rejects more than 200 recipients', async () => {
    const service = makeService();
    const to = Array.from({ length: 201 }, (_, i) => `u${i}@x.com`);
    await expect(
      service.sendAdminComposedEmail({ to, subject: 'Hi', messageHtml: '<p>x</p>' }),
    ).rejects.toThrow(/Too many recipients/);
  });
});

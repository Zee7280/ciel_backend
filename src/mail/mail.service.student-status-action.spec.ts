import { ConfigService } from '@nestjs/config';
import type { SendMailOptions } from 'nodemailer';
import { MailService } from './mail.service';

type Internals = {
  sendMailReliable: (mailOptions: SendMailOptions) => Promise<unknown>;
};

const htmlOf = (m: SendMailOptions): string =>
  typeof m.html === 'string' ? m.html : '';

function makeService() {
  const config = {
    get: jest.fn((key: string) =>
      key === 'FRONTEND_URL' ? 'https://cielpk.com' : undefined,
    ),
  } as unknown as ConfigService;
  const service = new MailService(config);
  const sent: SendMailOptions[] = [];
  (service as unknown as Internals).sendMailReliable = (m) => {
    sent.push(m);
    return Promise.resolve({ messageId: 'ok' });
  };
  return { service, sent };
}

describe('sendStudentOpportunityStatusUpdate — action button', () => {
  it('a revision email carries the My Opportunities › Action Required deep link', async () => {
    const { service, sent } = makeService();
    const href =
      'https://cielpk.com/dashboard/student/paths/community-service?view=create&filter=action&opportunity=opp-1';
    await service.sendStudentOpportunityStatusUpdate(
      'student@uni.edu',
      'SOS Class Transformation',
      'Faculty requested revisions on your opportunity',
      'Revision requested',
      'Your faculty supervisor asked you to update your opportunity.',
      'Add the safety plan & budget.',
      {
        actionHref: href,
        actionLabel: 'Open My Opportunities › Action Required',
        actionHint: 'Sign in with your student account and resubmit.',
      },
    );
    expect(sent).toHaveLength(1);
    const html = htmlOf(sent[0]);
    expect(sent[0].to).toBe('student@uni.edu');
    expect(sent[0].subject).toBe(
      'Faculty requested revisions on your opportunity: SOS Class Transformation',
    );
    expect(html).toContain(`href="${href.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('Open My Opportunities › Action Required');
    expect(html).toContain('Sign in with your student account and resubmit.');
    expect(html).toContain('Add the safety plan &amp; budget.');
    // Never a reviewer verification link.
    expect(html).not.toMatch(/\/verify\/(faculty|partner)/);
  });

  it('without an action the email is unchanged (no button, no stray link text)', async () => {
    const { service, sent } = makeService();
    await service.sendStudentOpportunityStatusUpdate(
      'student@uni.edu',
      'SOS Class Transformation',
      'Opportunity update',
      'Approved',
      'Your opportunity is live.',
    );
    const html = htmlOf(sent[0]);
    expect(html).not.toContain('If the button does not open');
    expect(html).not.toContain('<a href=');
  });
});

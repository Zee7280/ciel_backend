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

describe('reviewer verification emails — resubmission / reminder are visibly different', () => {
  it('faculty resubmission: new subject, revised-version banner with the quoted feedback and a fresh-link note', async () => {
    const { service, sent } = makeService();
    await service.sendFacultyStudentOpportunityVerification(
      'fatima.khalid@uni.edu',
      'SOS Class Transformation',
      'tok-2',
      { studentName: 'Ali Raza', facultyReviewerName: 'FATIMA KHALID' },
      {
        path: '/verify/faculty',
        context: {
          kind: 'resubmission',
          version: 2,
          previousFeedback: 'Add the safety plan & budget.',
          feedbackAt: '2026-11-19T09:30:00.000Z',
        },
      },
    );
    expect(sent[0].subject).toBe(
      'CIEL PK — revised opportunity (v2) ready for your approval: SOS Class Transformation',
    );
    const html = htmlOf(sent[0]);
    expect(html).toContain('Revised version (v2)');
    expect(html).toContain('Add the safety plan &amp; budget.');
    expect(html).toContain('new review link');
    expect(html).toContain(
      'resubmitted the opportunity you returned for revision',
    );
    expect(html).toContain('/verify/faculty?token=tok-2');
    expect(html).not.toContain('A student has submitted a new opportunity');
  });

  it('faculty reminder: "Reminder —" subject and a dated reminder banner; first email unchanged', async () => {
    const { service, sent } = makeService();
    await service.sendFacultyStudentOpportunityVerification(
      'fatima.khalid@uni.edu',
      'SOS Class Transformation',
      'tok-1',
      { studentName: 'Ali Raza' },
      { path: '/verify/faculty', context: { kind: 'reminder' } },
    );
    await service.sendFacultyStudentOpportunityVerification(
      'fatima.khalid@uni.edu',
      'SOS Class Transformation',
      'tok-1',
      { studentName: 'Ali Raza' },
      { path: '/verify/faculty' },
    );
    expect(sent[0].subject).toBe(
      'Reminder — CIEL PK — faculty approval requested: SOS Class Transformation',
    );
    expect(htmlOf(sent[0])).toMatch(/Reminder \(sent .+\):/);
    expect(sent[1].subject).toBe(
      'CIEL PK — faculty approval requested: SOS Class Transformation',
    );
    expect(htmlOf(sent[1])).not.toContain('Reminder (sent');
    expect(htmlOf(sent[1])).not.toContain('Revised version');
  });

  it('partner resubmission and reminder get the same treatment', async () => {
    const { service, sent } = makeService();
    await service.sendPartnerVerification(
      'partner@sos.org',
      'SOS Class Transformation',
      'ptok-2',
      { studentName: 'Ali Raza', partnerOrganization: 'SOS Village' },
      {
        path: '/verify/partner',
        introText: 'The creator has resubmitted after your revision request.',
        ctaLabel: 'Review partner approval',
        context: {
          kind: 'resubmission',
          version: 3,
          previousFeedback: 'Name the on-site coordinator.',
        },
      },
    );
    await service.sendPartnerVerification(
      'partner@sos.org',
      'SOS Class Transformation',
      'ptok-2',
      { studentName: 'Ali Raza' },
      { path: '/verify/partner', context: { kind: 'reminder' } },
    );
    expect(sent[0].subject).toBe(
      'CIEL PK — revised opportunity (v3) ready for partner verification: SOS Class Transformation',
    );
    expect(htmlOf(sent[0])).toContain('Revised version (v3)');
    expect(htmlOf(sent[0])).toContain('Name the on-site coordinator.');
    expect(htmlOf(sent[0])).toContain('/verify/partner?token=ptok-2');
    expect(sent[1].subject).toBe(
      'Reminder — CIEL PK — partner verification requested: SOS Class Transformation',
    );
    expect(htmlOf(sent[1])).toMatch(/Reminder \(sent .+\):/);
  });
});

import { ConfigService } from '@nestjs/config';
import type { SendMailOptions } from 'nodemailer';
import { MailService } from './mail.service';

type Internals = {
  sendMailReliable: (mailOptions: SendMailOptions) => Promise<unknown>;
};

const htmlOf = (m: SendMailOptions): string =>
  typeof m.html === 'string' ? m.html : '';

function makeService(fail = false) {
  const config = {
    get: jest.fn((key: string) =>
      key === 'FRONTEND_URL' ? 'https://cielpk.com' : undefined,
    ),
  } as unknown as ConfigService;
  const service = new MailService(config);
  const sent: SendMailOptions[] = [];
  (service as unknown as Internals).sendMailReliable = (m) => {
    if (fail) return Promise.reject(new Error('smtp down'));
    sent.push(m);
    return Promise.resolve({ messageId: 'ok' });
  };
  return { service, sent };
}

describe('sendFacultyReportSubmittedForReview — the supervisor hears that a report is waiting', () => {
  it('names the student and project and links straight to the faculty review page', async () => {
    const { service, sent } = makeService();
    await service.sendFacultyReportSubmittedForReview({
      to: 'zubair@uni.edu',
      facultyName: 'Zubair Faculty',
      studentName: 'student 1',
      projectTitle: 'TEST – Campus Clean-Up and Recycling Drive',
      publicCode: 'CS-2026-997D',
      reportId: 'rep-77',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('zubair@uni.edu');
    expect(sent[0].subject).toBe(
      'Report submitted for your review: TEST – Campus Clean-Up and Recycling Drive',
    );
    const html = htmlOf(sent[0]);
    expect(html).toContain('Dear Zubair Faculty');
    expect(html).toContain('<strong>student 1</strong> has submitted');
    expect(html).toContain('(CS-2026-997D)');
    expect(html).toContain(
      'https://cielpk.com/dashboard/faculty/reports/rep-77',
    );
    expect(html).toContain('Review the report');
  });

  it('a resubmission says so; a mail failure is thrown to the caller (who logs it)', async () => {
    const { service, sent } = makeService();
    await service.sendFacultyReportSubmittedForReview({
      to: 'zubair@uni.edu',
      studentName: 'student 1',
      projectTitle: 'Clean-Up',
      reportId: 'rep-77',
      resubmitted: true,
    });
    expect(sent[0].subject).toBe('Resubmitted for your review: Clean-Up');
    expect(htmlOf(sent[0])).toContain('has resubmitted');
    expect(htmlOf(sent[0])).toContain('Dear Faculty Member');

    const broken = makeService(true);
    await expect(
      broken.service.sendFacultyReportSubmittedForReview({
        to: 'zubair@uni.edu',
        studentName: 'student 1',
        projectTitle: 'Clean-Up',
        reportId: 'rep-77',
      }),
    ).rejects.toThrow('smtp down');
  });
});

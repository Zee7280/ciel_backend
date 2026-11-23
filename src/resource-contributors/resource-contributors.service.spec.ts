import {
  contributionCertificateCode,
  ResourceContributorsService,
} from './resource-contributors.service';
import { ResourceContributionAcknowledgement } from './entities/resource-contribution-acknowledgement.entity';

type Row = Partial<ResourceContributionAcknowledgement> & {
  reportId: string;
  resourceIndex: number;
  token: string;
};

function build(opts: {
  report?: Record<string, unknown> | null;
  users?: Array<{ id: string; email: string }>;
  existing?: Row[];
  mailFails?: boolean;
}) {
  const rows: Row[] = [...(opts.existing || [])];
  const ackRepo = {
    findOne: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(
        rows.find((r) =>
          Object.entries(where).every(
            ([k, v]) => (r as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
      ),
    ),
    find: jest.fn(({ where }: { where: Array<Partial<Row>> }) =>
      Promise.resolve(
        rows.filter((r) =>
          where.some((w) =>
            Object.entries(w).every(
              ([k, v]) => (r as Record<string, unknown>)[k] === v,
            ),
          ),
        ),
      ),
    ),
    create: jest.fn((row: Row) => ({ ...row, id: `ack-${rows.length + 1}` })),
    save: jest.fn((row: Row) => {
      const i = rows.findIndex(
        (r) =>
          r.reportId === row.reportId && r.resourceIndex === row.resourceIndex,
      );
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      return Promise.resolve(row);
    }),
  };
  const reportsRepo = {
    findOne: jest.fn(() => Promise.resolve(opts.report ?? null)),
  };
  const users = opts.users || [];
  const usersRepo = {
    findOne: jest.fn(
      ({ where }: { where: { email?: unknown; id?: string } }) => {
        if (where.id) {
          return Promise.resolve(users.find((u) => u.id === where.id) ?? null);
        }
        // ILike(email) → FindOperator with `.value`
        const op = where.email as { value?: unknown } | string | undefined;
        const raw =
          typeof op === 'string'
            ? op
            : typeof op?.value === 'string'
              ? op.value
              : '';
        const value = raw.toLowerCase();
        return Promise.resolve(
          users.find((u) => u.email.toLowerCase() === value) ?? null,
        );
      },
    ),
  };
  const mail = {
    sendResourceContributorAppreciation: jest.fn(
      (input: Record<string, unknown>) =>
        opts.mailFails
          ? Promise.reject(new Error(`smtp down for ${String(input.to)}`))
          : Promise.resolve(),
    ),
  };
  const notifications = {
    createNotification: jest.fn(() => Promise.resolve()),
  };
  const config = {
    get: (key: string) =>
      key === 'FRONTEND_URL' ? 'https://cielpk.com/' : undefined,
  };
  const service = new ResourceContributorsService(
    ackRepo as never,
    reportsRepo as never,
    usersRepo as never,
    mail as never,
    config as never,
    notifications as never,
  );
  return { service, rows, ackRepo, mail, notifications };
}

const report = {
  id: 'rep-1',
  project_id: 'CS-0042',
  opportunityId: 'opp-1',
  verificationPublicSlug: 'slug-1',
  adminApprovedAt: new Date('2026-11-10T10:00:00Z'),
  student: { name: 'Sara Khan' },
  opportunity: {
    title: 'Classroom repair',
    sdg: '4',
    organization: { name: 'Hope School' },
  },
  section6: {
    use_resources: 'yes',
    resources: [
      {
        type: 'Educational / Learning Materials',
        amount: '50',
        unit: 'Books / Materials',
        sources: ['Individual Donor'],
        purpose: 'Notebooks for Class 4',
        verification: ['Receipt / Invoice'],
        contributor_name: 'Ahmed Books',
        contributor_email: 'Ahmed@Books.pk',
        contributor_phone_code: '+92',
        contributor_phone: '300 1234567',
        evidence_trail: 'Receipt + handover photos',
      },
      {
        type: 'Volunteer Time',
        amount: '20',
        unit: 'Hours',
        sources: ['Student Team'],
        purpose: 'Facilitation',
        contributor_email: 'teammate@uni.edu',
      },
      {
        type: 'Cash / Funding',
        amount: '3000',
        unit: 'PKR',
        sources: ['Corporate / CSR'],
        purpose: 'Paint',
        contributor_name: 'No Email Co',
        contributor_email: '',
      },
    ],
  },
};

describe('ResourceContributorsService — appreciation loop for Section 5 contributors', () => {
  it('FT-06 · a mixed-source entry thanks the contributor for their share, not the whole total', async () => {
    const mixedReport = {
      ...report,
      section6: {
        use_resources: 'yes',
        resources: [
          {
            type: 'Cash / Funding',
            amount: '8,000',
            student_team_share: '3000',
            unit: 'PKR',
            sources: ['Student Team', 'Private Sponsor'],
            purpose: 'Paint and brushes',
            verification: ['Receipt / Invoice'],
            contributor_name: 'Ayesha Khan',
            contributor_email: 'ayesha@example.org',
            contributor_phone_code: '+92',
            contributor_phone: '300 1234567',
            evidence_trail: 'Bank transfer receipt',
          },
        ],
      },
    };
    const { service, mail } = build({ report: mixedReport, users: [] });
    const result = await service.acknowledgeReport('rep-1');
    expect(result).toEqual({ sent: 1, already: 0, skipped: 0, failed: 0 });
    const sent = mail.sendResourceContributorAppreciation.mock.calls[0][0];
    expect(sent.resourceLine).toBe('5000 PKR · Cash / Funding');
  });

  it('thanks every external contributor with an email, exactly once, and links a CIEL account by email', async () => {
    const { service, rows, mail, notifications } = build({
      report,
      users: [{ id: 'user-9', email: 'ahmed@books.pk' }],
    });

    const first = await service.acknowledgeReport('rep-1');
    expect(first).toEqual({ sent: 1, already: 0, skipped: 2, failed: 0 });
    expect(mail.sendResourceContributorAppreciation).toHaveBeenCalledTimes(1);
    const sent = mail.sendResourceContributorAppreciation.mock.calls[0][0];
    expect(sent.to).toBe('ahmed@books.pk');
    expect(sent.contributorName).toBe('Ahmed Books');
    expect(sent.leadName).toBe('Sara Khan');
    expect(sent.projectTitle).toBe('Classroom repair');
    expect(sent.resourceLine).toBe(
      '50 Books / Materials · Educational / Learning Materials',
    );
    expect(sent.existingAccount).toBe(true);
    expect(String(sent.certificateHref)).toMatch(
      /^https:\/\/cielpk\.com\/verify\/contribution\/[0-9a-f-]{36}$/,
    );
    expect(sent.reportVerifyHref).toBe(
      'https://cielpk.com/impact/verify/slug-1',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].linkedUserId).toBe('user-9');
    expect(rows[0].emailSentAt).toBeInstanceOf(Date);
    expect(rows[0].snapshot?.sdg).toBe(4);
    expect(rows[0].snapshot?.partner_name).toBe('Hope School');
    expect(notifications.createNotification).toHaveBeenCalledWith(
      'user-9',
      expect.objectContaining({ type: 'contribution' }),
    );

    // Second publish call (CII lock, repeat approve…) sends nothing new.
    const second = await service.acknowledgeReport('rep-1');
    expect(second).toEqual({ sent: 0, already: 1, skipped: 2, failed: 0 });
    expect(mail.sendResourceContributorAppreciation).toHaveBeenCalledTimes(1);
  });

  it('a failed email is recorded (not thrown) and retried on the next publish call', async () => {
    const built = build({ report, mailFails: true });
    const out = await built.service.acknowledgeReport('rep-1');
    expect(out.failed).toBe(1);
    expect(built.rows[0].emailSentAt).toBeNull();
    expect(built.rows[0].error).toBe('smtp down for ahmed@books.pk');

    const retry = build({ report, existing: built.rows });
    const again = await retry.service.acknowledgeReport('rep-1');
    expect(again.sent).toBe(1);
    expect(retry.rows[0].emailSentAt).toBeInstanceOf(Date);
    expect(retry.rows[0].token).toBe(built.rows[0].token); // same certificate link
  });

  it('public certificate shows the contribution, never the email or phone', async () => {
    const { service } = build({ report });
    await service.acknowledgeReport('rep-1');
    const token = (
      await service.listForUser({ id: 'x', email: 'ahmed@books.pk' })
    )[0];
    const cert = await service.getPublicCertificate(
      token.certificate_url.split('/').pop() || '',
    );
    expect(cert.verified).toBe(true);
    expect(cert.contributor_name).toBe('Ahmed Books');
    expect(cert.project_title).toBe('Classroom repair');
    expect(cert.lead_name).toBe('Sara Khan');
    expect(cert.certificate_code).toMatch(
      /^CIEL-CONTRIB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );
    expect(JSON.stringify(cert)).not.toMatch(/books\.pk|1234567/);
    await expect(service.getPublicCertificate('nope')).rejects.toThrow();
  });

  it('listForUser finds contributions by linked id or by account email and back-fills the link', async () => {
    const { service, rows } = build({ report });
    await service.acknowledgeReport('rep-1');
    expect(rows[0].linkedUserId).toBeNull();
    const mine = await service.listForUser({
      id: 'user-late',
      email: 'AHMED@books.pk',
    });
    expect(mine).toHaveLength(1);
    expect(mine[0].certificate_url).toContain('/verify/contribution/');
    expect(rows[0].linkedUserId).toBe('user-late');
    expect(
      await service.listForUser({ id: 'someone-else', email: 'other@x.pk' }),
    ).toEqual([]);
  });

  it('nothing happens for a missing report', async () => {
    const { service, mail } = build({ report: null });
    expect(await service.acknowledgeReport('missing')).toEqual({
      sent: 0,
      already: 0,
      skipped: 0,
      failed: 0,
    });
    expect(mail.sendResourceContributorAppreciation).not.toHaveBeenCalled();
  });

  it('certificate code is short and stable for a token', () => {
    expect(
      contributionCertificateCode('fa0dca28-abdf-4c15-b008-000000000000'),
    ).toBe('CIEL-CONTRIB-FA0D-CA28-ABDF');
  });
});

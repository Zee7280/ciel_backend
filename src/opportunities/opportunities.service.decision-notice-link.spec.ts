import { ConfigService } from '@nestjs/config';
import type { SendMailOptions } from 'nodemailer';
import { MailService } from '../mail/mail.service';
import { OpportunitiesService } from './opportunities.service';
import type { Opportunity } from './entities/opportunity.entity';

type ServiceArgs = ConstructorParameters<typeof OpportunitiesService>;

type NoticeInput = {
  to: string;
  recipientRole: string;
  action: string;
  openHref?: string | null;
};

type Internals = {
  notifyStakeholdersOfDecision: (
    opportunity: Opportunity,
    input: {
      decidedBy: 'faculty' | 'partner' | 'admin';
      action: 'rejected' | 'revision_requested';
      reason?: string | null;
      actorEmail?: string | null;
      creatorNotified: boolean;
    },
  ) => Promise<void>;
};

function makeHarness() {
  const mailService = {
    sendOpportunityStakeholderDecisionNotice: jest
      .fn()
      .mockResolvedValue(undefined),
    getAdminReviewEmails: jest.fn(() => ['review@cielpk.com']),
  };
  const usersRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'student-1',
      email: 'student@uni.edu',
      name: 'Ali',
      role: 'student',
    }),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
    }),
  };
  const args: unknown[] = [
    { findOne: jest.fn(), find: jest.fn(), save: jest.fn() },
    { count: jest.fn(), find: jest.fn() },
    usersRepository,
    { findOne: jest.fn() },
    {},
    {},
    mailService,
    { createApprovalNotification: jest.fn() },
    {},
    {},
    {},
    {},
  ];
  const service = new OpportunitiesService(...(args as ServiceArgs));
  return { internals: service as unknown as Internals, mailService };
}

const opp = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'SOS Class Transformation',
  isStudentCreated: true,
  creatorId: 'student-1',
  requiresPartnerApproval: true,
  partnerApprovalStatus: 'pending',
  supervision: {
    supervisor_name: 'FATIMA KHALID',
    contact: 'fatima.khalid@uni.edu',
    role: 'Faculty supervisor',
  },
  partner_organization: {
    organization_name: 'SOS Village',
    official_email: 'partner@sos.org',
  },
  createdAt: new Date('2026-11-19T09:00:00Z'),
} as unknown as Opportunity;

describe('communication loop — every stakeholder is told, with a link to their own view', () => {
  const prev = process.env.FRONTEND_URL;
  beforeAll(() => {
    process.env.FRONTEND_URL = 'https://cielpk.com';
  });
  afterAll(() => {
    process.env.FRONTEND_URL = prev;
  });

  it('partner revision: creator (Action Required), faculty and CIEL PK are notified; the partner (actor) is not', async () => {
    const { internals, mailService } = makeHarness();
    await internals.notifyStakeholdersOfDecision(opp, {
      decidedBy: 'partner',
      action: 'revision_requested',
      reason: 'Name the coordinator.',
      actorEmail: 'partner@sos.org',
      creatorNotified: false,
    });
    const calls = mailService.sendOpportunityStakeholderDecisionNotice.mock
      .calls as unknown[][];
    const byRole = new Map<string, NoticeInput>();
    for (const c of calls) {
      const input = c[0] as NoticeInput;
      byRole.set(input.recipientRole, input);
    }
    expect([...byRole.keys()].sort()).toEqual(['admin', 'creator', 'faculty']);
    expect(byRole.get('creator')?.to).toBe('student@uni.edu');
    expect(byRole.get('creator')?.openHref).toBe(
      `https://cielpk.com/dashboard/student/paths/community-service?view=create&filter=action&opportunity=${opp.id}`,
    );
    expect(byRole.get('faculty')?.to).toBe('fatima.khalid@uni.edu');
    expect(byRole.get('faculty')?.openHref).toBe(
      `https://cielpk.com/dashboard/faculty/approvals?opportunity=${opp.id}&tab=pending`,
    );
    expect(byRole.get('admin')?.openHref).toBe(
      `https://cielpk.com/dashboard/admin/approvals?opportunity=${opp.id}&tab=pending`,
    );
    expect([...byRole.values()].map((v) => v.to)).not.toContain(
      'partner@sos.org',
    );
  });

  it('CIEL PK rejection after faculty + partner approved: creator link goes to Rejected / Closed, faculty and partner are told', async () => {
    const { internals, mailService } = makeHarness();
    await internals.notifyStakeholdersOfDecision(
      {
        ...opp,
        facultyApprovalStatus: 'approved',
        partnerApprovalStatus: 'approved',
        workflowStage: 'pending_admin',
      } as unknown as Opportunity,
      {
        decidedBy: 'admin',
        action: 'rejected',
        reason: 'Out of scope.',
        actorEmail: 'review@cielpk.com',
        creatorNotified: false,
      },
    );
    const inputs = (
      mailService.sendOpportunityStakeholderDecisionNotice.mock
        .calls as unknown[][]
    ).map((c) => c[0] as NoticeInput);
    const creator = inputs.find((i) => i.recipientRole === 'creator');
    expect(creator?.openHref).toContain('filter=closed');
    const partner = inputs.find((i) => i.recipientRole === 'partner');
    expect(partner?.to).toBe('partner@sos.org');
    expect(partner?.openHref).toBe(
      `https://cielpk.com/dashboard/partner/verify?opportunity=${opp.id}&tab=pending`,
    );
    // The deciding desk is not re-told; the faculty who approved earlier is.
    expect(inputs.some((i) => i.recipientRole === 'admin')).toBe(false);
    expect(inputs.some((i) => i.to === 'fatima.khalid@uni.edu')).toBe(true);
  });
});

describe('stakeholder decision notice email — the link is rendered', () => {
  it('renders the role-specific button and the status line', async () => {
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const service = new MailService(config);
    const sent: SendMailOptions[] = [];
    (
      service as unknown as {
        sendMailReliable: (m: SendMailOptions) => Promise<unknown>;
      }
    ).sendMailReliable = (m) => {
      sent.push(m);
      return Promise.resolve({ messageId: 'ok' });
    };
    await service.sendOpportunityStakeholderDecisionNotice({
      to: 'student@uni.edu',
      recipientRole: 'creator',
      projectTitle: 'SOS Class Transformation',
      publicCode: 'CS-2026-399E',
      decidedBy: 'partner',
      action: 'revision_requested',
      reason: 'Name the coordinator.',
      openHref:
        'https://cielpk.com/dashboard/student/paths/community-service?view=create&filter=action&opportunity=x',
    });
    await service.sendOpportunityStakeholderDecisionNotice({
      to: 'fatima.khalid@uni.edu',
      recipientRole: 'faculty',
      projectTitle: 'SOS Class Transformation',
      decidedBy: 'partner',
      action: 'revision_requested',
      openHref:
        'https://cielpk.com/dashboard/faculty/approvals?opportunity=x&tab=pending',
    });
    const html0 = typeof sent[0].html === 'string' ? sent[0].html : '';
    const html1 = typeof sent[1].html === 'string' ? sent[1].html : '';
    expect(html0).toContain('Status updated: revision requested');
    expect(html0).toContain('Open My Opportunities › Action Required');
    expect(html0).toContain('filter=action&amp;opportunity=x');
    expect(html1).toContain('Open on CIEL PK');
    expect(html1).toContain(
      '/dashboard/faculty/approvals?opportunity=x&amp;tab=pending',
    );
  });
});

import { OpportunitiesService } from './opportunities.service';
import type { Opportunity } from './entities/opportunity.entity';

type ServiceArgs = ConstructorParameters<typeof OpportunitiesService>;

type NotifyInput = {
  title: string;
  message: string;
  emailSubject: string;
  reason?: string | null;
};

type Internals = {
  notifyStudentOpportunityUpdate: (
    opportunity: Opportunity,
    input: NotifyInput,
  ) => Promise<void>;
};

function makeHarness() {
  const mailService = {
    sendStudentOpportunityStatusUpdate: jest.fn().mockResolvedValue(undefined),
  };
  const notificationsService = {
    createApprovalNotification: jest.fn().mockResolvedValue(undefined),
  };
  const usersRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'student-1',
      email: 'student@uni.edu',
      name: 'Ali',
      role: 'student',
    }),
  };
  const args: unknown[] = [
    { findOne: jest.fn(), find: jest.fn() },
    { count: jest.fn(), find: jest.fn() },
    usersRepository,
    { findOne: jest.fn() },
    {},
    {},
    mailService,
    notificationsService,
    {},
    {},
    {},
    {},
  ];
  const service = new OpportunitiesService(...(args as ServiceArgs));
  return {
    internals: service as unknown as Internals,
    mailService,
    notificationsService,
  };
}

const base: Partial<Opportunity> = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'SOS Class Transformation',
  isStudentCreated: true,
  creatorId: 'student-1',
};

describe('student revision email — deep link to My Opportunities › Action Required', () => {
  const prevFrontend = process.env.FRONTEND_URL;
  beforeAll(() => {
    process.env.FRONTEND_URL = 'https://cielpk.com/';
  });
  afterAll(() => {
    process.env.FRONTEND_URL = prevFrontend;
  });

  it('an opportunity in the revision stage gets the dashboard link, never a verify link', async () => {
    const { internals, mailService, notificationsService } = makeHarness();
    await internals.notifyStudentOpportunityUpdate(
      { ...base, workflowStage: 'revision', status: 'revision' } as Opportunity,
      {
        title: 'Revision requested',
        message:
          'Your faculty supervisor asked you to update your opportunity.',
        emailSubject: 'Faculty requested revisions on your opportunity',
        reason: 'Add a budget.',
      },
    );
    expect(
      notificationsService.createApprovalNotification,
    ).toHaveBeenCalledWith(
      'student-1',
      'Revision requested',
      'Your faculty supervisor asked you to update your opportunity.',
    );
    expect(
      mailService.sendStudentOpportunityStatusUpdate,
    ).toHaveBeenCalledTimes(1);
    const call = mailService.sendStudentOpportunityStatusUpdate.mock
      .calls[0] as unknown[];
    expect(call[0]).toBe('student@uni.edu');
    expect(call[5]).toBe('Add a budget.');
    const action = call[6] as { actionHref: string; actionLabel: string };
    expect(action.actionHref).toBe(
      `https://cielpk.com/dashboard/student/paths/community-service?view=create&filter=action&opportunity=${base.id}`,
    );
    expect(action.actionLabel).toBe('Open My Opportunities › Action Required');
    expect(action.actionHref).not.toMatch(/\/verify\//);
  });

  it('any other status email stays without an action button', async () => {
    const { internals, mailService } = makeHarness();
    await internals.notifyStudentOpportunityUpdate(
      {
        ...base,
        workflowStage: 'pending_partner',
        status: 'pending_partner',
      } as Opportunity,
      {
        title: 'Faculty approved',
        message: 'Now with the partner.',
        emailSubject: 'Faculty approved your opportunity',
      },
    );
    const call = mailService.sendStudentOpportunityStatusUpdate.mock
      .calls[0] as unknown[];
    expect(call[6]).toBeUndefined();
  });
});

import { OpportunitiesService } from './opportunities.service';
import type { Opportunity } from './entities/opportunity.entity';

type ServiceArgs = ConstructorParameters<typeof OpportunitiesService>;

type Internals = {
  sendPartnerApprovalEmail: (
    opportunity: Opportunity,
    introText?: string,
    options?: { reminder?: boolean },
  ) => Promise<boolean>;
};

function makeHarness() {
  const mailService = {
    sendFacultyStudentOpportunityVerification: jest
      .fn()
      .mockResolvedValue(undefined),
    sendPartnerVerification: jest.fn().mockResolvedValue(undefined),
  };
  const opportunitiesRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((o: Opportunity) => Promise.resolve(o)),
  };
  const usersRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'student-1',
      email: 'student@uni.edu',
      name: 'Ali Raza',
      university: 'BNU',
      role: 'student',
    }),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  };
  const args: unknown[] = [
    opportunitiesRepository,
    { count: jest.fn().mockResolvedValue(0), find: jest.fn() },
    usersRepository,
    { findOne: jest.fn().mockResolvedValue(null) },
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
  return { service, internals: service as unknown as Internals, mailService };
}

const future = new Date(Date.now() + 36 * 60 * 60 * 1000);

function studentOpp(extra: Partial<Opportunity> = {}): Partial<Opportunity> {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'SOS Class Transformation',
    status: 'pending_faculty',
    workflowStage: 'pending_faculty',
    isStudentCreated: true,
    creatorId: 'student-1',
    version: 1,
    faculty_verification_token: 'tok-faculty-2',
    facultyTokenExpiresAt: future,
    partnerToken: 'tok-partner-2',
    partnerTokenExpiresAt: future,
    requiresPartnerApproval: true,
    supervision: {
      supervisor_name: 'FATIMA KHALID',
      contact: 'fatima.khalid@uni.edu',
      role: 'Faculty supervisor',
    },
    partner_organization: {
      organization_name: 'SOS Village',
      official_email: 'partner@sos.org',
    },
    approvalHistory: [],
    createdAt: new Date('2026-11-19T09:00:00Z'),
    updatedAt: new Date('2026-11-19T09:25:00Z'),
    ...extra,
  };
}

const facultyRevision = {
  line: 'faculty' as const,
  action: 'revision_requested' as const,
  actorId: null,
  actorName: 'fatima.khalid@uni.edu',
  at: '2026-11-19T09:30:00.000Z',
  version: 1,
  reason: 'Add the safety plan and a budget.',
};

describe('reviewer verification emails say WHY they are sent again', () => {
  it('after a faculty revision + resubmit, the faculty email is a resubmission (v2, feedback quoted)', async () => {
    const { service, mailService } = makeHarness();
    const opp = studentOpp({
      version: 2,
      approvalHistory: [facultyRevision],
    }) as Opportunity;
    const sent =
      await service.notifyFacultyForStudentOpportunityVerification(opp);
    expect(sent).toBe(true);
    const call = mailService.sendFacultyStudentOpportunityVerification.mock
      .calls[0] as unknown[];
    expect(call[0]).toBe('fatima.khalid@uni.edu');
    expect(call[2]).toBe('tok-faculty-2');
    const options = call[4] as { context?: Record<string, unknown> };
    expect(options.context).toEqual({
      kind: 'resubmission',
      version: 2,
      previousFeedback: 'Add the safety plan and a budget.',
      feedbackAt: '2026-11-19T09:30:00.000Z',
    });
  });

  it('a first submission has no context; a student resend is a reminder', async () => {
    const first = makeHarness();
    await first.service.notifyFacultyForStudentOpportunityVerification(
      studentOpp() as Opportunity,
    );
    const firstOptions = (
      first.mailService.sendFacultyStudentOpportunityVerification.mock
        .calls[0] as unknown[]
    )[4] as { context?: unknown };
    expect(firstOptions.context).toBeUndefined();

    const remind = makeHarness();
    await remind.service.notifyFacultyForStudentOpportunityVerification(
      studentOpp({
        version: 2,
        approvalHistory: [facultyRevision],
      }) as Opportunity,
      { reminder: true },
    );
    const remindOptions = (
      remind.mailService.sendFacultyStudentOpportunityVerification.mock
        .calls[0] as unknown[]
    )[4] as { context?: { kind: string } };
    expect(remindOptions.context).toEqual({ kind: 'reminder' });
  });

  it('a faculty approval that follows the revision round is not a resubmission for the faculty line', async () => {
    const { service, mailService } = makeHarness();
    await service.notifyFacultyForStudentOpportunityVerification(
      studentOpp({
        version: 2,
        approvalHistory: [
          facultyRevision,
          { ...facultyRevision, action: 'approved', version: 2, reason: null },
        ],
      }) as Opportunity,
    );
    const options = (
      mailService.sendFacultyStudentOpportunityVerification.mock
        .calls[0] as unknown[]
    )[4] as { context?: unknown };
    expect(options.context).toBeUndefined();
  });

  it('after a partner revision + resubmit, the partner email is a resubmission with a revised intro', async () => {
    const { internals, mailService } = makeHarness();
    const opp = studentOpp({
      version: 2,
      status: 'pending_partner',
      workflowStage: 'pending_partner',
      approvalHistory: [
        { ...facultyRevision, action: 'approved', reason: null },
        {
          line: 'partner',
          action: 'revision_requested',
          actorId: null,
          actorName: 'partner@sos.org',
          at: '2026-11-19T11:00:00.000Z',
          version: 1,
          reason: 'Please name the on-site coordinator.',
        },
      ],
    }) as Opportunity;
    const ok = await internals.sendPartnerApprovalEmail(opp);
    expect(ok).toBe(true);
    const call = mailService.sendPartnerVerification.mock.calls[0] as unknown[];
    expect(call[0]).toBe('partner@sos.org');
    expect(call[2]).toBe('tok-partner-2');
    const options = call[4] as {
      introText?: string;
      context?: Record<string, unknown>;
    };
    expect(options.context).toEqual({
      kind: 'resubmission',
      version: 2,
      previousFeedback: 'Please name the on-site coordinator.',
      feedbackAt: '2026-11-19T11:00:00.000Z',
    });
    expect(options.introText).toContain('resubmitted');
    expect(options.introText).toContain('after your revision request');

    const remind = makeHarness();
    await remind.internals.sendPartnerApprovalEmail(opp, undefined, {
      reminder: true,
    });
    const remindOptions = (
      remind.mailService.sendPartnerVerification.mock.calls[0] as unknown[]
    )[4] as { context?: unknown };
    expect(remindOptions.context).toEqual({ kind: 'reminder' });
  });
});

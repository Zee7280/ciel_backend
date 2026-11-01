import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import type { Opportunity } from './entities/opportunity.entity';
import { UserRole } from '../users/enums/user-role.enum';

type ServiceArgs = ConstructorParameters<typeof OpportunitiesService>;

/** Minimal repository doubles for adminUpdateOpportunityDetails (no DB, no mail). */
function makeHarness(
  opp: Partial<Opportunity>,
  opts?: { occupiedSeats?: number },
) {
  const saved: Opportunity[] = [];
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  };
  const opportunitiesRepository = {
    findOne: jest.fn().mockResolvedValue(opp),
    save: jest.fn().mockImplementation((o: Opportunity) => {
      saved.push(o);
      return Promise.resolve(o);
    }),
    manager: {
      getRepository: jest.fn().mockReturnValue({
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      }),
    },
  };
  const participationRepository = {
    count: jest.fn().mockResolvedValue(opts?.occupiedSeats ?? 0),
    find: jest.fn().mockResolvedValue([]),
  };
  const usersRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  };
  const organizationsRepository = {
    findOne: jest.fn().mockResolvedValue(null),
  };
  const engagementService = {
    reconcilePendingAttendanceAfterOpportunityContactChange: jest
      .fn()
      .mockResolvedValue(undefined),
  };
  const args: unknown[] = [
    opportunitiesRepository,
    participationRepository,
    usersRepository,
    organizationsRepository,
    {},
    engagementService,
    {},
    {},
    {},
    {},
    {},
  ];
  const service = new OpportunitiesService(...(args as ServiceArgs));
  return {
    service,
    saved,
    opportunitiesRepository,
    participationRepository,
    usersRepository,
    organizationsRepository,
    engagementService,
  };
}

function liveOpportunity(
  extra: Partial<Opportunity> = {},
): Partial<Opportunity> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Old title',
    mode: 'On site',
    location: { city: 'Lahore', venue: 'Hall A', pin: '31.5,74.3' },
    timeline: {
      start_date: '2026-11-01',
      end_date: '2026-11-30',
      expected_hours: 16,
      volunteers_required: 4,
    },
    participation_scope: {
      rule: 'own_university_only',
      university_names: ['BNU'],
      department_restriction: { scope: 'all', departments: [] },
    },
    supervision: {
      supervisor_name: 'CIEL PK Verification Team',
      contact: '',
      role: 'Faculty supervisor',
    },
    partner_organization: {
      organization_name: 'almarah foundation',
      contact_person: 'Syed',
      official_email: 'syed@almarah.org',
    },
    facultyId: null,
    organizationId: null,
    isStudentCreated: true,
    admin_approved: true,
    workflowStage: 'live',
    status: 'active',
    facultyApprovalStatus: 'not_applicable',
    partnerApprovalStatus: 'approved',
    adminApprovalStatus: 'approved',
    version: 3,
    team_mode: null,
    ...extra,
  };
}

describe('OpportunitiesService.adminUpdateOpportunityDetails', () => {
  it('rejects an empty patch', async () => {
    const { service } = makeHarness(liveOpportunity());
    await expect(
      service.adminUpdateOpportunityDetails('x', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the opportunity is missing', async () => {
    const h = makeHarness(liveOpportunity());
    h.opportunitiesRepository.findOne.mockResolvedValue(null);
    await expect(
      service(h).adminUpdateOpportunityDetails('x', { title: 'New' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes only the sent listing values, bumps the version and keeps a live listing live', async () => {
    const h = makeHarness(liveOpportunity(), { occupiedSeats: 2 });
    const res = await h.service.adminUpdateOpportunityDetails('x', {
      title: '  Climate   Workshops ',
      expected_hours: 20,
      volunteers_required: 6,
      city: 'Karachi',
    });
    expect(h.saved).toHaveLength(1);
    const o = h.saved[0];
    expect(o.title).toBe('Climate Workshops');
    expect(o.timeline).toMatchObject({
      start_date: '2026-11-01',
      end_date: '2026-11-30',
      expected_hours: 20,
      volunteers_required: 6,
    });
    expect(o.location).toMatchObject({
      city: 'Karachi',
      venue: 'Hall A',
      pin: '31.5,74.3',
    });
    expect(o.version).toBe(4);
    expect(o.workflowStage).toBe('live');
    expect(o.admin_approved).toBe(true);
    expect(res.data.changed).toEqual(['title', 'location', 'timeline']);
    // No faculty / partner change → nothing to propagate or reconcile.
    expect(
      h.engagementService
        .reconcilePendingAttendanceAfterOpportunityContactChange,
    ).not.toHaveBeenCalled();
  });

  it('refuses to shrink seats below the ones already taken', async () => {
    const h = makeHarness(liveOpportunity(), { occupiedSeats: 5 });
    await expect(
      h.service.adminUpdateOpportunityDetails('x', { volunteers_required: 4 }),
    ).rejects.toThrow(/5 seat/);
    expect(h.saved).toHaveLength(0);
  });

  it('rejects an end date before the start date', async () => {
    const h = makeHarness(liveOpportunity());
    await expect(
      h.service.adminUpdateOpportunityDetails('x', { end_date: '2026-10-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores departments on the canonical department_restriction block and adjusts the rule', async () => {
    const h = makeHarness(liveOpportunity());
    await h.service.adminUpdateOpportunityDetails('x', {
      departments: [' Computer  Science', 'Economics', 'Economics', ''],
    });
    expect(h.saved[0].participation_scope).toMatchObject({
      rule: 'own_university_departments',
      department_restriction: {
        scope: 'specific',
        departments: ['Computer Science', 'Economics'],
      },
    });

    const back = makeHarness(
      liveOpportunity({
        participation_scope: {
          rule: 'own_university_departments',
          university_names: ['BNU'],
          department_restriction: {
            scope: 'specific',
            departments: ['Economics'],
          },
          departments: ['Economics'],
        },
      }),
    );
    await back.service.adminUpdateOpportunityDetails('x', { departments: [] });
    const scope = back.saved[0].participation_scope as Record<string, unknown>;
    expect(scope).toMatchObject({
      rule: 'own_university_only',
      department_restriction: { scope: 'all', departments: [] },
    });
    expect(scope.departments).toBeUndefined();
  });

  it('binds a faculty ACCOUNT: writes its name + email as supervisor and sets facultyId', async () => {
    const h = makeHarness(liveOpportunity());
    h.usersRepository.findOne.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Dr Nighat',
      email: 'Nighat@BNU.edu.pk ',
      role: UserRole.FACULTY,
    });
    const res = await h.service.adminUpdateOpportunityDetails('x', {
      faculty_user_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(h.usersRepository.findOne).toHaveBeenCalledWith({
      where: {
        id: '22222222-2222-4222-8222-222222222222',
        role: UserRole.FACULTY,
      },
    });
    const o = h.saved[0];
    expect(o.facultyId).toBe('22222222-2222-4222-8222-222222222222');
    expect(o.supervision).toMatchObject({
      supervisor_name: 'Dr Nighat',
      contact: 'nighat@bnu.edu.pk',
    });
    // Live listing: approvals untouched, enrolments rebound.
    expect(o.workflowStage).toBe('live');
    expect(res.data.faculty_account_linked).toBe(true);
    expect(
      h.engagementService
        .reconcilePendingAttendanceAfterOpportunityContactChange,
    ).toHaveBeenCalledTimes(1);
  });

  it('404s on an unknown / non-faculty account and saves nothing', async () => {
    const h = makeHarness(liveOpportunity());
    await expect(
      h.service.adminUpdateOpportunityDetails('x', {
        faculty_user_id: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.saved).toHaveLength(0);
  });

  it('faculty_user_id: null removes the supervisor and the account link', async () => {
    const h = makeHarness(
      liveOpportunity({
        facultyId: '22222222-2222-4222-8222-222222222222',
        supervision: {
          supervisor_name: 'Dr X',
          contact: 'x@uni.edu',
          role: 'Faculty supervisor',
        },
      }),
    );
    await h.service.adminUpdateOpportunityDetails('x', {
      faculty_user_id: null,
    });
    expect(h.saved[0].facultyId).toBeNull();
    expect(h.saved[0].supervision).toMatchObject({
      supervisor_name: '',
      contact: '',
    });
  });

  it('binds an organisation account and, when asked, copies its contact onto the partner fields', async () => {
    const h = makeHarness(liveOpportunity());
    h.organizationsRepository.findOne.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Almarah Foundation',
      contactName: 'Fasih',
      contactEmail: 'Fasih@almarah.org',
    });
    await h.service.adminUpdateOpportunityDetails('x', {
      organization_id: '33333333-3333-4333-8333-333333333333',
    });
    expect(h.saved[0].organizationId).toBe(
      '33333333-3333-4333-8333-333333333333',
    );
    // Link only: partner contact untouched.
    expect(h.saved[0].partner_organization).toMatchObject({
      official_email: 'syed@almarah.org',
    });

    const copy = makeHarness(liveOpportunity());
    copy.organizationsRepository.findOne.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Almarah Foundation',
      contactName: 'Fasih',
      contactEmail: 'Fasih@almarah.org',
    });
    await copy.service.adminUpdateOpportunityDetails('x', {
      organization_id: '33333333-3333-4333-8333-333333333333',
      copy_partner_contacts_from_organization: true,
    });
    expect(copy.saved[0].partner_organization).toMatchObject({
      organization_name: 'Almarah Foundation',
      contact_person: 'Fasih',
      official_email: 'fasih@almarah.org',
    });
    expect(copy.saved[0].supervision).toMatchObject({
      partner_org_name: 'Almarah Foundation',
      partner_email: 'fasih@almarah.org',
    });
  });

  it('organization_id: null unlinks the organisation account', async () => {
    const h = makeHarness(
      liveOpportunity({
        organizationId: '33333333-3333-4333-8333-333333333333',
      }),
    );
    await h.service.adminUpdateOpportunityDetails('x', {
      organization_id: null,
    });
    expect(h.saved[0].organizationId).toBeNull();
  });
});

function service(h: ReturnType<typeof makeHarness>) {
  return h.service;
}

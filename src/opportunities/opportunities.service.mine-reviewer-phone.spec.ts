import { OpportunitiesService } from './opportunities.service';
import type { Opportunity } from './entities/opportunity.entity';

type ServiceArgs = ConstructorParameters<typeof OpportunitiesService>;

/** Student "mine" list: reviewer WhatsApp falls back to the reviewer's own CIEL PK account phone. */
function makeHarness(
  rows: Partial<Opportunity>[],
  users: Array<{ email: string; countryCode?: string; phone?: string }>,
) {
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(users),
  };
  const opportunitiesRepository = {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const usersRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  };
  const args: unknown[] = [
    opportunitiesRepository,
    { count: jest.fn().mockResolvedValue(0), find: jest.fn() },
    usersRepository,
    { findOne: jest.fn().mockResolvedValue(null) },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
  ];
  const service = new OpportunitiesService(...(args as ServiceArgs));
  return { service, queryBuilder, usersRepository };
}

function studentOpp(extra: Partial<Opportunity> = {}): Partial<Opportunity> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'SOS Class Transformation',
    status: 'pending_faculty',
    isStudentCreated: true,
    creatorId: 'student-1',
    requiresPartnerApproval: false,
    supervision: {
      supervisor_name: 'FATIMA KHALID',
      contact: 'Fatima.Khalid@uni.edu',
      role: 'Faculty supervisor',
    },
    createdAt: new Date('2026-11-19T09:00:00Z'),
    updatedAt: new Date('2026-11-19T09:25:00Z'),
    ...extra,
  };
}

describe('findMineForStudent — reviewer WhatsApp number fallback', () => {
  it('uses the faculty account countryCode + phone when the opportunity has no faculty phone', async () => {
    const { service, queryBuilder } = makeHarness(
      [studentOpp()],
      [
        {
          email: 'fatima.khalid@uni.edu',
          countryCode: '+92',
          phone: '03001234567',
        },
      ],
    );
    const out = (await service.findMineForStudent('student-1')) as {
      data: Array<Record<string, unknown>>;
    };
    expect(out.data).toHaveLength(1);
    expect(out.data[0].faculty_contact_email).toBe('fatima.khalid@uni.edu');
    expect(out.data[0].faculty_contact_phone).toBe('+9203001234567');
    // One lower-cased lookup for the whole list.
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'LOWER(u.email) IN (:...emails)',
      { emails: ['fatima.khalid@uni.edu'] },
    );
  });

  it('a phone saved on the opportunity itself wins over the account phone', async () => {
    const { service } = makeHarness(
      [
        studentOpp({
          supervision: {
            supervisor_name: 'FATIMA KHALID',
            contact: 'fatima.khalid@uni.edu',
            role: 'Faculty supervisor',
            whatsapp_e164: '+923009999999',
          },
        }),
      ],
      [
        {
          email: 'fatima.khalid@uni.edu',
          countryCode: '+92',
          phone: '03001234567',
        },
      ],
    );
    const out = (await service.findMineForStudent('student-1')) as {
      data: Array<Record<string, unknown>>;
    };
    expect(out.data[0].faculty_contact_phone).toBe('+923009999999');
  });

  it('no account (or an account without a phone) leaves the number null; a failing lookup never breaks the list', async () => {
    const none = makeHarness([studentOpp()], []);
    const outNone = (await none.service.findMineForStudent('student-1')) as {
      data: Array<Record<string, unknown>>;
    };
    expect(outNone.data[0].faculty_contact_phone).toBeNull();

    const noPhone = makeHarness(
      [studentOpp()],
      [{ email: 'fatima.khalid@uni.edu', countryCode: '+92', phone: '' }],
    );
    const outNoPhone = (await noPhone.service.findMineForStudent(
      'student-1',
    )) as { data: Array<Record<string, unknown>> };
    expect(outNoPhone.data[0].faculty_contact_phone).toBeNull();

    const broken = makeHarness([studentOpp()], []);
    broken.queryBuilder.getMany.mockRejectedValueOnce(new Error('db down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const outBroken = (await broken.service.findMineForStudent(
      'student-1',
    )) as { data: Array<Record<string, unknown>> };
    expect(outBroken.data).toHaveLength(1);
    expect(outBroken.data[0].faculty_contact_phone).toBeNull();
    warn.mockRestore();
  });
});

describe('admin approval queue — CIEL PK can WhatsApp the faculty and partner reviewers', () => {
  it('each row carries the faculty (account fallback) and partner (saved on the opportunity) numbers', async () => {
    const { service } = makeHarness(
      [],
      [
        {
          email: 'fatima.khalid@uni.edu',
          countryCode: '+92',
          phone: '03001234567',
        },
      ],
    );
    // The admin queue also counts seats (participation repo) and loads the creators (users repo).
    const internals = service as unknown as {
      participationRepository: Record<string, unknown>;
      usersRepository: Record<string, unknown>;
      mapOpportunitiesForAdminQueue: (
        opps: Partial<Opportunity>[],
      ) => Promise<Array<Record<string, unknown>>>;
    };
    internals.participationRepository.createQueryBuilder = jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    }));
    internals.usersRepository.find = jest.fn().mockResolvedValue([]);

    const rows = await internals.mapOpportunitiesForAdminQueue([
      studentOpp({
        status: 'pending_partner',
        requiresPartnerApproval: true,
        supervision: {
          supervisor_name: 'FATIMA KHALID',
          contact: 'fatima.khalid@uni.edu',
          role: 'Faculty supervisor',
          partner_phone: '+92 340 5497821',
        },
      }),
    ]);
    expect(rows[0].faculty_contact_phone).toBe('+9203001234567');
    expect(rows[0].partner_contact_phone).toBe('+92 340 5497821');
  });
});

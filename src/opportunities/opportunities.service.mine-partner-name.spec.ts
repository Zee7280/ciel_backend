import { OpportunitiesService } from './opportunities.service';
import type { Opportunity } from './entities/opportunity.entity';

type ServiceArgs = ConstructorParameters<typeof OpportunitiesService>;

function makeHarness(rows: Partial<Opportunity>[]) {
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const args: unknown[] = [
    { find: jest.fn().mockResolvedValue(rows), findOne: jest.fn() },
    { count: jest.fn().mockResolvedValue(0), find: jest.fn() },
    {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    },
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
  return new OpportunitiesService(...(args as ServiceArgs));
}

const base: Partial<Opportunity> = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Campus Clean-Up and Recycling Drive',
  status: 'pending_partner',
  workflowStage: 'pending_partner',
  isStudentCreated: true,
  creatorId: 'student-1',
  requiresPartnerApproval: true,
  supervision: {
    supervisor_name: 'Zubair Faculty',
    contact: 'zubair@uni.edu',
    role: 'Faculty supervisor',
  },
  createdAt: new Date('2026-11-12T09:00:00Z'),
  updatedAt: new Date('2026-11-12T10:41:00Z'),
};

type Row = Record<string, unknown>;

describe('findMineForStudent — a phone typed as the partner contact person is never the reviewer name', () => {
  it('falls back to the organisation name and keeps the number as the WhatsApp contact', async () => {
    const service = makeHarness([
      {
        ...base,
        partner_organization: {
          organization_name: 'NGO',
          contact_person: '03021414141',
          official_email: 'ngo1@gmail.com',
        },
      },
    ]);
    const out = (await service.findMineForStudent('student-1')) as {
      data: Row[];
    };
    expect(out.data[0].partner_contact_name).toBe('NGO');
    expect(out.data[0].partner_contact_phone).toBe('03021414141');
  });

  it('a real contact person wins, and a saved phone still beats the mistyped one', async () => {
    const service = makeHarness([
      {
        ...base,
        partner_organization: {
          organization_name: 'NGO',
          contact_person: 'Ahmed Raza',
          phone: '+92 300 1234567',
        },
        supervision: {
          ...(base.supervision as Record<string, unknown>),
          partner_contact_person: '03021414141',
        },
      },
    ]);
    const out = (await service.findMineForStudent('student-1')) as {
      data: Row[];
    };
    expect(out.data[0].partner_contact_name).toBe('Ahmed Raza');
    expect(out.data[0].partner_contact_phone).toBe('+92 300 1234567');
  });

  it('with no usable name at all the field stays null (UI shows "Partner / NGO")', async () => {
    const service = makeHarness([
      { ...base, partner_organization: { contact_person: '+923021414141' } },
    ]);
    const out = (await service.findMineForStudent('student-1')) as {
      data: Row[];
    };
    expect(out.data[0].partner_contact_name).toBeNull();
    expect(out.data[0].partner_contact_phone).toBe('+923021414141');
  });
});

import { HttpStatus } from '@nestjs/common';
import { HubExportService } from './hub-export.service';
import { HubExportError, parseExportQuery } from './export-cursor.util';
import type { ExternalPlatform } from '../entities';

type QueryBuilderMock = {
  leftJoinAndSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  getMany: jest.Mock;
  calls: { where: unknown[][]; andWhere: unknown[][]; take: number[] };
};

function queryBuilder(rows: unknown[]): QueryBuilderMock {
  const calls = {
    where: [] as unknown[][],
    andWhere: [] as unknown[][],
    take: [] as number[],
  };
  const qb: Partial<QueryBuilderMock> = { calls };
  qb.leftJoinAndSelect = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn((...a: unknown[]) => {
    calls.where.push(a);
    return qb;
  });
  qb.andWhere = jest.fn((...a: unknown[]) => {
    calls.andWhere.push(a);
    return qb;
  });
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.addOrderBy = jest.fn().mockReturnValue(qb);
  qb.take = jest.fn((n: number) => {
    calls.take.push(n);
    return qb;
  });
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb as QueryBuilderMock;
}

const platform = {
  id: 'plat-1',
  slug: 'bnu-erp',
  status: 'live',
  approvedEventTypes: ['export:students', 'export:fyp'],
} as unknown as ExternalPlatform;
const sandboxPlatform = {
  ...platform,
  status: 'sandbox',
} as unknown as ExternalPlatform;

const sid = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;

const connection = {
  id: 'conn-1',
  platformId: 'plat-1',
  organizationId: 'uni-1',
  status: 'active',
  scopes: ['export:students'],
  personalFieldsAllowed: false,
};

function makeService(opts: {
  users?: unknown[];
  personal?: boolean;
  scopes?: string[];
  orgType?: string;
  studentIds?: string[];
}) {
  const usersQb = queryBuilder(opts.users ?? []);
  const users = {
    createQueryBuilder: jest.fn().mockReturnValue(usersQb),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const organizations = {
    findOne: jest.fn().mockResolvedValue({
      id: 'uni-1',
      name: 'Beaconhouse National University (BNU)',
      orgType: opts.orgType ?? 'UNIVERSITY',
    }),
  };
  const scopeService = {
    isUniversityOrganization: (o: { orgType?: string }) =>
      String(o.orgType || '')
        .toLowerCase()
        .includes('university'),
    resolveUniversityScope: jest.fn().mockResolvedValue({
      org: { id: 'uni-1', name: 'BNU' },
      studentIds: new Set(opts.studentIds ?? [sid(1), sid(2)]),
      opportunityIds: new Set<string>(),
      institutionalOpportunityIds: new Set<string>(),
      affiliatedTeamKeys: new Set<string>(),
    }),
  };
  const connections = {
    resolveForIntake: jest.fn().mockResolvedValue({
      ok: true,
      connection: {
        ...connection,
        scopes: opts.scopes ?? connection.scopes,
        personalFieldsAllowed: opts.personal ?? false,
      },
    }),
  };
  const config = { get: jest.fn().mockReturnValue('https://cielpk.com') };
  const service = new HubExportService(
    users as never,
    organizations as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    scopeService as never,
    connections as never,
    config as never,
  );
  return { service, users, usersQb, connections, scopeService };
}

describe('HubExportService.resolveAccess', () => {
  it('requires a uuid connection_id', async () => {
    const { service } = makeService({});
    await expect(
      service.resolveAccess(platform, undefined, 'export:students'),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      response: { code: 'CONNECTION_ID_REQUIRED' },
    });
  });

  it('refuses an inactive connection with the hub code', async () => {
    const { service, connections } = makeService({});
    connections.resolveForIntake.mockResolvedValue({
      ok: false,
      code: 'CONNECTION_NOT_ACTIVE',
    });
    await expect(
      service.resolveAccess(
        platform,
        '11111111-1111-4111-8111-111111111111',
        'export:students',
      ),
    ).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_ACTIVE' } });
  });

  it('refuses a scope the platform or the connection was not granted', async () => {
    const { service } = makeService({ scopes: ['export:students'] });
    const id = '11111111-1111-4111-8111-111111111111';
    // platform approved, connection not
    await expect(
      service.resolveAccess(platform, id, 'export:fyp'),
    ).rejects.toMatchObject({ response: { code: 'SCOPE_NOT_GRANTED' } });
    // connection granted, platform not
    const b = makeService({ scopes: ['export:ventures'] });
    await expect(
      b.service.resolveAccess(platform, id, 'export:ventures'),
    ).rejects.toMatchObject({ response: { code: 'SCOPE_NOT_GRANTED' } });
  });

  it('only serves university organizations', async () => {
    const { service } = makeService({ orgType: 'NGO' });
    await expect(
      service.resolveAccess(
        platform,
        '11111111-1111-4111-8111-111111111111',
        'export:students',
      ),
    ).rejects.toMatchObject({
      response: { code: 'ORGANIZATION_NOT_UNIVERSITY' },
    });
  });

  it('returns the organization and the personal-fields flag', async () => {
    const { service } = makeService({ personal: true });
    const access = await service.resolveAccess(
      platform,
      '11111111-1111-4111-8111-111111111111',
      'export:students',
    );
    expect(access.organization).toEqual({
      id: 'uni-1',
      name: 'Beaconhouse National University (BNU)',
    });
    expect(access.personalFields).toBe(true);
  });

  it('never grants personal fields to a sandbox platform, whatever the connection says', async () => {
    const { service } = makeService({ personal: true });
    const access = await service.resolveAccess(
      sandboxPlatform,
      '11111111-1111-4111-8111-111111111111',
      'export:students',
    );
    expect(access.personalFields).toBe(false);
  });
});

describe('HubExportService.students', () => {
  const user = (n: number) => ({
    id: sid(n),
    name: `Student ${n}`,
    email: `s${n}@bnu.edu.pk`,
    phone: '0300123456' + n,
    registrationNumber: `BNU-${n}`,
    department: 'Computer Science',
    major: 'BSCS',
    enrollmentYear: '2023',
    university: 'BNU',
    institution: '',
    city: 'Lahore',
    status: 'active',
    profile_verified: true,
    identity_verified: false,
    organization: { id: 'uni-1' },
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, n)),
  });

  async function access(service: HubExportService) {
    return service.resolveAccess(
      platform,
      '11111111-1111-4111-8111-111111111111',
      'export:students',
    );
  }

  it('omits email and phone unless the connection allows personal fields', async () => {
    const a = makeService({ users: [user(1)] });
    const pageA = await a.service.students(
      await access(a.service),
      parseExportQuery({}),
    );
    expect(pageA.rows[0]).toMatchObject({
      id: sid(1),
      registration_number: 'BNU-1',
      department: 'Computer Science',
      programme: 'BSCS',
      linked_to_university_account: true,
    });
    expect(pageA.rows[0]).not.toHaveProperty('email');
    expect(pageA.rows[0]).not.toHaveProperty('phone');

    const b = makeService({ users: [user(1)], personal: true });
    const pageB = await b.service.students(
      await access(b.service),
      parseExportQuery({}),
    );
    expect(pageB.rows[0]).toMatchObject({
      email: 's1@bnu.edu.pk',
      phone: '03001234561',
    });

    const c = makeService({ users: [user(1)], personal: true });
    const pageC = await c.service.students(
      await c.service.resolveAccess(
        sandboxPlatform,
        '11111111-1111-4111-8111-111111111111',
        'export:students',
      ),
      parseExportQuery({}),
    );
    expect(pageC.rows[0]).not.toHaveProperty('email');
    expect(pageC.rows[0]).not.toHaveProperty('phone');
  });

  it('pages by (updated_at, id) and scopes to the university students', async () => {
    const s = makeService({ users: [user(1), user(2), user(3)] });
    const page = await s.service.students(
      await access(s.service),
      parseExportQuery({ limit: '2' }),
    );
    expect(page.rows).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBeTruthy();
    expect(s.usersQb.calls.take).toEqual([3]);
    expect(s.usersQb.calls.where[0][1]).toEqual({ ids: [sid(1), sid(2)] });

    const next = await s.service.students(
      await access(s.service),
      parseExportQuery({
        cursor: page.next_cursor,
        updated_since: '2026-01-01',
      }),
    );
    const keyset = s.usersQb.calls.andWhere.map((c) => String(c[0]));
    expect(keyset.some((sql) => sql.includes('u.updatedAt >= :ksSince'))).toBe(
      true,
    );
    expect(keyset.some((sql) => sql.includes('u.id > :ksI'))).toBe(true);
    expect(next.rows.length).toBeGreaterThan(0);
  });

  it('returns an empty page when the university has no students', async () => {
    const s = makeService({ studentIds: [] });
    const page = await s.service.students(
      await access(s.service),
      parseExportQuery({}),
    );
    expect(page).toEqual({ rows: [], next_cursor: null, has_more: false });
    expect(s.users.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('HubExportError', () => {
  it('carries the hub error shape', () => {
    const e = new HubExportError(HttpStatus.FORBIDDEN, 'X', 'why');
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({
      success: false,
      code: 'X',
      message: 'why',
    });
  });
});

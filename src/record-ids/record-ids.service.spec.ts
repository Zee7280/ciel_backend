import { RecordIdsService } from './record-ids.service';
import { University } from './entities/university.entity';

const uni = (
  id: string,
  code: string,
  name: string,
  extra: Partial<University> = {},
): University =>
  ({
    id,
    code,
    name,
    aliases: [],
    organizationId: null,
    active: true,
    ...extra,
  }) as University;

const BNU = uni('u-bnu', 'BNU', 'Beaconhouse National University (BNU)', {
  organizationId: 'org-bnu',
});
const LUMS = uni(
  'u-lums',
  'LUMS',
  'Lahore University of Management Sciences (LUMS)',
  { aliases: ['Lahore Univ of Mgmt Sciences'] },
);

type Scripted = {
  sql: RegExp;
  rows: unknown[] | ((p: unknown[]) => unknown[]);
};

function build(opts: {
  unis?: University[];
  owner?: Record<string, unknown> | null;
  entity?: Record<string, unknown> | null;
  script?: Scripted[];
}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const updates: unknown[][] = [];
  const script = opts.script ?? [];
  const manager = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const hit = script.find((s) => s.sql.test(sql));
      if (!hit) return Promise.resolve([]);
      return Promise.resolve(
        typeof hit.rows === 'function' ? hit.rows(params) : hit.rows,
      );
    }),
    update: jest.fn((...a: unknown[]) => {
      updates.push(a);
      return Promise.resolve({ affected: 1 });
    }),
    getRepository: jest.fn((target: { name?: string }) => ({
      findOne: jest.fn(() =>
        Promise.resolve(target?.name === 'User' ? opts.owner : opts.entity),
      ),
    })),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    query: jest.fn(() => Promise.resolve([])),
    getRepository: jest.fn(),
  };
  const service = new RecordIdsService(
    { find: jest.fn(() => Promise.resolve(opts.unis ?? [BNU, LUMS])) } as never,
    { findOne: jest.fn(() => Promise.resolve(null)) } as never,
    {} as never,
    dataSource as never,
  );
  return { service, manager, queries, updates, dataSource };
}

describe('RecordIdsService.resolveUniversityId', () => {
  it('uses the account organisation first', async () => {
    const { service } = build({});
    await expect(
      service.resolveUniversityId({
        organizationId: 'org-bnu',
        university: 'LUMS',
      }),
    ).resolves.toBe('u-bnu');
  });

  it('matches the profile by name, abbreviation and alias', async () => {
    const { service } = build({});
    await expect(
      service.resolveUniversityId({ university: 'BNU' }),
    ).resolves.toBe('u-bnu');
    await expect(
      service.resolveUniversityId({
        institution: 'Beaconhouse National University (BNU)',
      }),
    ).resolves.toBe('u-bnu');
    await expect(
      service.resolveUniversityId({
        university: 'Lahore Univ of Mgmt Sciences',
      }),
    ).resolves.toBe('u-lums');
  });

  it('lets the profile win over a name typed on the record', async () => {
    const { service } = build({});
    await expect(
      service.resolveUniversityId({ university: 'BNU', claims: ['LUMS'] }),
    ).resolves.toBe('u-bnu');
  });

  it('falls back to the typed name when the profile is blank', async () => {
    const { service } = build({});
    await expect(
      service.resolveUniversityId({ university: '', claims: ['LUMS'] }),
    ).resolves.toBe('u-lums');
  });

  it('returns null rather than guessing', async () => {
    const { service } = build({});
    await expect(
      service.resolveUniversityId({ university: 'UET', claims: ['Nowhere U'] }),
    ).resolves.toBeNull();
  });
});

describe('RecordIdsService.issue', () => {
  const owner = {
    id: 'stu-1',
    university: 'BNU',
    institution: null,
    universityId: null,
  };

  it('stamps the next number for the university and academic year', async () => {
    const { service, queries } = build({
      owner,
      entity: { id: 'f1', userId: 'stu-1', projectTitle: 'T' },
      script: [
        { sql: /SELECT "publicId"/, rows: [{ publicId: null }] },
        { sql: /INSERT INTO "record_counters"/, rows: [{ lastSeq: 421 }] },
      ],
    });
    const id = await service.issue('fyp', 'f1', {
      at: new Date('2026-09-10T00:00:00Z'),
    });
    expect(id).toBe('CIEL-BNU-2026-0421');
    const counter = queries.find((q) => /record_counters/.test(q.sql))!;
    expect(counter.params).toEqual(['u-bnu', 2026]);
    const update = queries.find((q) => /^UPDATE "fyp_entries"/.test(q.sql))!;
    expect(update.params).toEqual(['CIEL-BNU-2026-0421', 'u-bnu', 'f1']);
  });

  it('returns the existing id untouched and does not bump the counter', async () => {
    const { service, queries } = build({
      owner,
      entity: { id: 'f1', userId: 'stu-1' },
      script: [
        {
          sql: /SELECT "publicId"/,
          rows: [{ publicId: 'CIEL-BNU-2026-0007' }],
        },
      ],
    });
    await expect(service.issue('fyp', 'f1')).resolves.toBe(
      'CIEL-BNU-2026-0007',
    );
    expect(queries.some((q) => /record_counters/.test(q.sql))).toBe(false);
  });

  it('skips a record whose university cannot be resolved', async () => {
    const { service, queries } = build({
      owner: { id: 'stu-1', university: 'Nowhere', universityId: null },
      entity: {
        id: 'f1',
        userId: 'stu-1',
        projectInfo: { university: 'Also nowhere' },
      },
      script: [{ sql: /SELECT "publicId"/, rows: [{ publicId: null }] }],
    });
    await expect(service.issue('fyp', 'f1')).resolves.toBeNull();
    expect(queries.some((q) => /record_counters/.test(q.sql))).toBe(false);
  });

  it('returns null for a record that does not exist', async () => {
    const { service } = build({ owner, entity: null });
    await expect(service.issue('fyp', 'missing')).resolves.toBeNull();
  });

  it('never writes to the users table', async () => {
    const { service, updates, queries } = build({
      owner,
      entity: { id: 'q1', leadUserId: 'stu-1', status: 'submitted' },
      script: [
        { sql: /SELECT "publicId"/, rows: [{ publicId: null }] },
        { sql: /INSERT INTO "record_counters"/, rows: [{ lastSeq: 1 }] },
      ],
    });
    await expect(service.issue('quick_impact', 'q1')).resolves.toMatch(
      /^CIEL-BNU-\d{4}-0001$/,
    );
    expect(updates).toHaveLength(0);
    expect(queries.some((q) => /"users"/.test(q.sql))).toBe(false);
  });
});

describe('RecordIdsService.stampOnto / issueSafely', () => {
  it('does nothing for a record that has not reached the point of getting an id', async () => {
    const { service, queries } = build({});
    const entity = { id: 'f1', projectTitle: '', projectInfo: {} };
    await service.stampOnto('fyp', entity);
    expect(entity).not.toHaveProperty('publicId', expect.any(String));
    expect(queries).toHaveLength(0);
  });

  it('leaves a draft Quick Impact log and a draft report unstamped', async () => {
    const { service, queries } = build({});
    await service.stampOnto('quick_impact', { id: 'q', status: 'draft' });
    await service.stampOnto('community_engagement', {
      id: 'r',
      status: 'draft',
    });
    expect(queries).toHaveLength(0);
  });

  it('copies the issued id onto the entity the caller will return', async () => {
    const { service } = build({
      owner: { id: 'stu-1', university: 'BNU', universityId: null },
      entity: { id: 'f1', userId: 'stu-1', projectTitle: 'T' },
      script: [
        { sql: /SELECT "publicId"/, rows: [{ publicId: null }] },
        { sql: /INSERT INTO "record_counters"/, rows: [{ lastSeq: 3 }] },
      ],
    });
    const entity: {
      id: string;
      projectTitle: string;
      publicId?: string | null;
    } = {
      id: 'f1',
      projectTitle: 'T',
    };
    await service.stampOnto('fyp', entity);
    expect(entity.publicId).toMatch(/^CIEL-BNU-\d{4}-0003$/);
  });

  it('never throws out of a save path', async () => {
    const { service, dataSource } = build({});
    (dataSource.transaction as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(service.issueSafely('fyp', 'f1')).resolves.toBeNull();
  });
});

describe('RecordIdsService.seedUniversities', () => {
  const makeSeedService = (existing: University[]) => {
    const saved: Partial<University>[] = [];
    const universities = {
      find: jest.fn(() =>
        Promise.resolve([...existing, ...(saved as University[])]),
      ),
      create: jest.fn((v: Partial<University>) => v),
      save: jest.fn((v: Partial<University>) => {
        saved.push(v);
        return Promise.resolve(v);
      }),
    };
    const qb = {
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(() => Promise.resolve([])),
    };
    const service = new RecordIdsService(
      universities as never,
      { createQueryBuilder: jest.fn(() => qb) } as never,
      {} as never,
      {} as never,
    );
    return { service, saved };
  };

  it('creates every listed university once with its fixed code', async () => {
    const { service, saved } = makeSeedService([]);
    const created = await service.seedUniversities();
    expect(created).toBe(saved.length);
    expect(saved.length).toBeGreaterThan(90);
    const bnu = saved.find((u) => u.code === 'BNU');
    expect(bnu?.name).toBe('Beaconhouse National University (BNU)');
    expect(bnu?.aliases).toEqual(['Beaconhouse National University']);
    expect(new Set(saved.map((u) => u.code)).size).toBe(saved.length);
  });

  it('is idempotent and never rewrites an existing code', async () => {
    const { service, saved } = makeSeedService([
      uni('x', 'BNUX', 'Beaconhouse National University (BNU)'),
    ]);
    await service.seedUniversities();
    expect(saved.find((u) => u.name?.includes('Beaconhouse'))).toBeUndefined();
    expect(saved.find((u) => u.code === 'BNU')).toBeUndefined();
  });
});

describe('RecordIdsService startup seeding', () => {
  const make = (saveImpl?: () => Promise<unknown>) => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(() => Promise.resolve([])),
    };
    const organizations = { createQueryBuilder: jest.fn(() => qb) };
    const universities = {
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((v: Partial<University>) => v),
      save: jest.fn(saveImpl ?? (() => Promise.resolve({}))),
    };
    const service = new RecordIdsService(
      universities as never,
      organizations as never,
      {} as never,
      {} as never,
    );
    return { service, organizations, universities };
  };

  it('does not walk every organisation at boot', async () => {
    const { service, organizations } = make();
    await service.seedUniversities({ linkOrganizations: false });
    expect(organizations.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('links organisations when asked (admin backfill)', async () => {
    const { service, organizations } = make();
    await service.seedUniversities();
    expect(organizations.createQueryBuilder).toHaveBeenCalled();
  });

  it('shrugs off a university another instance inserted a moment earlier', async () => {
    let n = 0;
    const { service, universities } = make(() => {
      n += 1;
      return n === 3
        ? Promise.reject(Object.assign(new Error('dup'), { code: '23505' }))
        : Promise.resolve({});
    });
    await expect(
      service.seedUniversities({ linkOrganizations: false }),
    ).resolves.toBeGreaterThan(90);
    expect(universities.save.mock.calls.length).toBeGreaterThan(90);
  });

  it('still fails on a real database error', async () => {
    const { service } = make(() =>
      Promise.reject(new Error('connection lost')),
    );
    await expect(
      service.seedUniversities({ linkOrganizations: false }),
    ).rejects.toThrow('connection lost');
  });
});

describe('RecordIdsService.backfill batching', () => {
  it('stamps at most `limit` records per call and reports what remains', async () => {
    const { service, dataSource } = build({});
    const rows = [1, 2, 3, 4, 5].map((n) => ({
      id: 'r' + n,
      createdAt: new Date(`2026-09-0${n}T00:00:00Z`),
    }));
    // every table returns the same five eligible rows only for fyp_entries
    (dataSource.query as jest.Mock).mockImplementation((sql: string) =>
      Promise.resolve(/FROM "fyp_entries"/.test(sql) ? rows : []),
    );
    dataSource.getRepository.mockReturnValue({
      findOne: jest.fn(() => Promise.resolve(null)),
    });
    const report = await service.backfill(true, 2);
    expect(report.remaining).toBe(3);
    const all = await service.backfill(true);
    expect(all.remaining).toBe(0);
  });
});

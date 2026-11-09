import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { NpeGovernanceService } from './npe-governance.service';
import type { NpeRankingService, NpeActor } from './npe-ranking.service';
import type { NpeCriterionOverride } from './entities/npe-criterion-override.entity';
import type { NpeAdminAction } from './entities/npe-admin-action.entity';
import type { NpeRankingChallenge } from './entities/npe-ranking-challenge.entity';
import type { NpeStudioPublication } from './entities/npe-studio-publication.entity';

const admin: NpeActor = { userId: 'admin-1', role: 'ciel_admin' };
const uni: NpeActor = {
  userId: 'uni-1',
  role: 'university',
  organizationId: 'org-1',
  organizationName: 'BNU',
};

function repo<T extends object>(over: Partial<Record<string, jest.Mock>> = {}) {
  const saved: T[] = [];
  return {
    saved,
    mock: {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((v: T) => v),
      save: jest.fn((v: T | T[]) => {
        const rows = Array.isArray(v) ? v : [v];
        for (const r of rows) {
          if (!(r as { id?: string }).id)
            (r as { id?: string }).id = `id-${saved.length + 1}`;
          if (!(r as { createdAt?: Date }).createdAt)
            (r as { createdAt?: Date }).createdAt = new Date('2026-11-10');
          saved.push(r);
        }
        return Promise.resolve(v);
      }),
      ...over,
    } as unknown as Repository<T>,
  };
}

function build(
  over: {
    row?: unknown;
    publication?: unknown;
    overrides?: ReturnType<typeof repo<NpeCriterionOverride>>;
    challenges?: ReturnType<typeof repo<NpeRankingChallenge>>;
  } = {},
) {
  const logAction = jest.fn().mockResolvedValue(undefined);
  const assertReportInScope = jest.fn().mockResolvedValue(undefined);
  const ranking = {
    scopeFor: (a: NpeActor) =>
      a.role === 'ciel_admin' ? 'national' : `university:${a.organizationId}`,
    rowForReport: jest.fn().mockResolvedValue(over.row ?? null),
    assertReportInScope,
    logAction,
    studioCandidates: jest.fn(),
  } as unknown as NpeRankingService;
  const overrides = over.overrides ?? repo<NpeCriterionOverride>();
  const actions = repo<NpeAdminAction>();
  const challenges = over.challenges ?? repo<NpeRankingChallenge>();
  const publications = repo<NpeStudioPublication>({
    findOne: jest.fn().mockResolvedValue(over.publication ?? null),
  });
  const svc = new NpeGovernanceService(
    ranking,
    overrides.mock,
    actions.mock,
    challenges.mock,
    publications.mock,
  );
  return {
    svc,
    logAction,
    assertReportInScope,
    overrides,
    challenges,
    publications,
    ranking,
  };
}

const judgedRow = {
  id: 'r1',
  title: 'Classroom',
  version: 'v7',
  evaluation: {
    criteria: {
      impact: { anchor: 3, confidence: 'high', reason: '', claimIds: [] },
      sdg: { anchor: 2, confidence: 'unsupported', reason: '', claimIds: [] },
    },
  },
  effectiveCriteria: {
    impact: { anchor: 3, confidence: 'high' },
    sdg: { anchor: 2, confidence: 'unsupported' },
  },
};

const dto = {
  reportId: 'r1',
  criterion: 'impact',
  anchor: 5,
  locator: 'EV-3 p.2',
  reason: 'The endline attendance table on page 2 was overlooked.',
};

describe('NPE-1.3 criterion corrections', () => {
  it('saves a correction bound to the package version, with the AI anchor on record, and logs it', async () => {
    const { svc, overrides, logAction } = build({ row: judgedRow });
    const out = await svc.saveOverride(admin, dto);
    expect(out.status).toBe('approved');
    expect(out.override).toEqual(
      expect.objectContaining({
        scope: 'national',
        reportId: 'r1',
        packageVersion: 'v7',
        criterion: 'impact',
        anchor: 5,
        originalAnchor: 3,
        originalConfidence: 'high',
        active: true,
      }),
    );
    expect(overrides.saved).toHaveLength(1);
    const expectedDetails: unknown = expect.objectContaining({
      from: 3,
      to: 5,
      aiAnchor: 3,
    });
    expect(logAction).toHaveBeenCalledWith(
      admin,
      'national',
      'override.save',
      expect.objectContaining({ reportId: 'r1', details: expectedDetails }),
    );
  });

  it('refuses a project outside the scope, an unread package, an unsupported criterion and a no-op', async () => {
    await expect(
      build({ row: null }).svc.saveOverride(admin, dto),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      build({ row: { ...judgedRow, evaluation: null } }).svc.saveOverride(
        admin,
        dto,
      ),
    ).rejects.toThrow(/has not read this package yet/);
    await expect(
      build({ row: judgedRow }).svc.saveOverride(admin, {
        ...dto,
        criterion: 'sdg',
      }),
    ).rejects.toThrow(/Unsupported criteria require verified new evidence/);
    await expect(
      build({ row: judgedRow }).svc.saveOverride(admin, { ...dto, anchor: 3 }),
    ).rejects.toThrow(/already stands at 3\/5/);
    await expect(
      build({ row: judgedRow }).svc.saveOverride(admin, {
        ...dto,
        criterion: 'bogus',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('supersedes the previous active correction of the same criterion instead of deleting it', async () => {
    const previous = {
      id: 'old',
      scope: 'national',
      reportId: 'r1',
      criterion: 'impact',
      anchor: 4,
      active: true,
      createdAt: new Date('2026-10-01'),
    } as unknown as NpeCriterionOverride;
    const overrides = repo<NpeCriterionOverride>({
      find: jest.fn().mockResolvedValue([previous]),
    });
    const { svc } = build({
      row: {
        ...judgedRow,
        effectiveCriteria: {
          ...judgedRow.effectiveCriteria,
          impact: { anchor: 4, confidence: 'high' },
        },
      },
      overrides,
    });
    const out = await svc.saveOverride(admin, dto);
    expect(previous.active).toBe(false);
    expect(previous.revokeReason).toMatch(/Superseded/);
    expect(out.override.anchor).toBe(5);
    expect(out.override.originalAnchor).toBe(3);
  });

  it('a university actor corrects within its own scope only', async () => {
    const { svc, overrides } = build({ row: judgedRow });
    const out = await svc.saveOverride(uni, dto);
    expect(out.override.scope).toBe('university:org-1');
    expect((overrides.saved[0] as { role: string }).role).toBe('university');
  });

  it('revoking keeps the record and refuses another scope', async () => {
    const stored = {
      id: 'o1',
      scope: 'national',
      reportId: 'r1',
      criterion: 'impact',
      anchor: 5,
      originalAnchor: 3,
      active: true,
      createdAt: new Date('2026-11-01'),
    } as unknown as NpeCriterionOverride;
    const overrides = repo<NpeCriterionOverride>({
      findOne: jest.fn().mockResolvedValue(stored),
    });
    const { svc } = build({ overrides });
    await expect(svc.revokeOverride(uni, 'o1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const out = await svc.revokeOverride(admin, 'o1', 'Evidence withdrawn');
    expect(out.status).toBe('revoked');
    expect(stored.active).toBe(false);
    expect(stored.revokeReason).toBe('Evidence withdrawn');
    expect((await svc.revokeOverride(admin, 'o1')).status).toBe('unchanged');
  });
});

describe('NPE-1.3 challenge process', () => {
  const publication = {
    id: 'pub-1',
    scope: 'national',
    name: 'Overall Project Excellence — All eligible projects',
    revision: 2,
    lens: 'excellence',
    publishedAt: new Date('2026-11-01'),
    rows: [{ id: 'r1', label: 'Classroom', rank: 4, projectIds: ['r1'] }],
  };
  const challengeDto = {
    publicationId: 'pub-1',
    reportId: 'r1',
    locator: 'EV-5 register',
    reason: 'The second cohort register was not counted in reach.',
  };

  it('a university may challenge the national position of its own project; the project must be in the publication', async () => {
    const { svc, assertReportInScope, logAction } = build({ publication });
    const out = await svc.openChallenge(uni, challengeDto);
    expect(assertReportInScope).toHaveBeenCalledWith(uni, 'r1');
    expect(out).toEqual(
      expect.objectContaining({
        scope: 'national',
        raisedByScope: 'university:org-1',
        status: 'open',
      }),
    );
    expect(logAction).toHaveBeenCalledWith(
      uni,
      'national',
      'challenge.open',
      expect.anything(),
    );
    await expect(
      build({ publication }).svc.openChallenge(uni, {
        ...challengeDto,
        reportId: 'r9',
      }),
    ).rejects.toThrow(/not part of that published ranking/);
    await expect(
      build({
        publication: { ...publication, scope: 'university:org-2' },
      }).svc.openChallenge(uni, challengeDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('only the owner of the publication scope resolves, once, and the decision is logged', async () => {
    const stored = {
      id: 'c1',
      scope: 'national',
      publicationId: 'pub-1',
      reportId: 'r1',
      status: 'open',
      createdAt: new Date('2026-11-02'),
    } as unknown as NpeRankingChallenge;
    const challenges = repo<NpeRankingChallenge>({
      findOne: jest.fn().mockResolvedValue(stored),
    });
    const { svc, logAction } = build({ challenges });
    const resolve = {
      status: 'upheld' as const,
      resolution: 'Register confirms the second cohort.',
    };
    await expect(
      svc.resolveChallenge(uni, 'c1', resolve),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const out = await svc.resolveChallenge(admin, 'c1', resolve);
    expect(out.status).toBe('upheld');
    const expectedDecision: unknown = expect.objectContaining({
      status: 'upheld',
    });
    expect(logAction).toHaveBeenCalledWith(
      admin,
      'national',
      'challenge.resolve',
      expect.objectContaining({ details: expectedDecision }),
    );
    await expect(svc.resolveChallenge(admin, 'c1', resolve)).rejects.toThrow(
      /already resolved/,
    );
  });
});

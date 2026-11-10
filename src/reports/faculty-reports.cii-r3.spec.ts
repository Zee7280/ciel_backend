import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FacultyReportsService } from './faculty-reports.service';
import {
  CII_V45_DIMENSIONS,
  CII_V45_RUBRIC_VERSION,
  CiiV45CriterionScore,
  CiiV45EvaluatorPayload,
  computeCiiV45Result,
} from './cii-v4-5.constants';
import {
  buildCielPkAiEvaluationPayloadV45,
  type EvidenceByteSource,
} from './build-ciel-pk-ai-evaluation-payload.util';
import {
  isCiiL6PendingLock,
  pickCiiV45DisplayBadge,
} from './cii-v4-5-display.util';
import { redactCiiV45Fields } from './cii-v4-5-redaction.util';
import type { StudentReport } from './entities/student-report.entity';

type Row = Record<string, unknown>;
type Deps = ConstructorParameters<typeof FacultyReportsService>;
type Qb = {
  update: jest.Mock;
  set: jest.Mock<unknown, [Record<string, unknown>]>;
  where: jest.Mock;
  andWhere: jest.Mock;
  execute: jest.Mock;
};

function makeService(report: Row | null, updateAffected = 1) {
  const qb: Qb = {
    update: jest.fn(() => qb),
    set: jest.fn<unknown, [Record<string, unknown>]>(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    execute: jest.fn(() => Promise.resolve({ affected: updateAffected })),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    findOne: jest.fn(() => Promise.resolve(report)),
    save: jest.fn((r: Row) => Promise.resolve(r)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const s3 = {
    getObjectBufferByPublicUrl: jest.fn().mockResolvedValue(null),
    keyFromPublicUrl: jest.fn((url: string) =>
      url.startsWith('https://bucket.s3.eu.amazonaws.com/')
        ? url.slice('https://bucket.s3.eu.amazonaws.com/'.length)
        : null,
    ),
    presignPutObject: jest.fn().mockResolvedValue({
      uploadUrl: 'https://put',
      publicUrl: 'https://bucket.s3.eu.amazonaws.com/k',
      key: 'k',
    }),
  };
  const service = new FacultyReportsService(
    repo as unknown as Deps[0],
    {} as Deps[1],
    {
      getScopedOpportunityIds: jest.fn().mockResolvedValue([]),
      getPersonalOpportunityIds: jest.fn().mockResolvedValue([]),
    } as unknown as Deps[2],
    { summarize: jest.fn() } as unknown as Deps[3],
    {} as unknown as Deps[4],
    {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((rows: unknown) => Promise.resolve(rows)),
    } as unknown as Deps[5],
    {
      sendStudentImpactReportFacultyDecision: jest
        .fn()
        .mockResolvedValue(undefined),
    } as unknown as Deps[6],
    {
      createNotification: jest.fn().mockResolvedValue(undefined),
    } as unknown as Deps[7],
    { find: jest.fn().mockResolvedValue([]) } as unknown as Deps[8],
    { find: jest.fn().mockResolvedValue([]) } as unknown as Deps[9],
    s3 as unknown as Deps[10],
  );
  return { service, repo, qb, s3 };
}

async function fingerprintFor(report: Row): Promise<string> {
  const payload = await buildCielPkAiEvaluationPayloadV45(
    report as unknown as StudentReport,
    {
      getObjectBufferByPublicUrl: jest.fn().mockResolvedValue(null),
    } as unknown as EvidenceByteSource,
  );
  return payload.input_fingerprint;
}

type Anchor = 0 | 1 | 2 | 3 | 4;

/** An R3 analysis with Admin evidence already assessed, so it is FINAL and approvable. */
function r3Payload(
  fingerprint: string,
  aiAnchor: Anchor,
  evidenceAnchor: Anchor,
  extra: Partial<CiiV45EvaluatorPayload> = {},
): CiiV45EvaluatorPayload {
  const sectionScores = CII_V45_DIMENSIONS.map((dim) => ({
    dimension: dim.id,
    criterionScores: dim.criteria.map(({ key }): CiiV45CriterionScore => {
      const a = dim.id === '7' ? evidenceAnchor : aiAnchor;
      return {
        criterion: key,
        anchor: a,
        qualityAnchor: a,
        verificationStatus: dim.id === '7' ? 'ADMIN_VERIFIED' : 'AI_REPORT',
        sourceRefs: ['s1'],
        evidenceIds: [],
        reasoningSummary: 'Judgement with a source.',
      };
    }),
  }));
  const d7 = sectionScores.find((s) => s.dimension === '7')!;
  return {
    frameworkVersion: '5.0',
    reportId: 'report-1',
    inputFingerprint: fingerprint,
    inputCompleteness: {
      gaps: [],
      individualHours: [
        {
          studentId: 's1',
          hours: 20,
          requiredHours: 16,
          verified: true,
          recordComplete: true,
        },
      ],
      mandatoryFieldsComplete: true,
    },
    claimInventory: [],
    evidenceAudit: [],
    sectionScores,
    deductionLedger: [],
    extraMileUplift: { assessmentStatus: 'ASSESSED', items: [] },
    integrityPenalty: { points: 0, issues: [] },
    exceptionalFeature: null,
    adminEvidenceAssessment: {
      status: 'ASSESSED',
      assessorId: 'admin-0',
      assessedAt: '2026-11-01T00:00:00.000Z',
      criteria: d7.criterionScores.map((c) => ({
        criterion: c.criterion,
        anchor: c.anchor as 0 | 1 | 2 | 3 | 4,
        reasoningSummary: c.reasoningSummary,
        evidenceIds: [],
      })),
    },
    adminReviewReasons: [],
    strengths: ['Strong work'],
    developmentPriorities: ['Add a follow-up'],
    analysisSummary: 'Summary',
    evidenceSummary: 'Evidence',
    studentFeedback: 'Well done',
    ...extra,
  };
}

async function approvableReport(
  aiAnchor: Anchor,
  evidenceAnchor: Anchor,
  extra: Partial<CiiV45EvaluatorPayload> = {},
): Promise<Row> {
  const report: Row = {
    id: 'report-1',
    status: 'submitted',
    section1: { team_lead: { hours: 20 } },
    ciiV45Lock: null,
  };
  const fp = await fingerprintFor(report);
  report.ciiV45 = {
    ...computeCiiV45Result(r3Payload(fp, aiAnchor, evidenceAnchor, extra)),
  };
  return report;
}

const qualified = {
  observedRetention: true,
  communityOwnership: true,
  externalCorroboration: true,
  sourceRef: 'section10.follow_up',
};

type Approval = {
  data: {
    ciiV45: Row & {
      finalCII: number;
      finalBadge: { code: string } | null;
      candidateBadge: { code: string } | null;
      badgeStatus: string;
    };
    ciiV45Lock: Row & {
      locked: boolean;
      hash: string;
      finalBadge: { code: string } | null;
      candidateBadge: { code: string } | null;
      badgeStatus: string;
      rubricVersion: string;
      l6Qualification: Row | null;
      scoreWasModerated: boolean;
      aiRecommendedScore: number;
      adminApprovedScore: number;
    };
  };
};

describe('FacultyReportsService — R3 approval and L6 policy', () => {
  it('keeps a 90+ CII and leaves L6 pending when no qualification is given, never substituting L5', async () => {
    const report = await approvableReport(4, 3); // AI 85 + evidence 12.75
    const { service } = makeService(report);
    const out = (await service.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
    )) as unknown as Approval;
    expect(out.data.ciiV45.finalCII).toBe(97.8);
    expect(out.data.ciiV45.finalBadge).toBeNull();
    expect(out.data.ciiV45.candidateBadge?.code).toBe('L6');
    expect(out.data.ciiV45.badgeStatus).toBe('L6_PENDING_QUALIFICATION');
    expect(out.data.ciiV45Lock.locked).toBe(true);
    expect(out.data.ciiV45Lock.finalBadge).toBeNull();
    expect(out.data.ciiV45Lock.badgeStatus).toBe('L6_PENDING_QUALIFICATION');
    expect(out.data.ciiV45Lock.rubricVersion).toBe(CII_V45_RUBRIC_VERSION);
    expect(out.data.ciiV45Lock.adminApprovedScore).toBe(97.8);
  });

  it('awards L6 at approval when the numeric minima hold and the sourced confirmations are given', async () => {
    const report = await approvableReport(4, 3);
    const { service } = makeService(report);
    const out = (await service.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      qualified,
    )) as unknown as Approval;
    expect(out.data.ciiV45Lock.finalBadge?.code).toBe('L6');
    expect(out.data.ciiV45Lock.badgeStatus).toBe('AWARDED');
    expect(out.data.ciiV45Lock.l6Qualification).toEqual(
      expect.objectContaining({
        sourceRef: 'section10.follow_up',
        confirmedByAdminId: 'admin-1',
      }),
    );
  });

  it('has no L4/L5 gate: a CII of 82 is L5 even when Measured Change is only Basic', async () => {
    const report = await approvableReport(3, 4);
    // 4B at Basic, everything else Strong: CII 82.0
    const sections = (report.ciiV45 as { sectionScores: Row[] }).sectionScores;
    expect(sections.length).toBe(10);
    const fp = (report.ciiV45 as { inputFingerprint: string }).inputFingerprint;
    report.ciiV45 = {
      ...computeCiiV45Result(
        r3Payload(fp, 3, 4, {
          sectionScores: r3Payload(fp, 3, 4).sectionScores.map((s) =>
            s.dimension === '4B'
              ? {
                  ...s,
                  criterionScores: s.criterionScores.map((c) => ({
                    ...c,
                    anchor: 1 as const,
                    qualityAnchor: 1 as const,
                  })),
                }
              : s,
          ),
        }),
      ),
    };
    const { service } = makeService(report);
    const out = (await service.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
    )) as unknown as Approval;
    expect(out.data.ciiV45.finalCII).toBe(82);
    expect(out.data.ciiV45Lock.finalBadge?.code).toBe('L5');
    expect(out.data.ciiV45Lock.badgeStatus).toBe('AWARDED');
  });

  it('keeps the AI baseline on the lock when criterion marks were reviewed, and hashes the moderation in', async () => {
    const plain = await approvableReport(2, 2);
    const fp = (plain.ciiV45 as { inputFingerprint: string }).inputFingerprint;
    const moderated: Row = {
      ...plain,
      ciiV45: computeCiiV45Result(
        r3Payload(fp, 2, 2, {
          adminModeration: {
            revision: 1,
            edits: {
              '1.hoursRequirement': {
                points: 4,
                reason: 'Register page 2 confirms the hours.',
                actorId: 'admin-1',
                at: '2026-11-10T00:00:00.000Z',
              },
            },
            log: [],
          },
        }),
      ),
    };
    const a = (await makeService(plain).service.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
    )) as unknown as Approval;
    const b = (await makeService(moderated).service.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
    )) as unknown as Approval;
    expect(a.data.ciiV45Lock.scoreWasModerated).toBe(false);
    expect(b.data.ciiV45Lock.scoreWasModerated).toBe(true);
    expect(b.data.ciiV45Lock.adminApprovedScore).toBe(71.2);
    expect(b.data.ciiV45Lock.aiRecommendedScore).toBe(70);
    expect(a.data.ciiV45Lock.hash).not.toBe(b.data.ciiV45Lock.hash);
  });

  it('leaves a legacy snapshot without sections on the original gate rule', async () => {
    const report: Row = {
      id: 'report-1',
      status: 'submitted',
      section1: { team_lead: { hours: 20 } },
      ciiV45Lock: null,
      ciiV45: {
        scoreStatus: 'FINAL',
        diagnosticCII: 92,
        qualityGates: { L4: true, L5: true, L6: false },
      },
    };
    (report.ciiV45 as Row).inputFingerprint = await fingerprintFor(report);
    const out = (await makeService(report).service.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
    )) as unknown as Approval;
    // gate-capped to L5 as before; no R3 status is invented
    expect(out.data.ciiV45Lock.finalBadge?.code).toBe('L5');
    expect(out.data.ciiV45Lock.badgeStatus).toBeUndefined();
  });
});

describe('FacultyReportsService — R3 criterion mark review', () => {
  it('saves a reviewed criterion mark, keeps the AI baseline, bumps the revision and logs it', async () => {
    const report = await approvableReport(2, 2);
    const { service, qb } = makeService(report);
    const out = (await service.moderateCiiV45ForAdmin('report-1', 'admin-1', {
      dimension: '1',
      criterionEdits: { hoursRequirement: 4 },
      reason: 'Register page 2 confirms the hours.',
      sourceRef: 'section1.attendance',
      expectedRevision: 0,
    })) as unknown as {
      data: {
        moderated: boolean;
        aiProposalScore: number;
        finalCII: number;
        adminModeration: { revision: number; log: Row[] };
      };
    };
    expect(out.data.moderated).toBe(true);
    expect(out.data.aiProposalScore).toBe(59.5);
    expect(out.data.finalCII).toBe(71.2);
    expect(out.data.adminModeration.revision).toBe(1);
    expect(out.data.adminModeration.log).toEqual([
      expect.objectContaining({
        dimension: '1',
        criterion: 'hoursRequirement',
        from: 2.8,
        to: 4,
        aiScore: 2.8,
        actorId: 'admin-1',
      }),
    ]);
    // written under a "not locked" and "same revision" guard
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('IS DISTINCT FROM'),
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('adminModeration'),
      { rev: 0 },
    );
  });

  it('restores the AI mark with null and treats a mark equal to the AI mark as a restore', async () => {
    const plain = await approvableReport(2, 2);
    const fp = (plain.ciiV45 as { inputFingerprint: string }).inputFingerprint;
    const edited: Row = {
      ...plain,
      ciiV45: computeCiiV45Result(
        r3Payload(fp, 2, 2, {
          adminModeration: {
            revision: 3,
            edits: {
              '1.hoursRequirement': {
                points: 4,
                reason: 'Earlier reason for the mark.',
                actorId: 'admin-1',
                at: '2026-11-10T00:00:00.000Z',
              },
            },
            log: [],
          },
        }),
      ),
    };
    const { service } = makeService(edited);
    const out = (await service.moderateCiiV45ForAdmin('report-1', 'admin-2', {
      dimension: '1',
      criterionEdits: { hoursRequirement: 2.8 },
      reason: 'Restoring the AI mark after review.',
      expectedRevision: 3,
    })) as unknown as {
      data: { moderated: boolean; finalCII: number };
    };
    expect(out.data.moderated).toBe(false);
    expect(out.data.finalCII).toBe(70);
  });

  it('refuses a locked score, an earlier rubric, Dimension 7, an unknown criterion and a short reason', async () => {
    const locked = await approvableReport(2, 2);
    locked.ciiV45Lock = { locked: true, hash: 'h' };
    await expect(
      makeService(locked).service.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '1',
        criterionEdits: { hoursRequirement: 3 },
        reason: 'A long enough reason.',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const r2: Row = {
      id: 'report-1',
      status: 'submitted',
      ciiV45Lock: null,
      ciiV45: {
        sectionScores: [
          {
            dimension: '1',
            criterionScores: [
              'role',
              'quality',
              'hoursCompletion',
              'continuity',
            ].map((criterion) => ({ criterion })),
          },
        ],
      },
    };
    await expect(
      makeService(r2).service.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '1',
        criterionEdits: { role: 1 },
        reason: 'A long enough reason.',
      }),
    ).rejects.toThrow(/earlier rubric/);

    const ok = await approvableReport(2, 2);
    const s = makeService(ok).service;
    await expect(
      s.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '7',
        criterionEdits: { participation: 1 },
        reason: 'A long enough reason.',
      }),
    ).rejects.toThrow(/Dimension 7/);
    await expect(
      s.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '1',
        criterionEdits: { nope: 1 },
        reason: 'A long enough reason.',
      }),
    ).rejects.toThrow(/Unknown criterion/);
    await expect(
      s.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '1',
        criterionEdits: { hoursRequirement: 3 },
        reason: 'short',
      }),
    ).rejects.toThrow(/reason of at least 8/);
    await expect(
      s.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '1',
        criterionEdits: { hoursRequirement: 4.5 },
        reason: 'A long enough reason.',
      }),
    ).rejects.toThrow(/between 0 and 4/);
  });

  it('rejects a stale revision and a concurrent write, and writes nothing when no mark changed', async () => {
    const report = await approvableReport(2, 2);
    await expect(
      makeService(report).service.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '1',
        criterionEdits: { hoursRequirement: 3 },
        reason: 'A long enough reason.',
        expectedRevision: 5,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      makeService(report, 0).service.moderateCiiV45ForAdmin('report-1', 'a', {
        dimension: '1',
        criterionEdits: { hoursRequirement: 3 },
        reason: 'A long enough reason.',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const { service, qb } = makeService(report);
    const out = (await service.moderateCiiV45ForAdmin('report-1', 'a', {
      dimension: '1',
      criterionEdits: { hoursRequirement: 2.8 },
      reason: '',
    })) as unknown as { unchanged?: boolean };
    expect(out.unchanged).toBe(true);
    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('lets Admin resolve a criterion the AI left pending', async () => {
    const base = await approvableReport(2, 2);
    const fp = (base.ciiV45 as { inputFingerprint: string }).inputFingerprint;
    const payload = r3Payload(fp, 2, 2);
    payload.sectionScores = payload.sectionScores.map((s) =>
      s.dimension === '9'
        ? {
            ...s,
            criterionScores: s.criterionScores.map((c) =>
              c.criterion === 'followUpRetention'
                ? { ...c, anchor: 'P' as const, qualityAnchor: 'P' as const }
                : c,
            ),
          }
        : s,
    );
    const pending: Row = {
      ...base,
      ciiV45: computeCiiV45Result(payload),
    };
    expect((pending.ciiV45 as { aiReportScore: unknown }).aiReportScore).toBe(
      null,
    );
    const out = (await makeService(pending).service.moderateCiiV45ForAdmin(
      'report-1',
      'admin-1',
      {
        dimension: '9',
        criterionEdits: { followUpRetention: 2 },
        reason: 'The follow-up register shows retained use.',
      },
    )) as unknown as { data: { aiReportScore: number | null } };
    expect(out.data.aiReportScore).not.toBeNull();
  });
});

describe('FacultyReportsService — R3 L6 qualification after approval', () => {
  async function pendingLocked(): Promise<Row> {
    const report = await approvableReport(4, 3);
    const approved = (await makeService(report).service.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
    )) as unknown as Approval;
    return {
      ...report,
      ciiV45: approved.data.ciiV45,
      ciiV45Lock: approved.data.ciiV45Lock,
    };
  }

  it('awards L6 without touching the CII or the approval hash', async () => {
    const report = await pendingLocked();
    const { service, qb } = makeService(report);
    const out = (await service.qualifyCiiV45L6ForAdmin(
      'report-1',
      'admin-1',
      qualified,
    )) as unknown as { data: { badge: { code: string } } };
    expect(out.data.badge.code).toBe('L6');
    const written = qb.set.mock.calls[0][0] as {
      ciiV45: { finalCII: number; badgeStatus: string };
      ciiV45Lock: { hash: string; badgeStatus: string };
    };
    expect(written.ciiV45.finalCII).toBe(97.8);
    expect(written.ciiV45.badgeStatus).toBe('AWARDED');
    expect(written.ciiV45Lock.badgeStatus).toBe('AWARDED');
    expect(written.ciiV45Lock.hash).toBe((report.ciiV45Lock as Row).hash);
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('L6_PENDING_QUALIFICATION'),
    );
  });

  it('refuses an unmet qualification, an unapproved score and a lock that is not pending', async () => {
    const report = await pendingLocked();
    await expect(
      makeService(report).service.qualifyCiiV45L6ForAdmin('report-1', 'a', {
        ...qualified,
        externalCorroboration: false,
      }),
    ).rejects.toThrow(/Corroboration outside the student team/);
    await expect(
      makeService(await approvableReport(4, 3)).service.qualifyCiiV45L6ForAdmin(
        'report-1',
        'a',
        qualified,
      ),
    ).rejects.toThrow(/Approve the score first/);
    const awarded = {
      ...report,
      ciiV45Lock: {
        ...(report.ciiV45Lock as Row),
        badgeStatus: 'AWARDED',
      },
    };
    await expect(
      makeService(awarded).service.qualifyCiiV45L6ForAdmin(
        'report-1',
        'a',
        qualified,
      ),
    ).rejects.toThrow(/no pending L6/);
    await expect(
      makeService(report, 0).service.qualifyCiiV45L6ForAdmin(
        'report-1',
        'a',
        qualified,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('R3 supplemental evidence', () => {
  const url =
    'https://bucket.s3.eu.amazonaws.com/admin-report-supplemental/report-1/a.pdf';
  const base = (): Row => ({
    id: 'report-1',
    status: 'submitted',
    ciiV45Lock: null,
    ciiV45: { scoreStatus: 'FINAL' },
    adminSupplementalEvidence: [],
  });

  it("attaches a labelled file only from this report's supplemental upload folder, and flags the stale analysis", async () => {
    const { service, qb } = makeService(base());
    const out = (await service.addSupplementalEvidenceForAdmin(
      'report-1',
      'admin-1',
      { url, name: 'Partner letter.pdf', label: 'Partner confirmation' },
    )) as unknown as {
      data: { visibility: string; section: string; addedByAdminId: string };
      requiresReanalysis: boolean;
    };
    expect(out.data.visibility).toBe('restricted');
    expect(out.data.section).toBe('general');
    expect(out.data.addedByAdminId).toBe('admin-1');
    expect(out.requiresReanalysis).toBe(true);
    const saved = (
      qb.set.mock.calls[0][0] as { adminSupplementalEvidence: Row[] }
    ).adminSupplementalEvidence;
    expect(saved).toHaveLength(1);
    await expect(
      service.addSupplementalEvidenceForAdmin('report-1', 'admin-1', {
        url: 'https://bucket.s3.eu.amazonaws.com/student-reports/x.pdf',
        name: 'x.pdf',
        label: 'Other report file',
      }),
    ).rejects.toThrow(/supplemental-evidence upload/);
  });

  it('refuses a duplicate, a 51st file and any change while the score is locked', async () => {
    const withOne = {
      ...base(),
      adminSupplementalEvidence: [
        { id: 'e1', url, name: 'a.pdf', label: 'Letter', addedAt: 't' },
      ],
    };
    await expect(
      makeService(withOne).service.addSupplementalEvidenceForAdmin(
        'report-1',
        'a',
        {
          url,
          name: 'a.pdf',
          label: 'Letter again',
        },
      ),
    ).rejects.toThrow(/already attached/);
    const full = {
      ...base(),
      adminSupplementalEvidence: Array.from({ length: 50 }, (_, i) => ({
        id: `e${i}`,
        url: `${url}?n=${i}`,
        name: 'a.pdf',
        label: 'Letter',
        addedAt: 't',
      })),
    };
    await expect(
      makeService(full).service.addSupplementalEvidenceForAdmin(
        'report-1',
        'a',
        {
          url: url.replace('a.pdf', 'z.pdf'),
          name: 'z.pdf',
          label: 'One too many',
        },
      ),
    ).rejects.toThrow(/at most 50/);
    const locked = { ...base(), ciiV45Lock: { locked: true } };
    await expect(
      makeService(locked).service.addSupplementalEvidenceForAdmin(
        'report-1',
        'a',
        {
          url,
          name: 'a.pdf',
          label: 'Letter',
        },
      ),
    ).rejects.toThrow(/locked/);
    await expect(
      makeService(locked).service.presignSupplementalEvidenceForAdmin(
        'report-1',
        {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        },
      ),
    ).rejects.toThrow(/locked/);
  });

  it('soft-removes a file (kept with who removed it) and lists only active ones', async () => {
    const withOne = {
      ...base(),
      adminSupplementalEvidence: [
        { id: 'e1', url, name: 'a.pdf', label: 'Letter', addedAt: 't' },
      ],
    };
    const { service, qb } = makeService(withOne);
    await service.removeSupplementalEvidenceForAdmin(
      'report-1',
      'admin-2',
      'e1',
    );
    const saved = (
      qb.set.mock.calls[0][0] as { adminSupplementalEvidence: Row[] }
    ).adminSupplementalEvidence;
    expect(saved[0]).toEqual(
      expect.objectContaining({ id: 'e1', removedByAdminId: 'admin-2' }),
    );
    expect(saved[0].removedAt).toEqual(expect.any(String));
    await expect(
      service.removeSupplementalEvidenceForAdmin('report-1', 'admin-2', 'nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const listed = (await makeService({
      ...withOne,
      adminSupplementalEvidence: [
        ...withOne.adminSupplementalEvidence,
        {
          id: 'e2',
          url: `${url}?2`,
          name: 'b.pdf',
          label: 'Gone',
          removedAt: 't',
        },
      ],
    }).service.listSupplementalEvidenceForAdmin('report-1')) as unknown as {
      data: Row[];
    };
    expect(listed.data.map((i) => i.id)).toEqual(['e1']);
  });

  it('joins the evidence inventory and the fingerprint without shifting the student file ids', async () => {
    const student: Row = {
      id: 'report-1',
      status: 'submitted',
      section1: { team_lead: { hours: 20 } },
      section8: { evidence_files: ['https://x.example/student.pdf'] },
    };
    const without = await buildCielPkAiEvaluationPayloadV45(
      student as unknown as StudentReport,
      {
        getObjectBufferByPublicUrl: jest.fn().mockResolvedValue(null),
      } as unknown as EvidenceByteSource,
    );
    const withSupp = await buildCielPkAiEvaluationPayloadV45(
      {
        ...student,
        adminSupplementalEvidence: [
          {
            id: 'e1',
            url,
            name: 'a.pdf',
            label: 'Partner letter',
            addedByAdminId: 'admin-1',
            addedAt: 't',
          },
          {
            id: 'e2',
            url: `${url}?2`,
            name: 'b.pdf',
            label: 'Removed',
            removedAt: 't',
          },
        ],
      } as unknown as StudentReport,
      {
        getObjectBufferByPublicUrl: jest.fn().mockResolvedValue(null),
      } as unknown as EvidenceByteSource,
    );
    const ids = withSupp.uploaded_evidence_files.map((f) => f.file_id);
    expect(ids).toEqual(['EV-001', 'ADM-001']);
    expect(withSupp.uploaded_evidence_files[1]).toEqual(
      expect.objectContaining({
        supplemental: true,
        label: 'Partner letter',
        ai_accessible: false,
      }),
    );
    // adding a file makes a stored analysis stale; with none the fingerprint is unchanged
    expect(withSupp.input_fingerprint).not.toBe(without.input_fingerprint);
    const none = await buildCielPkAiEvaluationPayloadV45(
      {
        ...student,
        adminSupplementalEvidence: null,
      } as unknown as StudentReport,
      {
        getObjectBufferByPublicUrl: jest.fn().mockResolvedValue(null),
      } as unknown as EvidenceByteSource,
    );
    expect(none.input_fingerprint).toBe(without.input_fingerprint);
  });
});

describe('R3 pending-L6 display and redaction', () => {
  const cii = {
    finalBadge: null,
    recommendedBadge: { name: 'Transformative Impact Contributor', level: 6 },
    diagnosticBadge: { name: 'Transformative Impact Contributor', level: 6 },
    candidateBadge: {
      code: 'L6',
      name: 'Transformative Impact Contributor',
      level: 6,
      numericLevel: 6,
      gateCapped: false,
    },
    badgeStatus: 'L6_PENDING_QUALIFICATION',
    sectionScores: [
      {
        dimension: '4B',
        name: 'Measured Change',
        maximumPoints: 15,
        score: 14,
        criterionScores: [{ reasoningSummary: 'secret' }],
      },
    ],
    l6Assessment: {
      status: 'PENDING_QUALIFICATION',
      reasons: ['Measured Change below 12/15'],
    },
    adminModeration: {
      revision: 2,
      edits: {},
      log: [{ reason: 'private note' }],
    },
  };

  it('does not fall back to a recommended L6 for a locked pending candidate', () => {
    const lock = { locked: true, badgeStatus: 'L6_PENDING_QUALIFICATION' };
    expect(isCiiL6PendingLock(lock)).toBe(true);
    expect(pickCiiV45DisplayBadge(cii, lock)).toBeNull();
    // an unlocked preview and an older lock keep the existing behaviour
    expect(pickCiiV45DisplayBadge(cii, { locked: false })?.level).toBe(6);
    expect(pickCiiV45DisplayBadge(cii, { locked: true })?.level).toBe(6);
  });

  it('shows the award status to non-admins, never the reasons, moderation or criterion detail', () => {
    const { ciiV45, ciiV45Lock } = redactCiiV45Fields(
      cii as unknown as Record<string, unknown>,
      {
        locked: true,
        hash: 'h',
        lockedAt: 't',
        badgeStatus: 'L6_PENDING_QUALIFICATION',
      },
    );
    expect(ciiV45?.badgeStatus).toBe('L6_PENDING_QUALIFICATION');
    expect(ciiV45?.candidateBadge?.code).toBe('L6');
    expect(ciiV45Lock?.badgeStatus).toBe('L6_PENDING_QUALIFICATION');
    const text = JSON.stringify({ ciiV45, ciiV45Lock });
    expect(text).not.toContain('Measured Change below');
    expect(text).not.toContain('private note');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('adminModeration');
    expect(text).not.toContain('l6Assessment');
  });
});

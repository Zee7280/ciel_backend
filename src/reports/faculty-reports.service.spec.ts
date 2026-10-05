import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FacultyReportsService, mapFacultyListCii, mapFacultyListPackage } from './faculty-reports.service';
import { CII_V45_DIMENSIONS, CiiV45EvaluatorPayload } from './cii-v4-5.constants';
import { buildCielPkAiEvaluationPayloadV45 } from './build-ciel-pk-ai-evaluation-payload.util';

function makeService(
  report: Record<string, unknown> | null,
  aiServiceOverrides: Record<string, unknown> = {},
  updateAffected = 1,
) {
  const qb: any = {
    leftJoin: jest.fn(() => qb),
    leftJoinAndSelect: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    orWhere: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    getOne: jest.fn(async () => report),
    update: jest.fn(() => qb),
    set: jest.fn(() => qb),
    execute: jest.fn(async () => ({ affected: updateAffected })),
  };
  const studentReportsRepository = {
    createQueryBuilder: jest.fn(() => qb),
    save: jest.fn(async (row: Record<string, unknown>) => row),
    update: jest.fn(async () => ({ affected: 1 })),
    findOne: jest.fn(async () => report),
  };
  const facultyService = {
    getScopedOpportunityIds: jest.fn().mockResolvedValue([]),
  };
  const aiService = {
    summarize: jest.fn(),
    ...aiServiceOverrides,
  };
  const facultyUniversityScopeService = {
    normalizeOrgName: (name: string) => (name || '').trim().toLowerCase(),
    studentProfileMatchesOrganization: jest.fn().mockReturnValue(true),
  };
  const mailService = {
    sendStudentImpactReportFacultyDecision: jest.fn().mockResolvedValue(undefined),
  };
  const notificationsService = {
    createNotification: jest.fn().mockResolvedValue(undefined),
  };
  const attendanceLogsRepository = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (rows: unknown) => rows),
  };
  const participationRepository = {
    find: jest.fn().mockResolvedValue([]),
  };
  const opportunitiesRepository = {
    find: jest.fn().mockResolvedValue([]),
  };
  const s3Service = {
    // Evidence byte-fetching is never exercised here — every fixture either has no evidence
    // URLs, or deliberately pins a pre-computed fingerprint (see `fingerprintForReport` below),
    // which is stable as long as this always resolves the same way (a "file not fetchable" miss).
    getObjectBufferByPublicUrl: jest.fn().mockResolvedValue(null),
  };
  const service = new FacultyReportsService(
    studentReportsRepository as any,
    {} as any,
    facultyService as any,
    aiService as any,
    facultyUniversityScopeService as any,
    attendanceLogsRepository as any,
    mailService as any,
    notificationsService as any,
    participationRepository as any,
    opportunitiesRepository as any,
    s3Service as any,
  );
  return {
    service,
    studentReportsRepository,
    aiService,
    qb,
    facultyUniversityScopeService,
    attendanceLogsRepository,
    participationRepository,
    opportunitiesRepository,
    facultyService,
    s3Service,
  };
}

/** Computes the SAME live input fingerprint `approveCiiV45ForAdmin` recomputes against the
 * report's current data, so fixtures that need the fresh-integrity check to PASS can embed a
 * matching `ciiV45.inputFingerprint` up front. */
async function fingerprintForReport(report: Record<string, unknown>): Promise<string> {
  const s3 = { getObjectBufferByPublicUrl: jest.fn().mockResolvedValue(null) };
  const payload = await buildCielPkAiEvaluationPayloadV45(report as any, s3 as any);
  return payload.input_fingerprint;
}

/** Every one of the 10 fixed CII v4.5 dimensions, every criterion anchored at 4 ("Exceptional")
 * with full narrative/evidence so `computeCiiV45Result` accepts the payload and scores it 100. */
function fullMarksSectionScores(): CiiV45EvaluatorPayload['sectionScores'] {
  return CII_V45_DIMENSIONS.map((dim) => ({
    dimension: dim.id,
    criterionScores: dim.criteria.map((c) => ({
      criterion: c.key,
      anchor: 4 as const,
      qualityAnchor: 4 as const,
      verificationStatus: 'VERIFIED' as const,
      sourceRefs: ['Report'],
      evidenceIds: ['E1'],
      reasoningSummary: 'Fully verified against submitted evidence.',
    })),
  }));
}

const CII_V45_AI_RESPONSE: CiiV45EvaluatorPayload = {
  frameworkVersion: '4.5',
  reportId: 'report-1',
  inputFingerprint: 'ai-fp-1',
  inputCompleteness: {
    gaps: [],
    individualHours: [{ studentId: 'stu-1', hours: 20, requiredHours: 16, verified: true, recordComplete: true }],
    mandatoryFieldsComplete: true,
  },
  claimInventory: [{ claimId: 'C1', text: 'claim', material: true, evidenceIds: ['E1'], supportStatus: 'SUPPORTED' }],
  evidenceAudit: [
    {
      evidenceId: 'E1',
      fileName: 'evidence.jpg',
      fileType: 'image/jpeg',
      privacy: 'PUBLIC',
      material: true,
      processingStatus: 'INSPECTED',
      claimIds: ['C1'],
      supportStatus: 'SUPPORTED',
    },
  ],
  sectionScores: fullMarksSectionScores(),
  deductionLedger: [],
  extraMileUplift: { assessmentStatus: 'ASSESSED', items: [] },
  integrityPenalty: { points: 0, issues: [] },
  exceptionalFeature: { verified: true, explanation: 'Clear community-driven innovation.', evidenceIds: ['E1'] },
  adminReviewReasons: [],
  strengths: ['Strong partner collaboration'],
  developmentPriorities: [],
  analysisSummary: 'Full-marks evaluation.',
  evidenceSummary: 'All claims verified.',
  studentFeedback: 'Excellent work.',
};

describe('FacultyReportsService — runCiiV45AnalysisForAdmin', () => {
  // NOTE: the old faculty-facing non-admin `runCiiV2Analysis` had no v4.5 replacement — faculty
  // report review is read-only now; `runCiiV45AnalysisForAdmin` is Admin-only and (by design)
  // always rescoring/clearing the lock, so the old "non-admin refuses to re-analyse a locked
  // report" test has no equivalent behaviour left to assert and was removed (see handback notes).

  it('computes and persists a full-marks evaluation as a perfect 100, via a targeted (non-clobbering) update', async () => {
    const { service, studentReportsRepository, qb } = makeService(
      { id: 'report-1' },
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );

    const result = await service.runCiiV45AnalysisForAdmin('report-1');

    expect(result.success).toBe(true);
    expect((result.data as any).finalCII).toBe(100);
    expect((result.data as any).scoreStatus).toBe('FINAL');
    expect((result.data as any).diagnosticBadge.level).toBe(6);
    expect(qb.execute).toHaveBeenCalled();
    // Must never full-entity save() a stale `report` object — that would clobber a
    // concurrently-set ciiV45Lock (see the dedicated race-condition test below).
    expect(studentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('refuses when the update affects 0 rows (defensive guard against a concurrent write)', async () => {
    const { service } = makeService(
      { id: 'report-1' },
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
      0,
    );

    await expect(service.runCiiV45AnalysisForAdmin('report-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces a malformed AI response (wrong criterion count) as a retryable 400, not an unhandled 500', async () => {
    // Reproduces the exact production failure: AI returns valid JSON, but dimension "1" has only
    // 3 of its 4 fixed criteria — `computeCiiV45Result` throws `CiiV45ValidationError`, which must
    // be caught and turned into a BadRequestException, never left to fall through as a bare 500.
    const malformed: CiiV45EvaluatorPayload = {
      ...CII_V45_AI_RESPONSE,
      sectionScores: CII_V45_AI_RESPONSE.sectionScores.map((s) =>
        s.dimension === '1' ? { ...s, criterionScores: s.criterionScores.slice(0, 3) } : s,
      ),
    };
    const { service } = makeService(
      { id: 'report-1' },
      { summarize: jest.fn().mockResolvedValue({ ciiV45: malformed }) },
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(service.runCiiV45AnalysisForAdmin('report-1')).rejects.toMatchObject({
      response: { statusCode: 400 },
      message: expect.stringContaining('Invalid criterion count 1'),
    });
    // The 400 message alone doesn't carry the AI's raw (malformed) payload — that must be
    // logged server-side, otherwise a recurring failure on the same report is undebuggable.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('report-1'),
      expect.stringContaining('"dimension":"1"'),
    );
    consoleError.mockRestore();
  });

  it('self-heals within a single run: a malformed first attempt falls back to a no-images retry that succeeds', async () => {
    // Production theory: attending to multimodal evidence while also holding the fixed
    // criterion-count schema in mind is where the reasoning model is most likely to drift.
    // `evaluateCiiV45` gets one bounded fallback attempt with images dropped before giving up.
    const malformed: CiiV45EvaluatorPayload = {
      ...CII_V45_AI_RESPONSE,
      sectionScores: CII_V45_AI_RESPONSE.sectionScores.map((s) =>
        s.dimension === '1' ? { ...s, criterionScores: s.criterionScores.slice(0, 3) } : s,
      ),
    };
    const summarize = jest
      .fn()
      .mockResolvedValueOnce({ ciiV45: malformed })
      .mockResolvedValueOnce({ ciiV45: CII_V45_AI_RESPONSE });
    const { service } = makeService({ id: 'report-2' }, { summarize });

    await expect(service.runCiiV45AnalysisForAdmin('report-2')).resolves.toMatchObject({ success: true });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[0][2]).toMatchObject({ skipEvidenceImages: false });
    expect(summarize.mock.calls[1][2]).toMatchObject({ skipEvidenceImages: true });
  });

  it('clears the in-flight guard after BOTH attempts fail, so the next run is not stuck', async () => {
    const malformed: CiiV45EvaluatorPayload = {
      ...CII_V45_AI_RESPONSE,
      sectionScores: CII_V45_AI_RESPONSE.sectionScores.map((s) =>
        s.dimension === '1' ? { ...s, criterionScores: s.criterionScores.slice(0, 3) } : s,
      ),
    };
    const { service } = makeService(
      { id: 'report-3' },
      {
        summarize: jest
          .fn()
          .mockResolvedValueOnce({ ciiV45: malformed })
          .mockResolvedValueOnce({ ciiV45: malformed })
          .mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }),
      },
    );

    await expect(service.runCiiV45AnalysisForAdmin('report-3')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.runCiiV45AnalysisForAdmin('report-3')).resolves.toMatchObject({ success: true });
  });

  it('re-analyses a locked report and clears the lock in the same write', async () => {
    const { service, qb } = makeService(
      {
        id: 'report-1',
        ciiV45Lock: {
          locked: true,
          hash: 'x',
          lockedAt: 'now',
          lockedByAdminId: 'admin-1',
          inputFingerprint: 'fp',
          scoreStatusAtLock: 'FINAL',
        },
      },
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );

    await expect(service.runCiiV45AnalysisForAdmin('report-1')).resolves.toMatchObject({ success: true });

    const payload = qb.set.mock.calls[0][0] as { ciiV45?: unknown; ciiV45Lock?: unknown };
    expect(payload.ciiV45).toBeTruthy();
    expect(typeof payload.ciiV45Lock).toBe('function');
    expect(qb.andWhere).not.toHaveBeenCalled();
  });
});

describe('FacultyReportsService — approveCiiV45ForAdmin', () => {
  it('refuses to approve before an analysis has been run', async () => {
    const { service } = makeService({ id: 'report-1', ciiV45: null });

    await expect(service.approveCiiV45ForAdmin('report-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses to re-approve an already-locked report', async () => {
    const { service } = makeService({
      id: 'report-1',
      ciiV45: { scoreStatus: 'FINAL' },
      ciiV45Lock: {
        locked: true,
        hash: 'x',
        lockedAt: 'now',
        lockedByAdminId: 'admin-1',
        inputFingerprint: 'fp',
        scoreStatusAtLock: 'FINAL',
      },
    });

    await expect(service.approveCiiV45ForAdmin('report-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('lets admin publish when analysis flagged RESUBMISSION_REQUIRED', async () => {
    const report: any = {
      id: 'report-1',
      section1: { team_lead: { hours: 20 } },
      ciiV45: {
        scoreStatus: 'RESUBMISSION_REQUIRED',
        diagnosticCII: 60.3,
        knownBasePoints: 60.3,
        qualityGates: { L4: false, L5: false, L6: false },
        adminReviewReasons: [],
      },
      ciiV45Lock: null,
    };
    report.ciiV45.inputFingerprint = await fingerprintForReport(report);
    const { service } = makeService(report);

    const result = await service.approveCiiV45ForAdmin('report-1', 'admin-1');
    expect((result.data as any).ciiV45Lock.locked).toBe(true);
    expect((result.data as any).ciiV45.finalCII).toBe(60.3);
    expect((result.data as any).ciiV45Lock.aiRecommendedScore).toBe(60.3);
  });

  it('lets admin publish when analysis is still ADMIN_REVIEW_REQUIRED', async () => {
    const report: any = {
      id: 'report-1',
      section1: { team_lead: { hours: 20 } },
      ciiV45: {
        scoreStatus: 'ADMIN_REVIEW_REQUIRED',
        diagnosticCII: 70,
        qualityGates: { L4: false, L5: false, L6: false },
        adminReviewReasons: ['Evidence pending inspection'],
      },
      ciiV45Lock: null,
    };
    report.ciiV45.inputFingerprint = await fingerprintForReport(report);
    const { service } = makeService(report);

    const result = await service.approveCiiV45ForAdmin('report-1', 'admin-1');
    expect((result.data as any).ciiV45Lock.locked).toBe(true);
    expect((result.data as any).ciiV45.finalCII).toBe(70);
  });

  it('refuses to publish when the report changed since the analysis ran (fingerprint mismatch)', async () => {
    const { service } = makeService({
      id: 'report-1',
      ciiV45: {
        scoreStatus: 'FINAL',
        diagnosticCII: 80,
        qualityGates: { L4: true, L5: false, L6: false },
        adminReviewReasons: [],
        inputFingerprint: 'stale-fingerprint-from-before-the-edit',
      },
      ciiV45Lock: null,
    });

    await expect(service.approveCiiV45ForAdmin('report-1', 'admin-1')).rejects.toThrow(
      /changed since the analysis ran/,
    );
  });

  it('refuses when a concurrent request wins the lock first (atomic compare-and-swap affects 0 rows)', async () => {
    const report: any = {
      id: 'report-1',
      section1: { team_lead: { hours: 20 } },
      ciiV45: {
        scoreStatus: 'FINAL',
        diagnosticCII: 80,
        qualityGates: { L4: true, L5: false, L6: false },
        adminReviewReasons: [],
      },
      ciiV45Lock: null,
    };
    report.ciiV45.inputFingerprint = await fingerprintForReport(report);

    const { service } = makeService(report, {}, 0); // simulates another request's UPDATE having already locked the row

    await expect(service.approveCiiV45ForAdmin('report-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('approves the student pending attendance logs when the CII v4.5 score is locked', async () => {
    const report: any = {
      id: 'report-1',
      studentId: 'stu-1',
      opportunityId: 'opp-1',
      section1: { team_lead: { hours: 20 } },
      section8: { evidence_files: ['https://example.com/evidence.jpg'] },
      ciiV45: {
        scoreStatus: 'FINAL',
        diagnosticCII: 80,
        qualityGates: { L4: true, L5: false, L6: false },
        adminReviewReasons: [],
      },
      ciiV45Lock: null,
    };
    report.ciiV45.inputFingerprint = await fingerprintForReport(report);
    const { service, attendanceLogsRepository } = makeService(report);

    const pendingLog = {
      id: 'log-1',
      approvalStatus: 'pending',
      participant: { studentId: 'stu-1', isTeamLead: false },
    };
    attendanceLogsRepository.find.mockResolvedValue([pendingLog]);

    await service.approveCiiV45ForAdmin('report-1', 'admin-1');

    expect(attendanceLogsRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'opp-1' } }),
    );
    expect(attendanceLogsRepository.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'log-1',
          approvalStatus: 'approved',
          entryStatus: 'verified',
        }),
      ]),
    );
  });

  it('locks with a hash that changes when the admin note changes, for otherwise identical input and timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const baseReport = async () => {
        const report: any = {
          id: 'report-1',
          section1: { team_lead: { hours: 20 } },
          section8: { evidence_files: ['https://example.com/evidence.jpg'] },
          ciiV45: {
            scoreStatus: 'FINAL',
            diagnosticCII: 80,
            qualityGates: { L4: true, L5: false, L6: false },
            adminReviewReasons: [],
          },
          ciiV45Lock: null,
        };
        report.ciiV45.inputFingerprint = await fingerprintForReport(report);
        return report;
      };

      const { service: serviceA } = makeService(await baseReport());
      const resultA = await serviceA.approveCiiV45ForAdmin('report-1', 'admin-1', 'Looks good');

      const { service: serviceB } = makeService(await baseReport());
      const resultB = await serviceB.approveCiiV45ForAdmin('report-1', 'admin-1', 'Different note');

      expect((resultA.data as any).ciiV45Lock.hash).not.toBe((resultB.data as any).ciiV45Lock.hash);
      expect((resultA.data as any).ciiV45Lock.locked).toBe(true);
      expect((resultA.data as any).ciiV45.finalCII).toBe(80);
    } finally {
      jest.useRealTimers();
    }
  });

  it('requires a reason when moderating the AI-recommended score, then records the moderated score once given', async () => {
    const report: any = {
      id: 'report-1',
      ciiV45: {
        scoreStatus: 'FINAL',
        diagnosticCII: 80,
        qualityGates: { L4: true, L5: true, L6: false },
        adminReviewReasons: [],
      },
      ciiV45Lock: null,
    };
    report.ciiV45.inputFingerprint = await fingerprintForReport(report);
    const { service } = makeService(report);

    await expect(
      service.approveCiiV45ForAdmin('report-1', 'admin-1', undefined, 75),
    ).rejects.toThrow(/reason is required/i);

    const { service: service2 } = makeService(report);
    const result = await service2.approveCiiV45ForAdmin(
      'report-1',
      'admin-1',
      undefined,
      75,
      'Evidence was weaker than the AI assessed.',
    );
    expect((result.data as any).ciiV45Lock.scoreWasModerated).toBe(true);
    expect((result.data as any).ciiV45Lock.adminApprovedScore).toBe(75);
    expect((result.data as any).ciiV45Lock.aiRecommendedScore).toBe(80);
  });
});

describe('FacultyReportsService — runIndependentAiAnalysis (multi-stakeholder Phase 4)', () => {
  const lockedReport = () => ({
    id: 'report-1',
    student: { id: 'student-1', role: 'student', university: 'Acme University' },
    ciiV45Lock: {
      locked: true,
      hash: 'x',
      lockedAt: 'now',
      lockedByAdminId: 'admin-1',
      inputFingerprint: 'fp',
      scoreStatusAtLock: 'FINAL',
    },
    independentAiAnalyses: null,
  });

  it('refuses to run on a report that is not yet admin-approved', async () => {
    const { service } = makeService(
      { id: 'report-1', student: {}, ciiV45Lock: null },
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );

    await expect(
      service.runIndependentAiAnalysis('report-1', 'faculty-1', 'faculty', 'Teacher', undefined, {
        facultyEmail: 'teacher@uni.edu',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('faculty: refuses when the report is outside their assigned scope', async () => {
    const { service, qb } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );
    qb.getOne = jest.fn(async () => null); // outside this faculty's assignment scope

    await expect(
      service.runIndependentAiAnalysis('report-1', 'faculty-1', 'faculty', 'Teacher', undefined, {
        facultyEmail: 'teacher@uni.edu',
      }),
    ).rejects.toThrow(/not found|not assigned/i);
  });

  it('faculty: runs and appends to independentAiAnalyses without touching ciiV45Lock', async () => {
    const { service, studentReportsRepository } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );

    const result = await service.runIndependentAiAnalysis(
      'report-1',
      'faculty-1',
      'faculty',
      'Teacher',
      'Looks good',
      { facultyEmail: 'teacher@uni.edu' },
    );

    expect(result.success).toBe(true);
    expect((result.data as any).analysis.runByRole).toBe('faculty');
    expect((result.data as any).analysis.score).toBe(100);
    expect(studentReportsRepository.update).toHaveBeenCalledWith(
      'report-1',
      expect.objectContaining({
        independentAiAnalyses: [expect.objectContaining({ runByRole: 'faculty' })],
      }),
    );
  });

  it('university: refuses when the report is not from a student at their university', async () => {
    const { service, facultyUniversityScopeService } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );
    facultyUniversityScopeService.studentProfileMatchesOrganization.mockReturnValue(false);

    await expect(
      service.runIndependentAiAnalysis('report-1', 'uni-user-1', 'university', 'Uni Reviewer', undefined, {
        universityOrganizationName: 'Some Other University',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('university: runs when the report is from a student at their own university', async () => {
    const { service, facultyUniversityScopeService } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );
    facultyUniversityScopeService.studentProfileMatchesOrganization.mockReturnValue(true);

    const result = await service.runIndependentAiAnalysis(
      'report-1',
      'uni-user-1',
      'university',
      'Uni Reviewer',
      undefined,
      { universityOrganizationName: 'Acme University' },
    );

    expect(result.success).toBe(true);
    expect((result.data as any).analysis.runByRole).toBe('university');
  });

  it('ciel_admin: runs unrestricted, no scope required', async () => {
    const { service } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );

    const result = await service.runIndependentAiAnalysis('report-1', 'admin-1', 'ciel_admin', 'CIEL PK');

    expect(result.success).toBe(true);
    expect((result.data as any).analysis.runByRole).toBe('ciel_admin');
  });
});

describe('FacultyReportsService — runIndependentAiAnalysisBatch', () => {
  const lockedReport = () => ({
    id: 'report-1',
    student: { id: 'student-1', role: 'student', university: 'Acme University' },
    ciiV45Lock: {
      locked: true,
      hash: 'x',
      lockedAt: 'now',
      lockedByAdminId: 'admin-1',
      inputFingerprint: 'fp',
      scoreStatusAtLock: 'FINAL',
    },
    independentAiAnalyses: null,
  });

  it('refuses an empty reportIds list', async () => {
    const { service } = makeService(lockedReport());
    await expect(service.runIndependentAiAnalysisBatch([], 'admin-1', 'ciel_admin')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a batch larger than the safety cap', async () => {
    const { service } = makeService(lockedReport());
    const tooMany = Array.from({ length: 101 }, (_, i) => `report-${i}`);
    await expect(
      service.runIndependentAiAnalysisBatch(tooMany, 'admin-1', 'ciel_admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('runs every id and reports success without ever throwing for the caller', async () => {
    const { service } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );

    const result = await service.runIndependentAiAnalysisBatch(
      ['report-1', 'report-1', 'report-1'], // de-duplicated to one
      'admin-1',
      'ciel_admin',
      'CIEL PK',
    );

    expect(result.success).toBe(true);
    expect((result.data as any).total).toBe(1);
    expect((result.data as any).succeeded).toBe(1);
    expect((result.data as any).failed).toBe(0);
    expect((result.data as any).results[0]).toEqual(
      expect.objectContaining({ reportId: 'report-1', success: true, score: 100 }),
    );
  });

  it('reports a per-id failure instead of aborting the whole batch', async () => {
    const { service, studentReportsRepository } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE }) },
    );
    // Second id resolves to nothing (e.g. someone else's report, outside ciel_admin's... in this
    // case simulate "not found" by having findOne return null only for the second lookup).
    let call = 0;
    studentReportsRepository.findOne = jest.fn(async () => {
      call += 1;
      return call === 2 ? null : lockedReport();
    });

    const result = await service.runIndependentAiAnalysisBatch(['report-1', 'report-2'], 'admin-1', 'ciel_admin');

    expect((result.data as any).total).toBe(2);
    expect((result.data as any).succeeded).toBe(1);
    expect((result.data as any).failed).toBe(1);
    expect((result.data as any).results.find((r: any) => r.reportId === 'report-2')).toEqual(
      expect.objectContaining({ success: false }),
    );
  });
});

describe('mapFacultyListCii', () => {
  it('returns empty CII fields when analyser has not run', () => {
    expect(mapFacultyListCii({ ciiV45: null, ciiV45Lock: null })).toEqual({
      cii_analyser_run: false,
      cii_provisional: null,
      cii_locked: false,
      cii_level_name: null,
      cii_numeric_level: null,
    });
  });

  it('maps a provisional (diagnostic) CII without treating it as locked', () => {
    expect(
      mapFacultyListCii({
        ciiV45: {
          diagnosticCII: 54.44,
          diagnosticBadge: {
            code: 'L2',
            name: 'Foundation Stage Contributor',
            level: 2,
            numericLevel: 2,
            gateCapped: false,
          },
        },
        ciiV45Lock: { locked: false },
      }),
    ).toEqual({
      cii_analyser_run: true,
      cii_provisional: 54.4,
      cii_locked: false,
      cii_level_name: 'Foundation Stage Contributor',
      cii_numeric_level: 2,
    });
  });

  it('does not treat the string "false" as a locked CII', () => {
    expect(
      mapFacultyListCii({
        ciiV45: { finalCII: '67' },
        ciiV45Lock: { locked: 'false' },
      }),
    ).toMatchObject({
      cii_analyser_run: true,
      cii_provisional: 67,
      cii_locked: false,
    });
  });

  it('ignores malformed ciiV45 payloads instead of throwing', () => {
    expect(mapFacultyListCii({ ciiV45: 'broken' as unknown, ciiV45Lock: undefined })).toEqual({
      cii_analyser_run: false,
      cii_provisional: null,
      cii_locked: false,
      cii_level_name: null,
      cii_numeric_level: null,
    });
  });

  it('shows knownBasePoints when diagnostic and base are still null (reviewer overall)', () => {
    expect(
      mapFacultyListCii({
        ciiV45: {
          diagnosticCII: null,
          baseCII: null,
          knownBasePoints: 60.3,
          diagnosticBadge: { name: 'Structured', level: 2 },
        },
        ciiV45Lock: null,
      }),
    ).toMatchObject({
      cii_analyser_run: true,
      cii_provisional: 60.3,
      cii_locked: false,
      cii_level_name: 'Structured',
      cii_numeric_level: 2,
    });
  });

  it('shows baseCII when diagnosticCII is still null (reviewer overall)', () => {
    expect(
      mapFacultyListCii({
        ciiV45: {
          diagnosticCII: null,
          baseCII: 70,
          diagnosticBadge: { name: 'Sound', level: 3 },
        },
        ciiV45Lock: null,
      }),
    ).toMatchObject({
      cii_analyser_run: true,
      cii_provisional: 70,
      cii_locked: false,
      cii_level_name: 'Sound',
      cii_numeric_level: 3,
    });
  });

  it('shows the locked published score, not the earlier diagnostic, after moderation', () => {
    expect(
      mapFacultyListCii({
        ciiV45: {
          diagnosticCII: 80,
          finalCII: 75,
          finalBadge: { name: 'Published band', level: 4 },
          diagnosticBadge: { name: 'Provisional band', level: 4 },
        },
        ciiV45Lock: { locked: true, adminApprovedScore: 75 },
      }),
    ).toMatchObject({
      cii_analyser_run: true,
      cii_provisional: 75,
      cii_locked: true,
      cii_level_name: 'Published band',
      cii_numeric_level: 4,
    });
  });
});

describe('mapFacultyListPackage', () => {
  it('fills university, faculty, story, evidence and hours from the same flash helpers as the locked package', () => {
    const report = {
      student: { name: 'Sara Ahmed', university: 'BNU' },
      faculty: { name: 'Dr. Hina Malik' },
      opportunity: { timeline: { expected_hours: 16 }, supervision: { supervisor_name: 'Dr. Hina Malik' } },
      section1: {
        participation_type: 'individual',
        team_lead: { name: 'Sara Ahmed', university: 'BNU', hours: '22' },
        metrics: { total_verified_hours: 0 },
        attendance_logs: [{ hours: 22, evidence_url: 'https://example.com/a.jpg' }],
      },
      section2: { summary_text: 'Workshops for out-of-school youth in Johar Town.' },
      section8: { evidence_files: [] },
    } as any;
    const pkg = mapFacultyListPackage(report, 22);
    expect(pkg.university).toBe('BNU');
    expect(pkg.faculty_name).toBe('Dr. Hina Malik');
    expect(pkg.story).toContain('Johar Town');
    expect(pkg.evidence_count).toBeGreaterThan(0);
    expect(pkg.required_hours).toBe(16);
    expect(pkg.member_hours[0]).toEqual(
      expect.objectContaining({ name: 'Sara Ahmed', hours: 22, required: 16 }),
    );
  });

  it('prefers live project hours over stored blob metrics', () => {
    const report = {
      student: { name: 'Sara Ahmed' },
      section1: {
        participation_type: 'individual',
        metrics: { total_verified_hours: 16 },
      },
      section2: {},
    } as any;
    expect(mapFacultyListPackage(report, 44).member_hours[0].hours).toBe(44);
  });

  it('uses live attendance hours when the stored blob is empty', () => {
    const report = {
      student: { name: 'Sara Ahmed' },
      section1: { participation_type: 'individual', metrics: { total_verified_hours: 0 } },
      section2: {},
    } as any;
    expect(mapFacultyListPackage(report, 18).member_hours[0].hours).toBe(18);
  });
});

describe('FacultyReportsService — draft progress (opens only after submit)', () => {
  it('lists in-progress reports with progress only — no answers, no scores', async () => {
    const draft = {
      id: 'd-1',
      status: 'draft',
      project_id: 'p-1',
      opportunityId: 'p-1',
      updatedAt: new Date('2026-01-01'),
      student: { name: 'Stu', email: 'stu@x.com' },
      opportunity: { title: 'Proj', organization: { name: 'Org' } },
      section1: {},
      section2: { problem_statement: 'PRIVATE ANSWER' },
      ciiV45: { diagnosticCII: 80 },
    };
    const { service, qb } = makeService(null);
    qb.orderBy = jest.fn(() => qb);
    qb.getMany = jest.fn(async () => [draft]);
    const res = await service.listDraftProgress('f-1', 'f@x.com');
    expect(qb.andWhere).toHaveBeenCalledWith("report.status IN ('draft', 'continue')");
    expect(qb.andWhere).toHaveBeenCalledWith('report.reportSubmittedAt IS NULL');
    expect(res.data).toHaveLength(1);
    const row = res.data[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      id: 'd-1',
      student_name: 'Stu',
      project_title: 'Proj',
      draft_locked: true,
      is_submitted: false,
      sections_total: 10,
    });
    expect(typeof row.progress_pct).toBe('number');
    expect(JSON.stringify(row)).not.toContain('PRIVATE ANSWER');
    expect(JSON.stringify(row)).not.toContain('ciiV45');
    expect(row).not.toHaveProperty('student_email');
  });

  it('excludes draft AND continue reports from the submitted-report queries', async () => {
    const { service, qb } = makeService(null);
    qb.orderBy = jest.fn(() => qb);
    qb.getMany = jest.fn(async () => []);
    await service.listAssignedReports('f-1', 'f@x.com');
    expect(qb.andWhere).toHaveBeenCalledWith("report.status NOT IN ('draft', 'continue')");
    qb.andWhere.mockClear();
    await expect(service.findOne('r-1', 'f-1', 'f@x.com')).rejects.toBeInstanceOf(NotFoundException);
    expect(qb.andWhere).toHaveBeenCalledWith("report.status NOT IN ('draft', 'continue')");
  });
});

describe('FacultyReportsService — project tracking (assigned students + live hours)', () => {
  it('returns assigned seats with live hours even before a report is submitted', async () => {
    const { service, facultyService, participationRepository, opportunitiesRepository, attendanceLogsRepository, qb } =
      makeService(null);
    facultyService.getScopedOpportunityIds.mockResolvedValue(['opp-1']);
    opportunitiesRepository.find.mockResolvedValue([
      {
        id: 'opp-1',
        title: 'Community survey',
        status: 'live',
        workflowStage: 'live',
        timeline: { expected_hours: 16 },
        organization: { name: 'NGO' },
        executing_context: {},
      },
    ]);
    participationRepository.find.mockResolvedValue([
      {
        id: 'seat-1',
        projectId: 'opp-1',
        studentId: 'stu-1',
        fullName: 'Ayesha Khan',
        email: 'ayesha@uni.edu',
        student: { id: 'stu-1', name: 'Ayesha Khan', email: 'ayesha@uni.edu' },
        updatedAt: new Date('2026-04-01'),
        createdAt: new Date('2026-03-01'),
      },
    ]);
    attendanceLogsRepository.find.mockResolvedValue([
      {
        participantId: 'seat-1',
        projectId: 'opp-1',
        sessionHours: 4.5,
        approvalStatus: 'pending',
        updatedAt: new Date('2026-04-02'),
        createdAt: new Date('2026-04-02'),
        dateOfEngagement: '2026-04-02',
      },
    ]);
    qb.getMany = jest.fn(async () => []);
    const res = await service.listProjectTracking('f-1', 'f@x.com');
    expect(res.data).toHaveLength(1);
    const row = res.data[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      student_name: 'Ayesha Khan',
      student_email: 'ayesha@uni.edu',
      project_title: 'Community survey',
      project_id: 'opp-1',
      organization_name: 'NGO',
      hours: 4.5,
      required_hours: 16,
      status: 'assigned',
      draft_locked: true,
    });
    expect(JSON.stringify(row)).not.toMatch(/mobile|phone|cnic/i);
  });

  it('omits helper organization copy and prefers a real partner name', async () => {
    const { service, facultyService, participationRepository, opportunitiesRepository, attendanceLogsRepository, qb } =
      makeService(null);
    facultyService.getScopedOpportunityIds.mockResolvedValue(['opp-1']);
    opportunitiesRepository.find.mockResolvedValue([
      {
        id: 'opp-1',
        title: 'Lets Make A Difference',
        status: 'live',
        workflowStage: 'live',
        timeline: { expected_hours: 10 },
        organization: {
          name: 'add only if theres another organization connected (eg.SOS)',
        },
        partner_organization: { organization_name: "SOS Children's Villages" },
        executing_context: {},
      },
    ]);
    participationRepository.find.mockResolvedValue([
      {
        id: 'seat-1',
        projectId: 'opp-1',
        studentId: 'stu-1',
        fullName: 'Spaher Ara',
        email: 'spaher@uni.edu',
        student: { id: 'stu-1', name: 'Spaher Ara', email: 'spaher@uni.edu' },
        updatedAt: new Date('2026-10-03'),
        createdAt: new Date('2026-09-01'),
      },
    ]);
    attendanceLogsRepository.find.mockResolvedValue([]);
    qb.getMany = jest.fn(async () => []);
    const res = await service.listProjectTracking('f-1', 'f@x.com');
    expect(res.data).toHaveLength(1);
    const row = res.data[0] as Record<string, unknown>;
    expect(row.organization_name).toBe("SOS Children's Villages");
    expect(JSON.stringify(row)).not.toMatch(/add only if/i);
  });

  it('returns an empty list when the faculty has no scoped opportunities', async () => {
    const { service, facultyService } = makeService(null);
    facultyService.getScopedOpportunityIds.mockResolvedValue([]);
    const res = await service.listProjectTracking('f-1', 'f@x.com');
    expect(res.data).toEqual([]);
  });
});

describe('FacultyReportsService — AI analysis run safety (lock, history, incomplete runs)', () => {
  it('refuses a second analysis of the same report while the first is still running', async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => (release = r));
    const summarize = jest.fn().mockReturnValue(pending);
    const { service } = makeService({ id: 'report-race' }, { summarize });

    const first = service.runCiiV45AnalysisForAdmin('report-race');
    // let the first call reach the AI await
    await new Promise((r) => setImmediate(r));
    await expect(service.runCiiV45AnalysisForAdmin('report-race')).rejects.toThrow(/already running/);
    expect(summarize).toHaveBeenCalledTimes(1);

    release({ ciiV45: CII_V45_AI_RESPONSE });
    await expect(first).resolves.toMatchObject({ success: true });
    // the lock is released afterwards
    summarize.mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE });
    await expect(service.runCiiV45AnalysisForAdmin('report-race')).resolves.toMatchObject({ success: true });
  });

  it('releases the lock even when the AI call fails', async () => {
    const summarize = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ciiV45: CII_V45_AI_RESPONSE });
    const { service } = makeService({ id: 'report-fail' }, { summarize });
    await expect(service.runCiiV45AnalysisForAdmin('report-fail')).rejects.toThrow('boom');
    await expect(service.runCiiV45AnalysisForAdmin('report-fail')).resolves.toMatchObject({ success: true });
  });

  it('keeps a run history (score, model, inspected evidence) across re-runs and stores the evidence inspection', async () => {
    const previous = {
      diagnosticCII: 41,
      scoreStatus: 'ADMIN_REVIEW_REQUIRED',
      runHistory: [{ score: 41, at: '2026-01-01T00:00:00Z', model: 'm0' }],
    };
    const summarize = jest.fn().mockResolvedValue({
      ciiV45: CII_V45_AI_RESPONSE,
      model: 'gpt-test',
      evidenceInspection: {
        inspected: [{ id: 'E1', name: 'a.jpg' }],
        notInspected: [{ id: 'E2', name: 'r.pdf', reason: 'not an image' }],
      },
    });
    const { service } = makeService({ id: 'report-hist', ciiV45: previous }, { summarize });
    const res: any = await service.runCiiV45AnalysisForAdmin('report-hist');
    expect(res.data.runHistory).toHaveLength(2);
    expect(res.data.runHistory[0]).toMatchObject({ score: 41, model: 'm0' });
    expect(res.data.runHistory[1]).toMatchObject({
      score: 100,
      model: 'gpt-test',
      inspectedImages: 1,
      notInspectedFiles: 1,
    });
    expect(res.data.evidenceInspection.notInspected[0].id).toBe('E2');
  });

  it('an incomplete run with no numeric score still cannot be locked', async () => {
    const { service } = makeService({
      id: 'report-inc',
      ciiV45: { scoreStatus: 'ADMIN_REVIEW_REQUIRED', adminReviewReasons: ['Model skipped rubric parts.'] },
      ciiV45Lock: null,
    });
    await expect(service.approveCiiV45ForAdmin('report-inc', 'admin-1')).rejects.toThrow(
      /Run the CII v4.5 analysis/,
    );
  });
});

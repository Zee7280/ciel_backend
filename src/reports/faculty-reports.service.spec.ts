import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FacultyReportsService, mapFacultyListCii, mapFacultyListPackage } from './faculty-reports.service';

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
  const service = new FacultyReportsService(
    studentReportsRepository as any,
    {} as any,
    facultyService as any,
    aiService as any,
    facultyUniversityScopeService as any,
    { find: jest.fn().mockResolvedValue([]) } as any,
  );
  return {
    service,
    studentReportsRepository,
    aiService,
    qb,
    facultyUniversityScopeService,
  };
}

describe('FacultyReportsService — updateAction', () => {
  it('rejects with no remarks are refused — a student is entitled to know why', async () => {
    const { service, studentReportsRepository } = makeService({
      id: 'report-1',
      faculty_status: 'pending',
    });

    await expect(
      service.updateAction(
        'report-1',
        'faculty-1',
        'teacher@uni.edu',
        'rejected',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateAction(
        'report-1',
        'faculty-1',
        'teacher@uni.edu',
        'rejected',
        '   ',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(studentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('accepts a reject with a real reason', async () => {
    const { service } = makeService({
      id: 'report-1',
      faculty_status: 'pending',
    });

    const result = await service.updateAction(
      'report-1',
      'faculty-1',
      'teacher@uni.edu',
      'rejected',
      'Attendance hours look inflated.',
    );

    expect(result.success).toBe(true);
  });

  it('approve does not require remarks', async () => {
    const { service } = makeService({
      id: 'report-1',
      faculty_status: 'pending',
    });

    const result = await service.updateAction(
      'report-1',
      'faculty-1',
      'teacher@uni.edu',
      'approved',
    );

    expect(result.success).toBe(true);
  });
});

const CII_V2_AI_RESPONSE = {
  sections: [
    {
      id: 1,
      criteria: [
        { key: 'role_clarity', anchor: 4 },
        { key: 'participation_quality', anchor: 4 },
        { key: 'attendance_consistency', anchor: 4 },
        { key: 'engagement_continuity', anchor: 4 },
      ],
    },
    {
      id: 2,
      criteria: [
        { key: 'need_specificity', anchor: 4 },
        { key: 'beneficiary_voice', anchor: 4 },
        { key: 'baseline_evidence', anchor: 4 },
        { key: 'contextual_understanding', anchor: 4 },
        { key: 'disciplinary_lens', anchor: 4 },
      ],
    },
    {
      id: 3,
      criteria: [
        { key: 'sdg_alignment', anchor: 4 },
        { key: 'contribution_logic', anchor: 4 },
        { key: 'activity_output_outcome_alignment', anchor: 4 },
        { key: 'sdg_restraint', anchor: 4 },
      ],
    },
    {
      id: 4,
      criteria: [
        { key: 'planned_vs_actual', anchor: 4 },
        { key: 'delivery_rigor', anchor: 4 },
        { key: 'execution_ownership', anchor: 4 },
        { key: 'output_counting_integrity', anchor: 4 },
        { key: 'depth_or_scale', anchor: 4 },
        { key: 'measurable_outcomes', anchor: 4 },
        { key: 'beneficiary_value', anchor: 4 },
        { key: 'adaptation_honesty', anchor: 4 },
      ],
    },
    {
      id: 5,
      criteria: [
        { key: 'resource_stewardship', anchor: 4 },
        { key: 'resource_traceability', anchor: 4 },
        { key: 'resource_appropriateness', anchor: 4 },
        { key: 'resource_delivery_link', anchor: 4 },
      ],
    },
    {
      id: 6,
      criteria: [
        { key: 'stakeholder_relevance', anchor: 4 },
        { key: 'stakeholder_role_clarity', anchor: 4 },
        { key: 'collaboration_quality', anchor: 4 },
        { key: 'verification_ownership', anchor: 4 },
      ],
    },
    {
      id: 7,
      criteria: [
        { key: 'evidence_participation', anchor: 4 },
        { key: 'evidence_activities', anchor: 4 },
        { key: 'evidence_beneficiaries', anchor: 4 },
        { key: 'evidence_outcomes', anchor: 4 },
        { key: 'evidence_resource_traceability', anchor: 4 },
        { key: 'ethics_integrity', anchor: 4 },
      ],
    },
    {
      id: 8,
      criteria: [
        { key: 'personal_learning', anchor: 4 },
        { key: 'academic_application', anchor: 4 },
        { key: 'ethical_understanding', anchor: 4 },
        { key: 'self_awareness', anchor: 4 },
      ],
    },
    {
      id: 9,
      criteria: [
        { key: 'continuation_assessment', anchor: 4 },
        { key: 'named_ownership', anchor: 4 },
        { key: 'continuation_mechanism', anchor: 4 },
        { key: 'scaling_realism', anchor: 4 },
      ],
    },
  ],
  bonus: { effort: 2, resources: 2, partners: 2 },
  bonusWhy: {},
  integrityPenalty: 0,
  evidence: [],
  redFlags: [],
  needsAdminReview: false,
  frameworkVersion: 'v2.0',
};

describe('FacultyReportsService — runCiiV2Analysis', () => {
  it('refuses to re-analyse an already-locked report', async () => {
    const { service } = makeService({
      id: 'report-1',
      ciiV2Lock: {
        locked: true,
        hash: 'x',
        lockedAt: 'now',
        lockedByFacultyId: 'faculty-1',
      },
    });

    await expect(
      service.runCiiV2Analysis('report-1', 'faculty-1', 'teacher@uni.edu'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('computes and persists a full-marks evaluation as a perfect 100, via a targeted (non-clobbering) update', async () => {
    const { service, studentReportsRepository, qb } = makeService(
      { id: 'report-1' },
      {
        summarize: jest
          .fn()
          .mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }),
      },
    );

    const result = await service.runCiiV2Analysis(
      'report-1',
      'faculty-1',
      'teacher@uni.edu',
    );

    expect(result.success).toBe(true);
    expect((result.data as any).final).toBe(100);
    expect((result.data as any).level.level).toBe(7);
    expect(qb.execute).toHaveBeenCalled();
    // Must never full-entity save() a stale `report` object — that would clobber a
    // concurrently-set ciiV2Lock (see the dedicated race-condition test below).
    expect(studentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('refuses when a concurrent approve locked the report while the AI call was in flight', async () => {
    const { service } = makeService(
      { id: 'report-1' },
      {
        summarize: jest
          .fn()
          .mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }),
      },
      0, // simulates another request's approve having already locked the row
    );

    await expect(
      service.runCiiV2Analysis('report-1', 'faculty-1', 'teacher@uni.edu'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('FacultyReportsService — approveCiiV2', () => {
  it('refuses to approve before an analysis has been run', async () => {
    const { service } = makeService({ id: 'report-1', ciiV2: null });

    await expect(
      service.approveCiiV2('report-1', 'faculty-1', 'teacher@uni.edu'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to re-approve an already-locked report', async () => {
    const { service } = makeService({
      id: 'report-1',
      ciiV2: {
        sections: [],
        bonus: { effort: 0, resources: 0, partners: 0 },
        integrityPenalty: 0,
      },
      ciiV2Lock: {
        locked: true,
        hash: 'x',
        lockedAt: 'now',
        lockedByFacultyId: 'faculty-1',
      },
    });

    await expect(
      service.approveCiiV2('report-1', 'faculty-1', 'teacher@uni.edu'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses when a concurrent request wins the lock first (atomic compare-and-swap affects 0 rows)', async () => {
    const { service } = makeService(
      {
        id: 'report-1',
        ciiV2: {
          sections: [],
          bonus: { effort: 0, resources: 0, partners: 0 },
          integrityPenalty: 0,
        },
        ciiV2Lock: null,
      },
      {},
      0, // simulates another request's UPDATE having already locked the row
    );

    await expect(
      service.approveCiiV2('report-1', 'faculty-1', 'teacher@uni.edu'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('locks with a hash that changes when the faculty note changes, for otherwise identical input and timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const baseReport = () => ({
        id: 'report-1',
        ciiV2: {
          sections: CII_V2_AI_RESPONSE.sections,
          bonus: CII_V2_AI_RESPONSE.bonus,
          integrityPenalty: 0,
          evidence: [],
          computedAt: '2024-01-01T00:00:00.000Z',
        },
      });

      const { service: serviceA } = makeService(baseReport());
      const resultA = await serviceA.approveCiiV2(
        'report-1',
        'faculty-1',
        'teacher@uni.edu',
        'Looks good',
      );

      const { service: serviceB } = makeService(baseReport());
      const resultB = await serviceB.approveCiiV2(
        'report-1',
        'faculty-1',
        'teacher@uni.edu',
        'Different note',
      );

      expect((resultA.data as any).ciiV2Lock.hash).not.toBe(
        (resultB.data as any).ciiV2Lock.hash,
      );
      expect((resultA.data as any).ciiV2Lock.locked).toBe(true);
      expect((resultA.data as any).ciiV2.final).toBe(100);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('FacultyReportsService — runIndependentAiAnalysis (multi-stakeholder Phase 4)', () => {
  const lockedReport = () => ({
    id: 'report-1',
    student: { id: 'student-1', role: 'student', university: 'Acme University' },
    ciiV2Lock: { locked: true, hash: 'x', lockedAt: 'now', lockedByFacultyId: 'faculty-1' },
    independentAiAnalyses: null,
  });

  it('refuses to run on a report that is not yet faculty-approved', async () => {
    const { service } = makeService(
      { id: 'report-1', student: {}, ciiV2Lock: null },
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
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
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
    );
    qb.getOne = jest.fn(async () => null); // outside this faculty's assignment scope

    await expect(
      service.runIndependentAiAnalysis('report-1', 'faculty-1', 'faculty', 'Teacher', undefined, {
        facultyEmail: 'teacher@uni.edu',
      }),
    ).rejects.toThrow(/not found|not assigned/i);
  });

  it('faculty: runs and appends to independentAiAnalyses without touching ciiV2Lock', async () => {
    const { service, studentReportsRepository } = makeService(
      lockedReport(),
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
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
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
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
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
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
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
    );

    const result = await service.runIndependentAiAnalysis(
      'report-1',
      'admin-1',
      'ciel_admin',
      'CIEL PK',
    );

    expect(result.success).toBe(true);
    expect((result.data as any).analysis.runByRole).toBe('ciel_admin');
  });
});

describe('FacultyReportsService — runIndependentAiAnalysisBatch', () => {
  const lockedReport = () => ({
    id: 'report-1',
    student: { id: 'student-1', role: 'student', university: 'Acme University' },
    ciiV2Lock: { locked: true, hash: 'x', lockedAt: 'now', lockedByFacultyId: 'faculty-1' },
    independentAiAnalyses: null,
  });

  it('refuses an empty reportIds list', async () => {
    const { service } = makeService(lockedReport());
    await expect(
      service.runIndependentAiAnalysisBatch([], 'admin-1', 'ciel_admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
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
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
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
      { summarize: jest.fn().mockResolvedValue({ summary: '', ciiV2: CII_V2_AI_RESPONSE }) },
    );
    // Second id resolves to nothing (e.g. someone else's report, outside ciel_admin's... in this
    // case simulate "not found" by having findOne return null only for the second lookup).
    let call = 0;
    studentReportsRepository.findOne = jest.fn(async () => {
      call += 1;
      return call === 2 ? null : lockedReport();
    });

    const result = await service.runIndependentAiAnalysisBatch(
      ['report-1', 'report-2'],
      'admin-1',
      'ciel_admin',
    );

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
    expect(mapFacultyListCii({ ciiV2: null, ciiV2Lock: null })).toEqual({
      cii_analyser_run: false,
      cii_provisional: null,
      cii_locked: false,
      cii_level_name: null,
      cii_numeric_level: null,
    });
  });

  it('maps a provisional System CII without treating it as locked', () => {
    expect(
      mapFacultyListCii({
        ciiV2: {
          final: 54.44,
          numericLevel: 2,
          level: { name: 'Foundation Stage Contributor', level: 2 },
        },
        ciiV2Lock: { locked: false },
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
        ciiV2: { final: '67' },
        ciiV2Lock: { locked: 'false' },
      }),
    ).toMatchObject({
      cii_analyser_run: true,
      cii_provisional: 67,
      cii_locked: false,
    });
  });

  it('ignores malformed ciiV2 payloads instead of throwing', () => {
    expect(mapFacultyListCii({ ciiV2: 'broken', ciiV2Lock: undefined })).toEqual({
      cii_analyser_run: false,
      cii_provisional: null,
      cii_locked: false,
      cii_level_name: null,
      cii_numeric_level: null,
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

  it('uses live attendance hours when the stored blob is empty', () => {
    const report = {
      student: { name: 'Sara Ahmed' },
      section1: { participation_type: 'individual', metrics: { total_verified_hours: 0 } },
      section2: {},
    } as any;
    expect(mapFacultyListPackage(report, 18).member_hours[0].hours).toBe(18);
  });
});

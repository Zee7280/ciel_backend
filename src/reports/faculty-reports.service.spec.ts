import { BadRequestException } from '@nestjs/common';
import { FacultyReportsService } from './faculty-reports.service';

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
  };
  const facultyService = {
    getScopedOpportunityIds: jest.fn().mockResolvedValue([]),
  };
  const aiService = {
    summarize: jest.fn(),
    ...aiServiceOverrides,
  };
  const service = new FacultyReportsService(
    studentReportsRepository as any,
    {} as any,
    facultyService as any,
    aiService as any,
  );
  return { service, studentReportsRepository, aiService, qb };
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

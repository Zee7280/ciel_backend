import {
  CII_V45_DIMENSIONS,
  CiiV45EvaluatorPayload,
  CiiV45CriterionScore,
  computeCiiV45Result,
  CiiV45ValidationError,
} from './cii-v4-5.constants';

/** A minimally valid, all-"Sound" (anchor=2) payload: scores 70 base, FINAL status. */
function buildValidPayload(
  overrides: Partial<CiiV45EvaluatorPayload> = {},
): CiiV45EvaluatorPayload {
  const sectionScores = CII_V45_DIMENSIONS.map((dim) => ({
    dimension: dim.id,
    criterionScores: dim.criteria.map(({ key }): CiiV45CriterionScore => ({
      criterion: key,
      anchor: 2,
      qualityAnchor: 2,
      verificationStatus: 'VERIFIED',
      sourceRefs: ['s1'],
      evidenceIds: [],
      reasoningSummary: 'Sound, credible undergraduate service.',
      deductionReason: null,
    })),
  }));

  return {
    frameworkVersion: '4.5',
    reportId: 'report-1',
    inputFingerprint: 'fp-1',
    inputCompleteness: {
      gaps: [],
      individualHours: [
        { studentId: 's1', hours: 20, requiredHours: 16, verified: true, recordComplete: true },
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
    adminReviewReasons: [],
    strengths: ['Attendance register confirmed all hours.'],
    developmentPriorities: ['Add a baseline measurement next time.'],
    analysisSummary: 'Sound, credible community service project.',
    evidenceSummary: 'Evidence set partially inspected.',
    studentFeedback: 'Good work — keep documenting outcomes.',
    ...overrides,
  };
}

/** Mutates one criterion (by dimension + criterion key) across a cloned payload. */
function withCriterion(
  payload: CiiV45EvaluatorPayload,
  dimension: string,
  criterion: string,
  patch: Partial<CiiV45CriterionScore>,
): CiiV45EvaluatorPayload {
  return {
    ...payload,
    sectionScores: payload.sectionScores.map((s) =>
      s.dimension !== dimension
        ? s
        : {
            ...s,
            criterionScores: s.criterionScores.map((c) =>
              c.criterion !== criterion ? c : { ...c, ...patch },
            ),
          },
    ),
  };
}

describe('computeCiiV45Result', () => {
  it('scores an all-Sound payload at 70/100 base and FINAL status', () => {
    const result = computeCiiV45Result(buildValidPayload());
    expect(result.baseCII).toBe(70);
    expect(result.diagnosticCII).toBe(70);
    expect(result.scoreStatus).toBe('FINAL');
    expect(result.finalCII).toBe(70);
    expect(result.needsAdminReview).toBe(false);
    expect(result.publicationEligible).toBe(true);
    // Sound-everywhere calibration intent: lands on L4 Developing (70).
    expect(result.recommendedBadge?.code).toBe('L4');
    expect(result.finalBadge).toBeNull();
  });

  it('rejects a payload with the wrong number of dimensions', () => {
    const payload = buildValidPayload({ sectionScores: buildValidPayload().sectionScores.slice(0, 9) });
    expect(() => computeCiiV45Result(payload)).toThrow(CiiV45ValidationError);
    expect(() => computeCiiV45Result(payload)).toThrow(/ten analytical dimensions/i);
  });

  it('rejects a duplicate dimension', () => {
    const base = buildValidPayload();
    const payload = buildValidPayload({
      sectionScores: [...base.sectionScores.slice(0, 9), base.sectionScores[0]],
    });
    expect(() => computeCiiV45Result(payload)).toThrow(/Missing\/duplicate dimension/);
  });

  it('rejects an invalid criterion count for a dimension', () => {
    const base = buildValidPayload();
    const payload = {
      ...base,
      sectionScores: base.sectionScores.map((s) =>
        s.dimension !== '1' ? s : { ...s, criterionScores: s.criterionScores.slice(0, 2) },
      ),
    };
    expect(() => computeCiiV45Result(payload)).toThrow(/Invalid criterion count/);
  });

  it('rejects an out-of-range anchor', () => {
    const payload = withCriterion(buildValidPayload(), '1', 'role', { anchor: 5 as never });
    expect(() => computeCiiV45Result(payload)).toThrow(/Invalid anchor/);
  });

  it('treats a pending ("P") criterion as null section score and ADMIN_REVIEW_REQUIRED overall', () => {
    const payload = withCriterion(buildValidPayload(), '1', 'role', {
      anchor: 'P',
      verificationStatus: 'PROCESSING_REQUIRED',
    });
    const result = computeCiiV45Result(payload);
    const dim1 = result.sectionScores.find((s) => s.dimension === '1')!;
    expect(dim1.score).toBeNull();
    expect(dim1.knownPoints).toBeGreaterThan(0); // the other 3 criteria still counted
    expect(result.baseCII).toBeNull();
    expect(result.diagnosticCII).toBeNull();
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.needsAdminReview).toBe(true);
    expect(result.finalCII).toBeNull();
  });

  it('requires inspected evidence for a dimension-7 anchor above 2 (non-ethics)', () => {
    const payload = withCriterion(buildValidPayload(), '7', 'activities', {
      anchor: 3,
      verificationStatus: 'VERIFIED',
      evidenceIds: [],
    });
    expect(() => computeCiiV45Result(payload)).toThrow(/High evidence anchor requires inspected proof/);
  });

  it('allows a dimension-7 anchor above 2 when backed by inspected evidence', () => {
    const base = buildValidPayload();
    const payload = {
      ...withCriterion(base, '7', 'activities', {
        anchor: 3,
        verificationStatus: 'VERIFIED',
        evidenceIds: ['ev1'],
      }),
      evidenceAudit: [
        {
          evidenceId: 'ev1',
          fileName: 'photo.jpg',
          fileType: 'jpg',
          privacy: 'RESTRICTED' as const,
          material: true,
          processingStatus: 'INSPECTED' as const,
          claimIds: [],
          supportStatus: 'SUPPORTED' as const,
        },
      ],
    };
    expect(() => computeCiiV45Result(payload)).not.toThrow();
  });

  it('rejects a positive extra-mile item without a beyond-base justification / inspected evidence', () => {
    const payload = buildValidPayload({
      extraMileUplift: {
        assessmentStatus: 'ASSESSED',
        items: [{ category: 'effort', points: 0.5, studentId: 's1' }],
      },
    });
    expect(() => computeCiiV45Result(payload)).toThrow(/Uplift requires individual/);
  });

  it('rejects a positive integrity penalty without a confirmed student-origin issue', () => {
    const payload = buildValidPayload({ integrityPenalty: { points: 3, issues: [] } });
    expect(() => computeCiiV45Result(payload)).toThrow(/Integrity penalty requires confirmed/);
  });

  it('flags RESUBMISSION_REQUIRED when a student genuinely falls short on required hours', () => {
    const payload = buildValidPayload({
      inputCompleteness: {
        gaps: [],
        individualHours: [
          { studentId: 's1', hours: 10, requiredHours: 16, verified: true, recordComplete: true },
        ],
        mandatoryFieldsComplete: true,
      },
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('RESUBMISSION_REQUIRED');
    expect(result.finalCII).toBeNull();
    expect(result.publicationEligible).toBe(false);
    expect(result.diagnosticCII).toBe(70);
  });

  it('flags RESUBMISSION_REQUIRED on a mandatory STUDENT_NOT_PROVIDED gap', () => {
    const payload = buildValidPayload({
      inputCompleteness: {
        gaps: [{ type: 'STUDENT_NOT_PROVIDED', material: true, mandatory: true }],
        individualHours: [
          { studentId: 's1', hours: 20, requiredHours: 16, verified: true, recordComplete: true },
        ],
        mandatoryFieldsComplete: true,
      },
    });
    expect(computeCiiV45Result(payload).scoreStatus).toBe('RESUBMISSION_REQUIRED');
    expect(computeCiiV45Result(payload).diagnosticCII).toBe(70);
    expect(computeCiiV45Result(payload).finalCII).toBeNull();
  });

  it('flags ADMIN_REVIEW_REQUIRED on an unresolved material system data gap', () => {
    const payload = buildValidPayload({
      inputCompleteness: {
        gaps: [{ type: 'SYSTEM_DATA_GAP', material: true }],
        individualHours: [
          { studentId: 's1', hours: 20, requiredHours: 16, verified: true, recordComplete: true },
        ],
        mandatoryFieldsComplete: true,
      },
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.finalCII).toBeNull();
    expect(result.publicationEligible).toBe(false);
    expect(result.diagnosticCII).not.toBeNull();
    expect(result.diagnosticCII).toBe(result.baseCII);
  });

  it('keeps diagnostic CII when extra-mile uplift is still processing', () => {
    const payload = buildValidPayload({
      extraMileUplift: { assessmentStatus: 'PROCESSING_REQUIRED', items: [] },
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.finalCII).toBeNull();
    expect(result.diagnosticCII).toBe(result.baseCII);
    expect(result.diagnosticCII).not.toBeNull();
    expect(result.diagnosticBadge).not.toBeNull();
    expect(result.recommendedBadge).toBeNull();
  });

  it('keeps diagnostic CII when material evidence was not inspected (screenshot / Pending overall)', () => {
    const payload = buildValidPayload({
      extraMileUplift: { assessmentStatus: 'PROCESSING_REQUIRED', items: [] },
      evidenceAudit: [
        {
          evidenceId: 'ev-pdf',
          fileName: 'register.pdf',
          fileType: 'pdf',
          privacy: 'RESTRICTED',
          material: true,
          processingStatus: 'INACCESSIBLE',
          claimIds: [],
          supportStatus: 'PROCESSING_REQUIRED',
        },
      ],
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.needsAdminReview).toBe(true);
    expect(result.finalCII).toBeNull();
    expect(result.publicationEligible).toBe(false);
    expect(result.baseCII).toBe(70);
    expect(result.diagnosticCII).toBe(70);
    expect(result.diagnosticBadge?.code).toMatch(/^L/);
    expect(result.recommendedBadge).toBeNull();
  });

  it('keeps diagnostic CII when hours are logged but not yet verified', () => {
    const payload = buildValidPayload({
      inputCompleteness: {
        gaps: [],
        individualHours: [
          { studentId: 's1', hours: 20, requiredHours: 16, verified: false, recordComplete: true },
        ],
        mandatoryFieldsComplete: true,
      },
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.finalCII).toBeNull();
    expect(result.diagnosticCII).toBe(70);
  });

  it('caps the badge to the highest passing level when a numeric band fails its quality gate', () => {
    // Push every dimension to Exceptional (anchor 4) except 4B and 7, which stay Sound —
    // numerically this should land well into L6 range, but 4B/7 ratios fail every gate above L3.
    let payload = buildValidPayload();
    for (const dim of CII_V45_DIMENSIONS) {
      if (dim.id === '4B' || dim.id === '7') continue;
      for (const { key } of dim.criteria) {
        payload = withCriterion(payload, dim.id, key, { anchor: 4, qualityAnchor: 4 });
      }
    }
    const result = computeCiiV45Result(payload);
    expect(result.diagnosticCII).toBeGreaterThanOrEqual(90);
    expect(result.recommendedBadge?.gateCapped).toBe(true);
    expect(result.recommendedBadge?.numericLevel).toBe(6);
    expect(result.recommendedBadge?.level).toBeLessThan(6);
  });

  it('requires a verified exceptionalFeature for L6, even when every other gate passes', () => {
    let payload = buildValidPayload();
    for (const dim of CII_V45_DIMENSIONS) {
      for (const { key } of dim.criteria) {
        payload = withCriterion(payload, dim.id, key, {
          anchor: 4,
          qualityAnchor: 4,
          evidenceIds: dim.id === '7' && key !== 'ethics' ? ['ev1'] : [],
        });
      }
    }
    payload = {
      ...payload,
      evidenceAudit: [
        {
          evidenceId: 'ev1',
          fileName: 'photo.jpg',
          fileType: 'jpg',
          privacy: 'RESTRICTED',
          material: true,
          processingStatus: 'INSPECTED',
          claimIds: [],
          supportStatus: 'SUPPORTED',
        },
      ],
    };
    const withoutFeature = computeCiiV45Result({ ...payload, exceptionalFeature: null });
    expect(withoutFeature.recommendedBadge?.level).toBe(5);
    expect(withoutFeature.recommendedBadge?.gateCapped).toBe(true);

    const withFeature = computeCiiV45Result({
      ...payload,
      exceptionalFeature: { verified: true, explanation: 'Sustained partner ownership.', evidenceIds: ['ev1'] },
    });
    expect(withFeature.recommendedBadge?.level).toBe(6);
    expect(withFeature.recommendedBadge?.gateCapped).toBe(false);
  });

  it('rounds the diagnostic score to exactly one decimal place', () => {
    const result = computeCiiV45Result(buildValidPayload());
    expect(result.diagnosticCII).toBe(Math.round((result.diagnosticCII as number) * 10) / 10);
  });

  it('never populates finalBadge from the calculator itself, regardless of status', () => {
    expect(computeCiiV45Result(buildValidPayload()).finalBadge).toBeNull();
    const pending = withCriterion(buildValidPayload(), '1', 'role', {
      anchor: 'P',
      verificationStatus: 'PROCESSING_REQUIRED',
    });
    expect(computeCiiV45Result(pending).finalBadge).toBeNull();
  });
});

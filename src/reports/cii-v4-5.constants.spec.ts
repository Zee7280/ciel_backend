import {
  CII_V45_ADMIN_EVIDENCE_MAX,
  CII_V45_AI_REPORT_MAX,
  CII_V45_DIMENSIONS,
  CII_V45_R2_DIMENSIONS,
  CII_V45_R2_RUBRIC_VERSION,
  CII_V45_LEGACY_DIMENSIONS_R1,
  CII_V45_LEGACY_RUBRIC_VERSION,
  CII_V45_RUBRIC_VERSION,
  CiiV45EvaluatorPayload,
  CiiV45CriterionScore,
  computeCiiV45Result,
  CiiV45ValidationError,
  applyAdminEvidenceAssessment,
  completeAdminEvidenceCriteria,
  getCiiV45ScoringConfig,
  normalizeCiiV5AiPayload,
  resolveCiiV45Rubric,
  assessCiiV45L6,
  resolveCiiV45BadgeR3,
  CiiV45AdminCriterionEdit,
  CiiV45L6Confirmations,
} from './cii-v4-5.constants';

function adminEvidenceFor(payload: CiiV45EvaluatorPayload) {
  const d7 = payload.sectionScores.find((s) => s.dimension === '7')!;
  return {
    status: 'ASSESSED' as const,
    assessorId: 'admin-1',
    assessedAt: '2026-01-01T00:00:00.000Z',
    criteria: d7.criterionScores.map((c) => ({
      criterion: c.criterion,
      anchor: c.anchor as 0 | 1 | 2 | 3 | 4,
      reasoningSummary: c.reasoningSummary,
      evidenceIds: c.evidenceIds,
    })),
  };
}

/**
 * A minimally valid, all-"Sound" (anchor=2) payload: scores 70 base, FINAL status. Defaults to the
 * R2 table, which is the gate-based badge rule these tests cover; pass `CII_V45_DIMENSIONS` for R3.
 */
function buildValidPayload(
  overrides: Partial<CiiV45EvaluatorPayload> = {},
  dimensions: typeof CII_V45_DIMENSIONS = CII_V45_R2_DIMENSIONS,
): CiiV45EvaluatorPayload {
  const sectionScores = dimensions.map((dim) => ({
    dimension: dim.id,
    criterionScores: dim.criteria.map(
      ({ key }): CiiV45CriterionScore => ({
        criterion: key,
        anchor: 2,
        qualityAnchor: 2,
        verificationStatus: dim.id === '7' ? 'ADMIN_VERIFIED' : 'AI_REPORT',
        sourceRefs: ['s1'],
        evidenceIds: [],
        reasoningSummary: 'Sound, credible undergraduate service.',
        deductionReason: null,
      }),
    ),
  }));

  const base: CiiV45EvaluatorPayload = {
    frameworkVersion: '5.0',
    reportId: 'report-1',
    inputFingerprint: 'fp-1',
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
    adminReviewReasons: [],
    strengths: ['Attendance register confirmed all hours.'],
    developmentPriorities: ['Add a baseline measurement next time.'],
    analysisSummary: 'Sound, credible community service project.',
    evidenceSummary: 'Admin evidence assessment complete.',
    studentFeedback: 'Good work — keep documenting outcomes.',
  };
  const merged = { ...base, ...overrides };
  if (!overrides.adminEvidenceAssessment) {
    merged.adminEvidenceAssessment = adminEvidenceFor(merged);
  }
  return merged;
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

function withUniformAnchors(
  aiAnchor: 0 | 1 | 2 | 3 | 4,
  evidenceAnchor: 0 | 1 | 2 | 3 | 4,
): CiiV45EvaluatorPayload {
  return buildValidPayload({
    sectionScores: CII_V45_R2_DIMENSIONS.map((dim) => ({
      dimension: dim.id,
      criterionScores: dim.criteria.map(
        ({ key }): CiiV45CriterionScore => ({
          criterion: key,
          anchor: dim.id === '7' ? evidenceAnchor : aiAnchor,
          qualityAnchor: dim.id === '7' ? evidenceAnchor : aiAnchor,
          verificationStatus: dim.id === '7' ? 'ADMIN_VERIFIED' : 'AI_REPORT',
          sourceRefs: ['s1'],
          evidenceIds: [],
          reasoningSummary: 'Uniform package-alignment anchors.',
        }),
      ),
    })),
  });
}

describe('computeCiiV45Result', () => {
  it('keeps hybrid weights at 85 AI + 15 Admin with v5.0.2 Dim 1/3 keys', () => {
    expect(CII_V45_R2_DIMENSIONS.reduce((t, d) => t + d.maxPoints, 0)).toBe(
      100,
    );
    expect(CII_V45_AI_REPORT_MAX).toBe(85);
    expect(CII_V45_ADMIN_EVIDENCE_MAX).toBe(15);
    const dim1 = CII_V45_R2_DIMENSIONS.find((d) => d.id === '1')!;
    expect(dim1.name).toBe('Participation & Individual Effort');
    expect(dim1.criteria.map((c) => c.key)).toEqual([
      'role',
      'quality',
      'hoursCompletion',
      'continuity',
    ]);
    const dim3 = CII_V45_R2_DIMENSIONS.find((d) => d.id === '3')!;
    expect(dim3.criteria.map((c) => [c.key, c.weight])).toEqual([
      ['alignment', 2.5],
      ['logic', 1.5],
      ['coherence', 0.5],
      ['focus', 0.5],
    ]);
  });

  it('scores an all-Sound payload at 70/100 (59.5 AI + 10.5 Admin evidence) and FINAL status', () => {
    const result = computeCiiV45Result(buildValidPayload());
    expect(result.baseCII).toBe(70);
    expect(result.aiReportScore).toBe(59.5);
    expect(result.adminEvidenceScore).toBe(10.5);
    expect(result.diagnosticCII).toBe(70);
    expect(result.scoreStatus).toBe('FINAL');
    expect(result.finalCII).toBe(70);
    expect(result.needsAdminReview).toBe(false);
    expect(result.publicationEligible).toBe(true);
    expect(result.recommendedBadge?.code).toBe('L4');
    expect(result.finalBadge).toBeNull();
  });

  it('rejects a payload with the wrong number of dimensions', () => {
    const payload = buildValidPayload({
      sectionScores: buildValidPayload().sectionScores.slice(0, 9),
    });
    expect(() => computeCiiV45Result(payload)).toThrow(CiiV45ValidationError);
    expect(() => computeCiiV45Result(payload)).toThrow(
      /ten analytical dimensions/i,
    );
  });

  it('rejects a duplicate dimension', () => {
    const base = buildValidPayload();
    const payload = buildValidPayload({
      sectionScores: [...base.sectionScores.slice(0, 9), base.sectionScores[0]],
    });
    expect(() => computeCiiV45Result(payload)).toThrow(
      /Missing\/duplicate dimension/,
    );
  });

  it('rejects an invalid criterion count for a dimension', () => {
    const base = buildValidPayload();
    const payload = {
      ...base,
      sectionScores: base.sectionScores.map((s) =>
        s.dimension !== '1'
          ? s
          : { ...s, criterionScores: s.criterionScores.slice(0, 2) },
      ),
    };
    expect(() => computeCiiV45Result(payload)).toThrow(
      /Invalid criterion count/,
    );
  });

  it('rejects an out-of-range anchor', () => {
    const payload = withCriterion(buildValidPayload(), '1', 'role', {
      anchor: 5 as never,
    });
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
    expect(result.knownBasePoints).toBeGreaterThan(0);
    expect(result.diagnosticBadge).not.toBeNull();
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.needsAdminReview).toBe(true);
    expect(result.finalCII).toBeNull();
  });

  it('keeps Dimension 7 pending until Admin evidence assessment (ADMIN_EVIDENCE_REQUIRED)', () => {
    const payload = normalizeCiiV5AiPayload(
      buildValidPayload({}, CII_V45_DIMENSIONS),
    );
    const result = computeCiiV45Result(payload);
    expect(result.aiReportScore).toBe(59.5);
    expect(result.adminEvidenceScore).toBeNull();
    expect(result.baseCII).toBeNull();
    expect(result.diagnosticCII).toBeNull();
    expect(result.scoreStatus).toBe('ADMIN_EVIDENCE_REQUIRED');
    expect(result.finalCII).toBeNull();
    const combined = computeCiiV45Result(
      applyAdminEvidenceAssessment(payload, {
        assessorId: 'admin-1',
        assessedAt: '2026-01-01T00:00:00.000Z',
        criteria: CII_V45_R2_DIMENSIONS.find((d) => d.id === '7')!.criteria.map(
          (c) => ({
            criterion: c.key,
            anchor: 2 as const,
            reasoningSummary: 'Admin reviewed originals — sound coverage.',
            evidenceIds: ['ev-1'],
          }),
        ),
      }),
    );
    expect(combined.scoreStatus).toBe('FINAL');
    expect(combined.diagnosticCII).toBe(70);
    expect(combined.adminEvidenceScore).toBe(10.5);
  });

  it('rejects a positive extra-mile item without a beyond-base justification / inspected evidence', () => {
    const payload = buildValidPayload({
      extraMileUplift: {
        assessmentStatus: 'ASSESSED',
        items: [{ category: 'effort', points: 0.5, studentId: 's1' }],
      },
    });
    expect(() => computeCiiV45Result(payload)).toThrow(
      /Uplift requires individual/,
    );
  });

  it('rejects a positive integrity penalty without a confirmed student-origin issue', () => {
    const payload = buildValidPayload({
      integrityPenalty: { points: 3, issues: [] },
    });
    expect(() => computeCiiV45Result(payload)).toThrow(
      /Integrity penalty requires confirmed/,
    );
  });

  it('flags RESUBMISSION_REQUIRED when a student genuinely falls short on required hours', () => {
    const payload = buildValidPayload({
      inputCompleteness: {
        gaps: [],
        individualHours: [
          {
            studentId: 's1',
            hours: 10,
            requiredHours: 16,
            verified: true,
            recordComplete: true,
          },
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
        gaps: [
          { type: 'STUDENT_NOT_PROVIDED', material: true, mandatory: true },
        ],
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
    });
    expect(computeCiiV45Result(payload).scoreStatus).toBe(
      'RESUBMISSION_REQUIRED',
    );
    expect(computeCiiV45Result(payload).diagnosticCII).toBe(70);
    expect(computeCiiV45Result(payload).finalCII).toBeNull();
  });

  it('flags ADMIN_REVIEW_REQUIRED on an unresolved material system data gap', () => {
    const payload = buildValidPayload({
      inputCompleteness: {
        gaps: [{ type: 'SYSTEM_DATA_GAP', material: true }],
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
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.finalCII).toBeNull();
    expect(result.publicationEligible).toBe(false);
    expect(result.diagnosticCII).not.toBeNull();
    expect(result.diagnosticCII).toBe(result.baseCII);
  });

  it('holds diagnostic CII until extra-mile is Admin-assessed', () => {
    const payload = buildValidPayload({
      extraMileUplift: { assessmentStatus: 'PENDING_ADMIN', items: [] },
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_EVIDENCE_REQUIRED');
    expect(result.finalCII).toBeNull();
    expect(result.diagnosticCII).toBeNull();
    expect(result.aiReportScore).toBe(59.5);
    expect(result.adminEvidenceScore).toBe(10.5);
  });

  it('does not hold the CII for uninspected evidence files (Admin owns Dimension 7)', () => {
    const payload = buildValidPayload({
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
    expect(result.scoreStatus).toBe('FINAL');
    expect(result.finalCII).toBe(70);
    expect(result.diagnosticCII).toBe(70);
  });

  it('does not treat pending attendance verification as ADMIN_REVIEW when hours are logged', () => {
    const payload = buildValidPayload({
      inputCompleteness: {
        gaps: [],
        individualHours: [
          {
            studentId: 's1',
            hours: 20,
            requiredHours: 16,
            verified: false,
            recordComplete: true,
          },
        ],
        mandatoryFieldsComplete: true,
      },
    });
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('FINAL');
    expect(result.publicationEligible).toBe(true);
    expect(result.finalCII).toBe(70);
    expect(result.diagnosticCII).toBe(70);
  });

  it('caps the badge to the highest passing level when a numeric band fails its quality gate', () => {
    // Push every dimension to Exceptional (anchor 4) except 4B and 7, which stay Sound —
    // numerically this should land well into L6 range, but 4B/7 ratios fail every gate above L3.
    let payload = buildValidPayload();
    for (const dim of CII_V45_R2_DIMENSIONS) {
      if (dim.id === '4B' || dim.id === '7') continue;
      for (const { key } of dim.criteria) {
        payload = withCriterion(payload, dim.id, key, {
          anchor: 4,
          qualityAnchor: 4,
        });
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
    for (const dim of CII_V45_R2_DIMENSIONS) {
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
      adminEvidenceAssessment: adminEvidenceFor(payload),
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
    const withoutFeature = computeCiiV45Result({
      ...payload,
      exceptionalFeature: null,
    });
    expect(withoutFeature.recommendedBadge?.level).toBe(5);
    expect(withoutFeature.recommendedBadge?.gateCapped).toBe(true);

    const withFeature = computeCiiV45Result({
      ...payload,
      exceptionalFeature: {
        verified: true,
        adminVerified: true,
        explanation: 'Sustained partner ownership.',
        evidenceIds: ['ev1'],
      },
    });
    expect(withFeature.recommendedBadge?.level).toBe(6);
    expect(withFeature.recommendedBadge?.gateCapped).toBe(false);
  });

  it('rounds the diagnostic score to exactly one decimal place', () => {
    const result = computeCiiV45Result(buildValidPayload());
    expect(result.diagnosticCII).toBe(
      Math.round((result.diagnosticCII as number) * 10) / 10,
    );
  });

  it('does not let advisory Admin review reasons suppress a valid Composite CII', () => {
    const result = computeCiiV45Result(
      buildValidPayload({
        adminReviewReasons: [
          'Outcome label and proof should be reconciled by Admin.',
        ],
      }),
    );
    expect(result.scoreStatus).toBe('FINAL');
    expect(result.finalCII).toBe(70);
  });

  it('flags RESUBMISSION_REQUIRED on a mandatory SIGNATURE_INVALID gap', () => {
    const result = computeCiiV45Result(
      buildValidPayload({
        inputCompleteness: {
          gaps: [
            {
              type: 'SIGNATURE_INVALID',
              material: true,
              mandatory: true,
              field: 'signature_name',
            },
          ],
          individualHours: [
            {
              studentId: 's1',
              hours: 20,
              requiredHours: 16,
              verified: true,
              recordComplete: true,
            },
          ],
          mandatoryFieldsComplete: false,
        },
      }),
    );
    expect(result.scoreStatus).toBe('RESUBMISSION_REQUIRED');
    expect(result.finalCII).toBeNull();
  });

  it('treats an incomplete hours record as ADMIN_REVIEW_REQUIRED, not resubmission', () => {
    const result = computeCiiV45Result(
      buildValidPayload({
        inputCompleteness: {
          gaps: [],
          individualHours: [
            {
              studentId: 's1',
              hours: 16,
              requiredHours: 16,
              verified: true,
              recordComplete: false,
            },
          ],
          mandatoryFieldsComplete: true,
        },
      }),
    );
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.finalCII).toBeNull();
  });

  it('defaults missing Dimension 7 marks to Sound (2)', () => {
    const filled = completeAdminEvidenceCriteria([
      { criterion: 'ethics', anchor: 4 },
    ]);
    expect(filled).toHaveLength(7);
    expect(filled.find((c) => c.criterion === 'ethics')?.anchor).toBe(4);
    expect(filled.filter((c) => c.anchor === 2)).toHaveLength(6);
  });

  it('fills omitted AI criteria as pending so compute does not throw', () => {
    const base = buildValidPayload({}, CII_V45_DIMENSIONS);
    const truncated = {
      ...base,
      sectionScores: base.sectionScores
        .filter((s) => s.dimension !== '7')
        .map((s) =>
          s.dimension !== '1'
            ? s
            : { ...s, criterionScores: s.criterionScores.slice(0, 2) },
        ),
    };
    const payload = normalizeCiiV5AiPayload(truncated);
    const dim1 = payload.sectionScores.find((s) => s.dimension === '1')!;
    expect(dim1.criterionScores).toHaveLength(4);
    expect(dim1.criterionScores.filter((c) => c.anchor === 'P')).toHaveLength(
      2,
    );
    expect(
      payload.adminReviewReasons.some((r) => r.includes('AI omitted criteria')),
    ).toBe(true);
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.aiReportScore).toBeNull();
  });

  it('maps criterionId from the live gpt-5.6-sol payload onto official keys', () => {
    const base = buildValidPayload({}, CII_V45_DIMENSIONS);
    const renamed = {
      ...base,
      sectionScores: base.sectionScores
        .filter((s) => s.dimension !== '7')
        .map((s) => ({
          dimension: s.dimension,
          criterionScores: s.criterionScores.map(({ criterion, ...rest }) => ({
            criterionId: criterion,
            ...rest,
          })),
        })),
    };
    const payload = normalizeCiiV5AiPayload(renamed as never);
    expect(computeCiiV45Result(payload).aiReportScore).toBe(59.5);
    expect(computeCiiV45Result(payload).scoreStatus).toBe(
      'ADMIN_EVIDENCE_REQUIRED',
    );
  });

  it('maps unnamed AI criterion rows by position when the count matches', () => {
    const base = buildValidPayload({}, CII_V45_DIMENSIONS);
    const stripped = {
      ...base,
      sectionScores: base.sectionScores
        .filter((s) => s.dimension !== '7')
        .map((s) => ({
          dimension: s.dimension,
          criterionScores: s.criterionScores.map((c) => {
            const rest: Partial<CiiV45CriterionScore> = { ...c };
            delete rest.criterion;
            return rest;
          }),
        })),
    };
    const payload = normalizeCiiV5AiPayload(stripped as never);
    const result = computeCiiV45Result(payload);
    expect(
      payload.sectionScores
        .find((s) => s.dimension === '1')
        ?.criterionScores.map((c) => c.criterion),
    ).toEqual([
      'hoursRequirement',
      'attendanceValidity',
      'contributionAgency',
      'participationAccount',
    ]);
    expect(result.aiReportScore).toBe(59.5);
    expect(result.scoreStatus).toBe('ADMIN_EVIDENCE_REQUIRED');
  });

  it('aliases hoursConsistency / hoursCompletion from older AI payloads onto hoursRequirement', () => {
    const payload = normalizeCiiV5AiPayload({
      ...buildValidPayload({}, CII_V45_DIMENSIONS),
      sectionScores: CII_V45_DIMENSIONS.filter((d) => d.id !== '7').map(
        (dim) => ({
          dimension: dim.id,
          criterionScores: dim.criteria.map(({ key }) => ({
            criterion:
              dim.id === '1' && key === 'hoursRequirement'
                ? 'hoursConsistency'
                : key,
            anchor: 2 as const,
            qualityAnchor: 2 as const,
            verificationStatus: 'AI_REPORT' as const,
            sourceRefs: ['s1'],
            evidenceIds: [],
            reasoningSummary: 'Sound.',
          })),
        }),
      ),
    });
    const dim1 = payload.sectionScores.find((s) => s.dimension === '1')!;
    expect(
      dim1.criterionScores.some((c) => c.criterion === 'hoursRequirement'),
    ).toBe(true);
    expect(computeCiiV45Result(payload).aiReportScore).toBe(59.5);
  });

  it('matches the v5.0.2 package: Anchor 3 is AI 72.3 + Admin 12.8 = Composite 85 / L5', () => {
    const result = computeCiiV45Result(withUniformAnchors(3, 3));
    expect(result.aiReportScore).toBe(72.3);
    expect(result.adminEvidenceScore).toBe(12.8);
    expect(result.baseCII).toBe(85);
    expect(result.finalCII).toBe(85);
    expect(result.scoreStatus).toBe('FINAL');
    expect(result.recommendedBadge?.code).toBe('L5');
  });

  it('lets evidence weakness affect Dimension 7 only and gate a high numeric score', () => {
    const result = computeCiiV45Result(withUniformAnchors(4, 1));
    expect(result.aiReportScore).toBe(85);
    expect(result.adminEvidenceScore).toBe(7.5);
    expect(result.finalCII).toBe(92.5);
    expect(result.diagnosticBadge?.numericLevel).toBe(6);
    expect(result.recommendedBadge?.code).toBe('L3');
    expect(result.recommendedBadge?.gateCapped).toBe(true);
  });

  it('adds Admin-verified extra-mile uplift onto the raw hybrid total before the single rounding step', () => {
    const payload = withUniformAnchors(3, 3);
    payload.extraMileUplift = {
      assessmentStatus: 'ASSESSED',
      items: [
        {
          category: 'effort',
          points: 1.25,
          studentId: 's1',
          evidenceIds: ['E1'],
          beyondBaseJustification:
            'Distinct extra effort beyond the 16-hour base.',
          adminVerified: true,
        },
      ],
    };
    expect(computeCiiV45Result(payload).finalCII).toBe(86.3);
  });

  it('writes a default Admin evidence rationale when the standard UI omits per-criterion notes', () => {
    const pending = normalizeCiiV5AiPayload(
      buildValidPayload({}, CII_V45_DIMENSIONS),
    );
    const combined = applyAdminEvidenceAssessment(pending, {
      assessorId: 'admin-1',
      assessedAt: '2026-01-01T00:00:00.000Z',
      criteria: CII_V45_R2_DIMENSIONS.find((d) => d.id === '7')!.criteria.map(
        (c) => ({
          criterion: c.key,
          anchor: 2 as const,
          evidenceIds: [],
        }),
      ),
    });
    for (const row of combined.adminEvidenceAssessment?.criteria ?? []) {
      expect(row.reasoningSummary).toMatch(/CIEL PK Admin assigned Anchor 2/);
    }
    expect(computeCiiV45Result(combined).finalCII).toBe(70);
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

describe('rubric versions: R3 current, R2 and R1 kept for stored analyses', () => {
  type Anchor = 0 | 1 | 2 | 3 | 4 | 'P';
  /** A FINAL R3 payload with a chosen anchor per criterion (dimension 7 is the Admin's). */
  function r3Payload(
    anchorOf: (dim: string, key: string) => Anchor,
    overrides: Partial<CiiV45EvaluatorPayload> = {},
  ): CiiV45EvaluatorPayload {
    const sectionScores = CII_V45_DIMENSIONS.map((dim) => ({
      dimension: dim.id,
      criterionScores: dim.criteria.map(({ key }): CiiV45CriterionScore => {
        const a = anchorOf(dim.id, key);
        return {
          criterion: key,
          anchor: a,
          qualityAnchor: a,
          verificationStatus: dim.id === '7' ? 'ADMIN_VERIFIED' : 'AI_REPORT',
          sourceRefs: ['s1'],
          evidenceIds: [],
          reasoningSummary: 'Judgement with a source.',
          deductionReason: null,
        };
      }),
    }));
    return buildValidPayload(
      { sectionScores, ...overrides },
      CII_V45_DIMENSIONS,
    );
  }
  const edit = (
    points: number,
    reason = 'The register on page 2 supports this mark.',
  ): CiiV45AdminCriterionEdit => ({
    points,
    reason,
    sourceRef: 'section4.activities[0]',
    actorId: 'admin-1',
    at: '2026-11-10T00:00:00.000Z',
  });
  const qualified: CiiV45L6Confirmations = {
    observedRetention: true,
    communityOwnership: true,
    externalCorroboration: true,
    sourceRef: 'section10.follow_up',
  };

  it('R3 is the 45-criterion table: 38 AI criteria worth 85 plus 7 Admin criteria worth 15', () => {
    expect(CII_V45_RUBRIC_VERSION).toBe('CIEL-CII-2026.11-R3');
    expect(CII_V45_R2_RUBRIC_VERSION).toBe('CIEL-CII-2026.11-R2');
    expect(
      Object.fromEntries(CII_V45_DIMENSIONS.map((d) => [d.id, d.maxPoints])),
    ).toEqual({
      '1': 10,
      '2': 10,
      '3': 5,
      '4A': 15,
      '4B': 15,
      '5': 10,
      '6': 5,
      '7': 15,
      '8': 5,
      '9': 10,
    });
    const count = (ids: string[]) =>
      CII_V45_DIMENSIONS.filter((d) => ids.includes(d.id)).reduce(
        (t, d) => t + d.criteria.length,
        0,
      );
    expect(count(['1', '2', '3', '4A', '4B', '5', '6', '8', '9'])).toBe(38);
    expect(count(['7'])).toBe(7);
    // every dimension's criterion weights add up to the dimension maximum
    for (const d of CII_V45_DIMENSIONS) {
      expect(d.criteria.reduce((t, c) => t + c.weight, 0)).toBeCloseTo(
        d.maxPoints,
        6,
      );
    }
    const weights = (id: string) =>
      CII_V45_DIMENSIONS.find((d) => d.id === id)!.criteria.map((c) => [
        c.key,
        c.weight,
      ]);
    expect(weights('1')).toEqual([
      ['hoursRequirement', 4],
      ['attendanceValidity', 2],
      ['contributionAgency', 2],
      ['participationAccount', 2],
    ]);
    expect(weights('4B').map(([, w]) => w)).toEqual([4, 2, 3, 2, 2, 2]);
    expect(CII_V45_AI_REPORT_MAX).toBe(85);
    expect(CII_V45_ADMIN_EVIDENCE_MAX).toBe(15);
    const cfg = getCiiV45ScoringConfig();
    expect(cfg.rubric_version).toBe('CIEL-CII-2026.11-R3');
    expect(cfg.badge_policy.l6.minimum_cii).toBe(90);
    expect(cfg.badge_policy.l6.minimum_measured_change).toBe(12);
  });

  it('resolves the table (and with it the badge rule) from the criterion keys a payload carries', () => {
    const r3 = resolveCiiV45Rubric(r3Payload(() => 2).sectionScores);
    expect(r3.version).toBe(CII_V45_RUBRIC_VERSION);
    expect(r3.badgePolicy).toBe('L6_QUALIFICATION');
    const r2 = resolveCiiV45Rubric(buildValidPayload().sectionScores);
    expect(r2.version).toBe(CII_V45_R2_RUBRIC_VERSION);
    expect(r2.badgePolicy).toBe('GATES');
    const r1 = resolveCiiV45Rubric(
      CII_V45_LEGACY_DIMENSIONS_R1.map((d) => ({
        dimension: d.id,
        criterionScores: d.criteria.map((c) => ({ criterion: c.key })),
      })),
    );
    expect(r1.version).toBe(CII_V45_LEGACY_RUBRIC_VERSION);
    expect(r1.badgePolicy).toBe('GATES');
  });

  it('scores an R3 payload on the R3 table and stamps the version', () => {
    const all4 = computeCiiV45Result(r3Payload(() => 4));
    expect(all4.finalCII).toBe(100);
    expect(all4.rubricVersion).toBe(CII_V45_RUBRIC_VERSION);
    expect(
      all4.sectionScores.find((s) => s.dimension === '4B')!.criterionScores,
    ).toHaveLength(6);
    // all-Sound is 70 on every table: the 85 + 15 split and the anchor factors are unchanged
    const sound = computeCiiV45Result(r3Payload(() => 2));
    expect(sound.finalCII).toBe(70);
    expect(sound.aiReportScore).toBe(59.5);
    expect(sound.aiProposalScore).toBe(59.5);
    expect(sound.moderated).toBe(false);
  });

  it('keeps scoring an R2 payload on the R2 table with the gate-based badge rule it was approved under', () => {
    const r2 = computeCiiV45Result(buildValidPayload());
    expect(r2.rubricVersion).toBe(CII_V45_R2_RUBRIC_VERSION);
    expect(r2.finalCII).toBe(70);
    expect(
      r2.sectionScores
        .find((s) => s.dimension === '1')!
        .criterionScores.map((c) => c.criterion),
    ).toEqual(['role', 'quality', 'hoursCompletion', 'continuity']);
    expect(r2.candidateBadge).toBeUndefined();
    expect(r2.badgeStatus).toBeUndefined();
  });

  it('still scores a pre-R2 payload (old Dim 6/9 keys) against the R1 table, so stored drafts approve unchanged', () => {
    const legacyPayload: CiiV45EvaluatorPayload = {
      ...buildValidPayload(),
      sectionScores: CII_V45_LEGACY_DIMENSIONS_R1.map((d) => ({
        dimension: d.id,
        criterionScores: d.criteria.map(
          ({ key }): CiiV45CriterionScore => ({
            criterion: key,
            anchor: 2,
            qualityAnchor: 2,
            verificationStatus: d.id === '7' ? 'ADMIN_VERIFIED' : 'AI_REPORT',
            sourceRefs: ['s1'],
            evidenceIds: [],
            reasoningSummary: 'Sound.',
          }),
        ),
      })),
    };
    const result = computeCiiV45Result(legacyPayload);
    expect(result.rubricVersion).toBe(CII_V45_LEGACY_RUBRIC_VERSION);
    expect(
      result.sectionScores.find((s) => s.dimension === '6')!.maximumPoints,
    ).toBe(10);
    expect(
      result.sectionScores.find((s) => s.dimension === '9')!.maximumPoints,
    ).toBe(5);
    expect(result.finalCII).toBe(70);
  });

  it('holds R3 criteria the AI omitted as pending (the keys are in the manifest the AI is told to emit)', () => {
    const raw = r3Payload(() => 2);
    const stripped = {
      ...raw,
      sectionScores: raw.sectionScores.map((s) =>
        s.dimension === '9'
          ? {
              ...s,
              criterionScores: s.criterionScores.filter(
                (c) => c.criterion !== 'followUpRetention',
              ),
            }
          : s,
      ),
    };
    const normalized = normalizeCiiV5AiPayload(stripped);
    const nine = normalized.sectionScores.find((s) => s.dimension === '9')!;
    expect(nine.criterionScores).toHaveLength(5);
    expect(
      nine.criterionScores.find((c) => c.criterion === 'followUpRetention')
        ?.anchor,
    ).toBe('P');
    expect(computeCiiV45Result(normalized).scoreStatus).toBe(
      'ADMIN_REVIEW_REQUIRED',
    );
  });

  describe('Admin criterion mark moderation (R3)', () => {
    it('replaces the AI mark in the section total and keeps the AI anchor and mark as the baseline', () => {
      const payload = r3Payload(() => 2, {
        adminModeration: {
          revision: 1,
          edits: { '1.hoursRequirement': edit(4) },
          log: [],
        },
      });
      const result = computeCiiV45Result(payload);
      const d1 = result.sectionScores.find((s) => s.dimension === '1')!;
      const c = d1.criterionScores.find(
        (x) => x.criterion === 'hoursRequirement',
      )!;
      expect(c.score).toBe(4);
      expect(c.aiScore).toBe(2.8);
      expect(c.anchor).toBe(2);
      expect(c.adminEdited).toBe(true);
      expect(c.adminEdit?.reason).toMatch(/register/);
      expect(d1.score).toBe(8.2);
      expect(result.aiReportScore).toBe(60.7);
      expect(result.aiProposalScore).toBe(59.5);
      expect(result.moderated).toBe(true);
      expect(result.finalCII).toBe(71.2);
      // untouched criteria are unmarked
      expect(
        d1.criterionScores.find((x) => x.criterion === 'attendanceValidity')!
          .adminEdited,
      ).toBe(false);
    });

    it('lets Admin resolve a criterion the AI left pending', () => {
      const payload = r3Payload(
        (dim, key) => (dim === '9' && key === 'followUpRetention' ? 'P' : 2),
        {
          adminModeration: {
            revision: 1,
            edits: { '9.followUpRetention': edit(2) },
            log: [],
          },
        },
      );
      const result = computeCiiV45Result(payload);
      const nine = result.sectionScores.find((s) => s.dimension === '9')!;
      expect(nine.score).not.toBeNull();
      expect(result.aiProposalScore).toBeNull();
      expect(result.aiReportScore).not.toBeNull();
    });

    it('rejects a mark above the criterion maximum, with more than two decimals, or without a reason', () => {
      const run = (e: CiiV45AdminCriterionEdit) =>
        computeCiiV45Result(
          r3Payload(() => 2, {
            adminModeration: {
              revision: 1,
              edits: { '1.hoursRequirement': e },
              log: [],
            },
          }),
        );
      expect(() => run(edit(4.5))).toThrow(/between 0 and 4/);
      expect(() => run(edit(-1))).toThrow(CiiV45ValidationError);
      expect(() => run(edit(2.555))).toThrow(/two decimals/);
      expect(() => run(edit(3, '   '))).toThrow(/reason/);
      expect(run(edit(3.25)).sectionScores[0].criterionScores[0].score).toBe(
        3.25,
      );
    });

    it('refuses moderation on an R2 or R1 analysis (they keep their original rules)', () => {
      expect(() =>
        computeCiiV45Result(
          buildValidPayload({
            adminModeration: {
              revision: 1,
              edits: { '1.role': edit(1) },
              log: [],
            },
          }),
        ),
      ).toThrow(/requires the R3 rubric/);
    });

    it('drops a stale edit marker when a payload is re-computed without the edit', () => {
      const edited = computeCiiV45Result(
        r3Payload(() => 2, {
          adminModeration: {
            revision: 1,
            edits: { '1.hoursRequirement': edit(4) },
            log: [],
          },
        }),
      );
      const again = computeCiiV45Result({
        ...(edited as unknown as CiiV45EvaluatorPayload),
        adminModeration: undefined,
      });
      const c = again.sectionScores[0].criterionScores[0];
      expect(c.adminEdited).toBe(false);
      expect(c.adminEdit).toBeUndefined();
      expect(c.score).toBe(2.8);
      expect(again.moderated).toBe(false);
    });
  });

  describe('R3 badge policy', () => {
    it('has no L4/L5 quality gate: the CII alone picks the band', () => {
      // 4B only Basic, everything else Strong, Admin evidence Exceptional: CII 82.0
      const result = computeCiiV45Result(
        r3Payload((dim) => (dim === '7' ? 4 : dim === '4B' ? 1 : 3)),
      );
      expect(result.finalCII).toBe(82);
      expect(result.qualityGates.L4).toBe(true);
      expect(result.qualityGates.L5).toBe(true);
      expect(result.recommendedBadge?.code).toBe('L5');
      expect(result.recommendedBadge?.gateCapped).toBe(false);
      expect(result.badgeStatus).toBe('AWARDED');
    });

    it('keeps a 90+ CII and leaves L6 pending until the sourced qualification, never substituting L5', () => {
      const payload = r3Payload((dim) => (dim === '7' ? 3 : 4)); // AI 85 + evidence 12.75
      const result = computeCiiV45Result(payload);
      expect(result.finalCII).toBe(97.8);
      expect(result.candidateBadge?.code).toBe('L6');
      expect(result.badgeStatus).toBe('L6_PENDING_QUALIFICATION');
      expect(result.recommendedBadge).toBeNull();
      expect(result.diagnosticBadge).toBeNull();
      expect(result.l6Assessment?.status).toBe('PENDING_QUALIFICATION');
      expect(result.l6Assessment?.reasons).toEqual([
        'Observed retained benefits not confirmed',
        'Community ownership or adoption not confirmed',
        'Corroboration outside the student team not confirmed',
        'Qualification source reference missing',
      ]);
    });

    it('awards L6 only when the minima hold and all three confirmations name a source', () => {
      const result = computeCiiV45Result(
        r3Payload((dim) => (dim === '7' ? 3 : 4), {
          l6Qualification: qualified,
        }),
      );
      expect(result.l6Assessment?.status).toBe('QUALIFIED');
      expect(result.recommendedBadge?.code).toBe('L6');
      expect(result.badgeStatus).toBe('AWARDED');
      expect(result.qualityGates.L6).toBe(true);
    });

    it('names the numeric minima a 90+ candidate misses', () => {
      // Measured Change at Sound (10.5/15), everything else Exceptional: CII 95.5
      const result = computeCiiV45Result(
        r3Payload((dim) => (dim === '4B' ? 2 : 4), {
          l6Qualification: qualified,
        }),
      );
      expect(result.finalCII).toBe(95.5);
      expect(result.l6Assessment?.status).toBe('PENDING_QUALIFICATION');
      expect(result.l6Assessment?.reasons).toEqual([
        'Measured Change below 12/15',
      ]);
      expect(result.badgeStatus).toBe('L6_PENDING_QUALIFICATION');
    });

    it('does not apply Admin uplift or an integrity deduction to an R3 number', () => {
      const withExtras = computeCiiV45Result(
        r3Payload(() => 2, {
          extraMileUplift: {
            assessmentStatus: 'ASSESSED',
            items: [
              {
                category: 'effort',
                points: 1,
                studentId: 's1',
                beyondBaseJustification:
                  'Distinct extra effort beyond the 16-hour base.',
                evidenceIds: ['e1'],
                adminVerified: true,
              },
            ],
          },
        }),
      );
      expect(withExtras.finalCII).toBe(70);
    });

    it('assessCiiV45L6 and resolveCiiV45BadgeR3 agree on the pending and awarded outcomes', () => {
      const sections = [
        { dimension: '4B', score: 14 },
        { dimension: '9', score: 9 },
        { dimension: '7', score: 13 },
      ];
      expect(assessCiiV45L6(89.9, sections, qualified).status).toBe(
        'NOT_REQUIRED',
      );
      expect(assessCiiV45L6(null, sections, qualified).status).toBe(
        'NOT_REQUIRED',
      );
      expect(assessCiiV45L6(95, sections, qualified).status).toBe('QUALIFIED');
      expect(assessCiiV45L6(95, sections, null).reasons).toHaveLength(4);
      expect(
        assessCiiV45L6(95, sections, { ...qualified, sourceRef: '  ' }).reasons,
      ).toEqual(['Qualification source reference missing']);
      const pending = resolveCiiV45BadgeR3(95, false);
      expect(pending.badge).toBeNull();
      expect(pending.candidate?.code).toBe('L6');
      expect(pending.status).toBe('L6_PENDING_QUALIFICATION');
      expect(resolveCiiV45BadgeR3(95, true).badge?.code).toBe('L6');
      expect(resolveCiiV45BadgeR3(79.9, false).badge?.code).toBe('L4');
      expect(resolveCiiV45BadgeR3(null, false)).toEqual({
        badge: null,
        candidate: null,
        status: null,
      });
    });
  });
});

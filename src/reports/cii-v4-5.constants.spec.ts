import {
  CII_V45_ADMIN_EVIDENCE_MAX,
  CII_V45_AI_REPORT_MAX,
  CII_V45_DIMENSIONS,
  CiiV45EvaluatorPayload,
  CiiV45CriterionScore,
  computeCiiV45Result,
  CiiV45ValidationError,
  applyAdminEvidenceAssessment,
  normalizeCiiV5AiPayload,
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
      verificationStatus: dim.id === '7' ? 'ADMIN_VERIFIED' : 'AI_REPORT',
      sourceRefs: ['s1'],
      evidenceIds: [],
      reasoningSummary: 'Sound, credible undergraduate service.',
      deductionReason: null,
    })),
  }));

  const base: CiiV45EvaluatorPayload = {
    frameworkVersion: '5.0',
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
    sectionScores: CII_V45_DIMENSIONS.map((dim) => ({
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
    expect(CII_V45_DIMENSIONS.reduce((t, d) => t + d.maxPoints, 0)).toBe(100);
    expect(CII_V45_AI_REPORT_MAX).toBe(85);
    expect(CII_V45_ADMIN_EVIDENCE_MAX).toBe(15);
    const dim1 = CII_V45_DIMENSIONS.find((d) => d.id === '1')!;
    expect(dim1.name).toBe('Participation & Individual Effort');
    expect(dim1.criteria.map((c) => c.key)).toEqual(['role', 'quality', 'hoursCompletion', 'continuity']);
    const dim3 = CII_V45_DIMENSIONS.find((d) => d.id === '3')!;
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
    expect(result.knownBasePoints).toBeGreaterThan(0);
    expect(result.diagnosticBadge).not.toBeNull();
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.needsAdminReview).toBe(true);
    expect(result.finalCII).toBeNull();
  });

  it('keeps Dimension 7 pending until Admin evidence assessment (ADMIN_EVIDENCE_REQUIRED)', () => {
    const payload = normalizeCiiV5AiPayload(buildValidPayload());
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
        criteria: CII_V45_DIMENSIONS.find((d) => d.id === '7')!.criteria.map((c) => ({
          criterion: c.key,
          anchor: 2 as const,
          reasoningSummary: 'Admin reviewed originals — sound coverage.',
          evidenceIds: ['ev-1'],
        })),
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
          { studentId: 's1', hours: 20, requiredHours: 16, verified: false, recordComplete: true },
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
    const withoutFeature = computeCiiV45Result({ ...payload, exceptionalFeature: null });
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
    expect(result.diagnosticCII).toBe(Math.round((result.diagnosticCII as number) * 10) / 10);
  });

  it('does not let advisory Admin review reasons suppress a valid Composite CII', () => {
    const result = computeCiiV45Result(
      buildValidPayload({
        adminReviewReasons: ['Outcome label and proof should be reconciled by Admin.'],
      }),
    );
    expect(result.scoreStatus).toBe('FINAL');
    expect(result.finalCII).toBe(70);
  });

  it('flags RESUBMISSION_REQUIRED on a mandatory SIGNATURE_INVALID gap', () => {
    const result = computeCiiV45Result(
      buildValidPayload({
        inputCompleteness: {
          gaps: [{ type: 'SIGNATURE_INVALID', material: true, mandatory: true, field: 'signature_name' }],
          individualHours: [
            { studentId: 's1', hours: 20, requiredHours: 16, verified: true, recordComplete: true },
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
            { studentId: 's1', hours: 16, requiredHours: 16, verified: true, recordComplete: false },
          ],
          mandatoryFieldsComplete: true,
        },
      }),
    );
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.finalCII).toBeNull();
  });

  it('fills omitted AI criteria as pending so compute does not throw', () => {
    const base = buildValidPayload();
    const truncated = {
      ...base,
      sectionScores: base.sectionScores
        .filter((s) => s.dimension !== '7')
        .map((s) =>
          s.dimension !== '1' ? s : { ...s, criterionScores: s.criterionScores.slice(0, 2) },
        ),
    };
    const payload = normalizeCiiV5AiPayload(truncated);
    const dim1 = payload.sectionScores.find((s) => s.dimension === '1')!;
    expect(dim1.criterionScores).toHaveLength(4);
    expect(dim1.criterionScores.filter((c) => c.anchor === 'P')).toHaveLength(2);
    expect(payload.adminReviewReasons.some((r) => r.includes('AI omitted criteria'))).toBe(true);
    const result = computeCiiV45Result(payload);
    expect(result.scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
    expect(result.aiReportScore).toBeNull();
  });

  it('aliases hoursConsistency from older AI payloads onto hoursCompletion', () => {
    const payload = normalizeCiiV5AiPayload({
      ...buildValidPayload(),
      sectionScores: CII_V45_DIMENSIONS.filter((d) => d.id !== '7').map((dim) => ({
        dimension: dim.id,
        criterionScores: dim.criteria.map(({ key }) => ({
          criterion: dim.id === '1' && key === 'hoursCompletion' ? 'hoursConsistency' : key,
          anchor: 2 as const,
          qualityAnchor: 2 as const,
          verificationStatus: 'AI_REPORT' as const,
          sourceRefs: ['s1'],
          evidenceIds: [],
          reasoningSummary: 'Sound.',
        })),
      })),
    });
    const dim1 = payload.sectionScores.find((s) => s.dimension === '1')!;
    expect(dim1.criterionScores.some((c) => c.criterion === 'hoursCompletion')).toBe(true);
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
          beyondBaseJustification: 'Distinct extra effort beyond the 16-hour base.',
          adminVerified: true,
        },
      ],
    };
    expect(computeCiiV45Result(payload).finalCII).toBe(86.3);
  });

  it('writes a default Admin evidence rationale when the standard UI omits per-criterion notes', () => {
    const pending = normalizeCiiV5AiPayload(buildValidPayload());
    const combined = applyAdminEvidenceAssessment(pending, {
      assessorId: 'admin-1',
      assessedAt: '2026-01-01T00:00:00.000Z',
      criteria: CII_V45_DIMENSIONS.find((d) => d.id === '7')!.criteria.map((c) => ({
        criterion: c.key,
        anchor: 2 as const,
        evidenceIds: [],
      })),
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

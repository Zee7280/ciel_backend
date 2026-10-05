import { redactCiiV45Fields } from './cii-v4-5-redaction.util';

const SENSITIVE_CII_V45 = {
  finalCII: 84.5,
  diagnosticCII: 84.5,
  frameworkVersion: '5.0',
  aiReportScore: 70,
  adminEvidenceScore: 13,
  baseCII: 83,
  finalBadge: { code: 'L5', name: 'Distinguished Impact Contributor', level: 5, numericLevel: 5, gateCapped: false },
  recommendedBadge: { code: 'L5', name: 'Distinguished Impact Contributor', level: 5, numericLevel: 5, gateCapped: false },
  sectionScores: [
    {
      dimension: '7',
      name: 'Evidence, Ethics & Verification',
      maximumPoints: 15,
      score: 13,
      criterionScores: [
        {
          criterion: 'ethics',
          anchor: 4,
          qualityAnchor: 4,
          verificationStatus: 'VERIFIED',
          sourceRefs: ['Section 8'],
          evidenceIds: ['ev-1'],
          reasoningSummary: 'Private faculty-facing rationale about the student.',
          deductionReason: 'Private deduction rationale.',
        },
      ],
    },
  ],
  claimInventory: [{ claimId: 'c1', text: 'Private claim text naming a beneficiary.', material: true, evidenceIds: ['ev-1'], supportStatus: 'SUPPORTED' }],
  evidenceAudit: [{ evidenceId: 'ev-1', actualContentSummary: 'Private description of the evidence contents.', privacy: 'RESTRICTED', material: true, processingStatus: 'INSPECTED', claimIds: ['c1'], supportStatus: 'SUPPORTED' }],
  adminReviewReasons: ['Private note about an unresolved discrepancy.'],
  exceptionalFeature: { verified: true, explanation: 'Private explanation of the exceptional feature.', evidenceIds: ['ev-1'] },
  extraMileUplift: { assessmentStatus: 'ASSESSED', items: [{ category: 'effort', points: 1, studentId: 's1', beyondBaseJustification: 'Private justification.', evidenceIds: ['ev-1'] }], total: 1 },
  integrityPenalty: { points: 0, issues: [] },
  strengths: ['Attendance register confirmed all hours.'],
  developmentPriorities: ['Add a baseline measurement.'],
  analysisSummary: 'Internal analysis summary for Faculty/Admin.',
  evidenceSummary: 'Internal evidence summary.',
  studentFeedback: 'Good work — keep documenting outcomes.',
};

const LOCKED = {
  locked: true,
  hash: 'abc123',
  lockedAt: '2026-10-04T00:00:00.000Z',
  lockedByAdminId: 'admin-1',
  inputFingerprint: 'fp-1',
  scoreStatusAtLock: 'FINAL' as const,
  aiRecommendedScore: 84.5,
  adminApprovedScore: 84.5,
};

describe('redactCiiV45Fields', () => {
  it('strips everything before an Admin has locked the evaluation (no provisional release)', () => {
    const result = redactCiiV45Fields(SENSITIVE_CII_V45, null);
    expect(result).toEqual({ ciiV45: null, ciiV45Lock: null });
  });

  it('strips everything when ciiV45Lock.locked is false', () => {
    const result = redactCiiV45Fields(SENSITIVE_CII_V45, { ...LOCKED, locked: false });
    expect(result).toEqual({ ciiV45: null, ciiV45Lock: null });
  });

  it('once locked, exposes only the curated outcome subset — never per-criterion or raw-content fields', () => {
    const result = redactCiiV45Fields(SENSITIVE_CII_V45, LOCKED);
    const serialized = JSON.stringify(result);

    // Never-expose fields, verified absent from the serialized output.
    expect(serialized).not.toContain('Private faculty-facing rationale');
    expect(serialized).not.toContain('Private deduction rationale');
    expect(serialized).not.toContain('Private claim text');
    expect(serialized).not.toContain('Private description of the evidence');
    expect(serialized).not.toContain('Private note about an unresolved discrepancy');
    expect(serialized).not.toContain('Private explanation of the exceptional feature');
    expect(serialized).not.toContain('Private justification');
    expect(serialized).not.toContain('criterionScores');
    expect(serialized).not.toContain('sourceRefs');
    expect(serialized).not.toContain('claimInventory');
    expect(serialized).not.toContain('evidenceAudit');
    expect(serialized).not.toContain('adminReviewReasons');
    expect(serialized).not.toContain('exceptionalFeature');

    // Whitelisted fields, present and correct.
    expect(result.ciiV45?.finalCII).toBe(84.5);
    expect(result.ciiV45?.aiReportScore).toBe(70);
    expect(result.ciiV45?.adminEvidenceScore).toBe(13);
    expect(result.ciiV45?.baseCII).toBe(83);
    expect(result.ciiV45?.frameworkVersion).toBe('5.0');
    expect(result.ciiV45?.recommendedBadge).toEqual({
      code: 'L5', name: 'Distinguished Impact Contributor', level: 5, numericLevel: 5, gateCapped: false,
    });
    expect(result.ciiV45?.sectionScores).toEqual([
      { dimension: '7', name: 'Evidence, Ethics & Verification', maximumPoints: 15, score: 13 },
    ]);
    expect(result.ciiV45?.extraMileUplift).toEqual({ total: 1 });
    expect(result.ciiV45?.integrityPenalty).toEqual({ points: 0 });
    expect(result.ciiV45?.strengths).toEqual(['Attendance register confirmed all hours.']);
    expect(result.ciiV45?.studentFeedback).toBe('Good work — keep documenting outcomes.');
    expect(result.ciiV45Lock).toEqual({
      locked: true,
      hash: 'abc123',
      lockedAt: '2026-10-04T00:00:00.000Z',
      aiRecommendedScore: 84.5,
      adminApprovedScore: 84.5,
      scoreWasModerated: undefined,
      scoreModerationReason: undefined,
    });
  });

  it('returns null badges gracefully when none is present', () => {
    const result = redactCiiV45Fields({ ...SENSITIVE_CII_V45, finalBadge: null, recommendedBadge: null }, LOCKED);
    expect(result.ciiV45?.finalBadge).toBeNull();
    expect(result.ciiV45?.recommendedBadge).toBeNull();
  });
});

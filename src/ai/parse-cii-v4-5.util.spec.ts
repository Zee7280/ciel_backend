import { parseCiiV45Response } from './parse-cii-v4-5.util';
import { CII_V45_DIMENSIONS, computeCiiV45Result } from '../reports/cii-v4-5.constants';

function fullResponse() {
  return {
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
    sectionScores: CII_V45_DIMENSIONS.map((dim) => ({
      dimension: dim.id,
      criterionScores: dim.criteria.map(({ key }) => ({
        criterion: key,
        anchor: 2,
        qualityAnchor: 2,
        verificationStatus: 'VERIFIED',
        sourceRefs: ['s1'],
        evidenceIds: [],
        reasoningSummary: 'Sound.',
        deductionReason: null,
      })),
    })),
    deductionLedger: [],
    extraMileUplift: { assessmentStatus: 'ASSESSED', items: [] },
    integrityPenalty: { points: 0, issues: [] },
    exceptionalFeature: null,
    adminReviewReasons: [],
    strengths: ['Good attendance.'],
    developmentPriorities: ['Add a baseline.'],
    analysisSummary: 'Sound project.',
    evidenceSummary: 'Partially inspected.',
    studentFeedback: 'Good work.',
  };
}

describe('parseCiiV45Response', () => {
  it('parses a complete, well-formed response', () => {
    const result = parseCiiV45Response(JSON.stringify(fullResponse()));
    expect(result).not.toBeNull();
    expect(result!.frameworkVersion).toBe('5.0');
    expect(result!.reportId).toBe('report-1');
    expect(result!.sectionScores).toHaveLength(10);
    expect(result!.sectionScores.find((s) => s.dimension === '7')?.criterionScores.every((c) => c.anchor === 'P')).toBe(
      true,
    );
    expect(result!.adminEvidenceAssessment).toEqual({ status: 'PENDING' });
    expect(result!.extraMileUplift.assessmentStatus).toBe('PENDING_ADMIN');
  });

  it('parses JSON wrapped in a fenced code block', () => {
    const wrapped = '```json\n' + JSON.stringify(fullResponse()) + '\n```';
    expect(parseCiiV45Response(wrapped)).not.toBeNull();
  });

  it('parses v5.0.2 report-quality JSON without deductionLedger / inputCompleteness', () => {
    const response = fullResponse() as Record<string, unknown>;
    delete response.deductionLedger;
    delete response.inputCompleteness;
    delete response.claimInventory;
    delete response.evidenceAudit;
    delete response.integrityPenalty;
    delete response.exceptionalFeature;
    const result = parseCiiV45Response(JSON.stringify(response));
    expect(result).not.toBeNull();
    expect(result!.deductionLedger).toEqual([]);
    expect(result!.integrityPenalty).toEqual({ points: 0, issues: [] });
  });

  it('defaults exceptionalFeature to null when the v5.0.2 JSON omits it', () => {
    const response = fullResponse() as Record<string, unknown>;
    delete response.exceptionalFeature;
    const result = parseCiiV45Response(JSON.stringify(response));
    expect(result).not.toBeNull();
    expect(result!.exceptionalFeature).toBeNull();
  });

  it('accepts exceptionalFeature explicitly set to null', () => {
    const response = fullResponse();
    response.exceptionalFeature = null;
    expect(parseCiiV45Response(JSON.stringify(response))).not.toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseCiiV45Response('{not valid json')).toBeNull();
  });

  it('returns null for the wrong frameworkVersion', () => {
    const response = { ...fullResponse(), frameworkVersion: '4.2' };
    expect(parseCiiV45Response(JSON.stringify(response))).toBeNull();
  });

  it('forces a non-zero AI-asserted integrity penalty back to zero/empty on ingestion', () => {
    const response: Record<string, unknown> = fullResponse();
    response.integrityPenalty = {
      points: 7,
      issues: [{ origin: 'STUDENT', confirmed: true, reason: 'inflated hours', evidenceIds: [] }],
    };
    const result = parseCiiV45Response(JSON.stringify(response));
    expect(result!.integrityPenalty).toEqual({ points: 0, issues: [] });
  });

  it('coerces drifted claim/evidence rows so computeCiiV45Result does not fail Invalid claim inventory', () => {
    const response = fullResponse() as Record<string, unknown>;
    response.evidenceAudit = [
      {
        evidenceId: 'E1',
        privacy: 'restricted',
        material: 'true',
        processingStatus: 'not_inspected',
        claimIds: ['C1', 'missing'],
        supportStatus: 'PARTIAL',
      },
    ];
    response.claimInventory = [
      {
        claimId: 'C1',
        text: 'Repaint day happened.',
        material: 'true',
        evidenceIds: ['E1', 'ghost'],
        supportStatus: 'MATCH',
      },
      {
        id: 'C1',
        text: 'duplicate id',
        material: 1,
        supportStatus: 'partially supported',
      },
    ];
    const result = parseCiiV45Response(JSON.stringify(response));
    expect(result).not.toBeNull();
    expect(result!.claimInventory).toEqual([
      {
        claimId: 'C1',
        text: 'Repaint day happened.',
        material: true,
        evidenceIds: ['E1'],
        supportStatus: 'SUPPORTED',
      },
      {
        claimId: 'C1-2',
        text: 'duplicate id',
        material: true,
        evidenceIds: [],
        supportStatus: 'PARTIALLY_SUPPORTED',
      },
    ]);
    expect(result!.evidenceAudit[0]).toMatchObject({
      evidenceId: 'E1',
      privacy: 'RESTRICTED',
      material: true,
      processingStatus: 'INACCESSIBLE',
      claimIds: ['C1'],
      supportStatus: 'PARTIALLY_SUPPORTED',
    });
    expect(() => computeCiiV45Result(result!)).not.toThrow();
  });

  it('keeps an omitted criterion pending instead of rejecting the evaluation', () => {
    const response = fullResponse();
    response.sectionScores = response.sectionScores
      .filter((s) => s.dimension !== '7')
      .map((s) =>
        s.dimension === '1' ? { ...s, criterionScores: s.criterionScores.slice(0, 3) } : s,
      );
    const result = parseCiiV45Response(JSON.stringify(response));
    expect(result).not.toBeNull();
    const dim1 = result!.sectionScores.find((s) => s.dimension === '1')!;
    expect(dim1.criterionScores).toHaveLength(4);
    expect(dim1.criterionScores.some((c) => c.anchor === 'P')).toBe(true);
    expect(() => computeCiiV45Result(result!)).not.toThrow();
    expect(computeCiiV45Result(result!).scoreStatus).toBe('ADMIN_REVIEW_REQUIRED');
  });

  it('still parses when the model omits echo IDs and narrative arrays', () => {
    const response = fullResponse() as Record<string, unknown>;
    delete response.reportId;
    delete response.inputFingerprint;
    delete response.adminReviewReasons;
    delete response.strengths;
    delete response.developmentPriorities;
    delete response.analysisSummary;
    delete response.studentFeedback;
    const result = parseCiiV45Response(JSON.stringify(response));
    expect(result).not.toBeNull();
    expect(result!.reportId).toBe('pending');
    expect(result!.inputFingerprint).toBe('pending');
    expect(result!.strengths).toEqual([]);
    expect(() => computeCiiV45Result(result!)).not.toThrow();
  });
});

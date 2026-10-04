import { parseCiiV45Response } from './parse-cii-v4-5.util';
import { CII_V45_DIMENSIONS } from '../reports/cii-v4-5.constants';

function fullResponse() {
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
    expect(result!.frameworkVersion).toBe('4.5');
    expect(result!.reportId).toBe('report-1');
    expect(result!.sectionScores).toHaveLength(10);
  });

  it('parses JSON wrapped in a fenced code block', () => {
    const wrapped = '```json\n' + JSON.stringify(fullResponse()) + '\n```';
    expect(parseCiiV45Response(wrapped)).not.toBeNull();
  });

  it('returns null when a required key is missing (deductionLedger)', () => {
    const response = fullResponse() as Record<string, unknown>;
    delete response.deductionLedger;
    expect(parseCiiV45Response(JSON.stringify(response))).toBeNull();
  });

  it('returns null when a required key is missing (exceptionalFeature is absent, not just null)', () => {
    const response = fullResponse() as Record<string, unknown>;
    delete response.exceptionalFeature;
    expect(parseCiiV45Response(JSON.stringify(response))).toBeNull();
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
});

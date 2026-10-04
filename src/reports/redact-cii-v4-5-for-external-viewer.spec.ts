import { StudentReportsService } from './student-reports.service';

const redact = (StudentReportsService as any).redactCiiV45ForExternalViewer.bind(
  StudentReportsService,
);

const UNLOCKED_RESPONSE = {
  success: true,
  data: {
    id: 'report-1',
    ciiV45: {
      finalCII: 91.5,
      diagnosticCII: 91.5,
      finalBadge: { code: 'L6', name: 'Transformative Impact Contributor', level: 6, numericLevel: 6, gateCapped: false },
      recommendedBadge: { code: 'L6', name: 'Transformative Impact Contributor', level: 6, numericLevel: 6, gateCapped: false },
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
              sourceRefs: ['Section 7'],
              evidenceIds: ['E1'],
              reasoningSummary: 'private admin-facing rationale',
            },
          ],
        },
      ],
      claimInventory: [{ claimId: 'C1', text: 'private claim text', material: true, evidenceIds: ['E1'], supportStatus: 'SUPPORTED' }],
      evidenceAudit: [{ evidenceId: 'E1', actualContentSummary: 'private visible-content audit', processingStatus: 'INSPECTED', material: true, privacy: 'RESTRICTED', claimIds: ['C1'], supportStatus: 'SUPPORTED' }],
      extraMileUplift: { total: 2.5 },
      integrityPenalty: { points: 0, issues: [] },
      adminReviewReasons: [],
      strengths: ['Attendance register confirmed all hours across 4 sessions'],
      developmentPriorities: ['Add a baseline measure before delivery'],
      analysisSummary: 'private admin-facing summary',
      evidenceSummary: 'Evidence set supports the main claims.',
      studentFeedback: 'Great work overall.',
    },
    ciiV45Lock: null,
  },
};

describe('StudentReportsService.redactCiiV45ForExternalViewer', () => {
  it('strips the entire CII v4.5 evaluation before Admin has locked it', () => {
    const result = redact(UNLOCKED_RESPONSE);

    expect(result.data.ciiV45).toBeNull();
    expect(result.data.ciiV45Lock).toBeNull();
  });

  it('exposes only the curated outcome once locked — never per-criterion anchors/notes, claim text, evidence content summaries, or admin-review reasons', () => {
    const locked = {
      success: true,
      data: {
        ...UNLOCKED_RESPONSE.data,
        ciiV45Lock: {
          locked: true,
          hash: 'abc123',
          lockedAt: '2026-01-01T00:00:00.000Z',
          lockedByAdminId: 'admin-1',
        },
      },
    };

    const result = redact(locked);

    expect(result.data.ciiV45).toEqual({
      finalCII: 91.5,
      diagnosticCII: 91.5,
      finalBadge: { code: 'L6', name: 'Transformative Impact Contributor', level: 6, numericLevel: 6, gateCapped: false },
      recommendedBadge: { code: 'L6', name: 'Transformative Impact Contributor', level: 6, numericLevel: 6, gateCapped: false },
      sectionScores: [
        {
          dimension: '7',
          name: 'Evidence, Ethics & Verification',
          maximumPoints: 15,
          score: 13,
        },
      ],
      extraMileUplift: { total: 2.5 },
      integrityPenalty: { points: 0 },
      strengths: ['Attendance register confirmed all hours across 4 sessions'],
      developmentPriorities: ['Add a baseline measure before delivery'],
      studentFeedback: 'Great work overall.',
    });
    expect(result.data.ciiV45).not.toHaveProperty('claimInventory');
    expect(result.data.ciiV45).not.toHaveProperty('evidenceAudit');
    expect(result.data.ciiV45).not.toHaveProperty('adminReviewReasons');
    expect(result.data.ciiV45).not.toHaveProperty('analysisSummary');
    expect(result.data.ciiV45.sectionScores[0]).not.toHaveProperty('criterionScores');
    expect(result.data.ciiV45Lock).toEqual({
      locked: true,
      hash: 'abc123',
      lockedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.data.ciiV45Lock).not.toHaveProperty('lockedByAdminId');
  });

  it('passes through responses that have no data untouched', () => {
    const response = { success: false };
    expect(redact(response)).toBe(response);
  });
});

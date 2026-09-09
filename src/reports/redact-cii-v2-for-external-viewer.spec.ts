import { StudentReportsService } from './student-reports.service';

const redact = (StudentReportsService as any).redactCiiV2ForExternalViewer.bind(
  StudentReportsService,
);

const UNLOCKED_RESPONSE = {
  success: true,
  data: {
    id: 'report-1',
    ciiV2: {
      final: 91.5,
      level: { level: 6, name: 'Distinguished Impact Contributor' },
      evidenceAverage: 88,
      sections: [
        {
          id: 7,
          title: 'Evidence, Verification & Integrity',
          weight: 15,
          score: 13,
          good: 'Strong evidence base',
          limit: 'Follow-up window is short',
          criteria: [
            { key: 'ethics_integrity', anchor: 4, note: 'AI-only rationale' },
          ],
        },
      ],
      bonusWhy: { effort: 'private faculty-facing rationale' },
      integrityWhy: 'private faculty-facing rationale',
      redFlags: ['possible inflation in beneficiary count'],
      needsAdminReview: true,
      studentFeedback: 'Great work overall.',
    },
    ciiV2Lock: null,
  },
};

describe('StudentReportsService.redactCiiV2ForExternalViewer', () => {
  it('strips the entire CII v2 evaluation before Faculty has locked it', () => {
    const result = redact(UNLOCKED_RESPONSE);

    expect(result.data.ciiV2).toBeNull();
    expect(result.data.ciiV2Lock).toBeNull();
  });

  it('exposes only the curated outcome once locked — never per-criterion anchors/notes, red flags, or admin-review flags', () => {
    const locked = {
      success: true,
      data: {
        ...UNLOCKED_RESPONSE.data,
        ciiV2Lock: {
          locked: true,
          hash: 'abc123',
          lockedAt: '2026-01-01T00:00:00.000Z',
          lockedByFacultyId: 'faculty-1',
        },
      },
    };

    const result = redact(locked);

    expect(result.data.ciiV2).toEqual({
      final: 91.5,
      level: { level: 6, name: 'Distinguished Impact Contributor' },
      evidenceAverage: 88,
      sections: [
        {
          id: 7,
          title: 'Evidence, Verification & Integrity',
          weight: 15,
          score: 13,
        },
      ],
    });
    expect(result.data.ciiV2).not.toHaveProperty('redFlags');
    expect(result.data.ciiV2).not.toHaveProperty('needsAdminReview');
    expect(result.data.ciiV2).not.toHaveProperty('integrityWhy');
    expect(result.data.ciiV2).not.toHaveProperty('bonusWhy');
    expect(result.data.ciiV2.sections[0]).not.toHaveProperty('criteria');
    expect(result.data.ciiV2.sections[0]).not.toHaveProperty('good');
    expect(result.data.ciiV2Lock).toEqual({
      locked: true,
      hash: 'abc123',
      lockedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.data.ciiV2Lock).not.toHaveProperty('lockedByFacultyId');
  });

  it('passes through responses that have no data untouched', () => {
    const response = { success: false };
    expect(redact(response)).toBe(response);
  });
});

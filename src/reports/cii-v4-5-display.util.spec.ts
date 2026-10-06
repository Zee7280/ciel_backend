import {
  pickCiiV45DisplayBadge,
  pickCiiV45DisplayScore,
} from './cii-v4-5-display.util';

describe('pickCiiV45DisplayScore', () => {
  it('prefers the locked admin-approved score over diagnostic', () => {
    expect(
      pickCiiV45DisplayScore(
        { diagnosticCII: 80, finalCII: 75 },
        { locked: true, adminApprovedScore: 75 },
      ),
    ).toBe(75);
  });

  it('uses diagnostic/base while unlocked so reviewers still see an overall', () => {
    expect(
      pickCiiV45DisplayScore(
        { diagnosticCII: null, baseCII: 70, knownBasePoints: 62 },
        { locked: false },
      ),
    ).toBe(70);
    expect(
      pickCiiV45DisplayScore(
        { diagnosticCII: null, baseCII: null, knownBasePoints: 62 },
        null,
      ),
    ).toBe(62);
  });

  it('uses knownBasePoints as the reviewer overall when diagnosticCII is null', () => {
    expect(
      pickCiiV45DisplayScore(
        { diagnosticCII: null, baseCII: null, knownBasePoints: 60.3 },
        { locked: false },
      ),
    ).toBe(60.3);
  });

  it('shows the AI report score while Admin evidence is still pending', () => {
    expect(
      pickCiiV45DisplayScore(
        {
          diagnosticCII: null,
          baseCII: null,
          knownBasePoints: 59.5,
          aiReportScore: 59.5,
          adminEvidenceAssessment: { status: 'PENDING' },
        },
        null,
      ),
    ).toBe(59.5);
  });

  it('does not invent a score when the analyser has not produced numbers', () => {
    expect(pickCiiV45DisplayScore(null, null)).toBeNull();
    expect(pickCiiV45DisplayScore({ diagnosticCII: null, baseCII: null }, null)).toBeNull();
  });
});

describe('pickCiiV45DisplayBadge', () => {
  it('uses the final badge after lock and the diagnostic badge before', () => {
    const cii = {
      finalBadge: { name: 'Published', level: 4 },
      diagnosticBadge: { name: 'Provisional', level: 3 },
    };
    expect(pickCiiV45DisplayBadge(cii, { locked: true })?.name).toBe('Published');
    expect(pickCiiV45DisplayBadge(cii, { locked: false })?.name).toBe('Provisional');
  });

  it('keeps the diagnostic badge while Admin evidence is still pending', () => {
    expect(
      pickCiiV45DisplayBadge(
        {
          diagnosticBadge: { name: 'Sound Community Contributor', level: 3 },
          recommendedBadge: { name: 'Sound Community Contributor', level: 3 },
          adminEvidenceAssessment: { status: 'PENDING' },
        },
        null,
      )?.name,
    ).toBe('Sound Community Contributor');
  });
});

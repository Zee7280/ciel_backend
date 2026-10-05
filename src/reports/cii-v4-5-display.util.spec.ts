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
});

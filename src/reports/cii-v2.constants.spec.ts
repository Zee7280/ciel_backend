import {
  CII_V2_BASE_MAX,
  CII_V2_BONUS_MAX,
  CII_V2_SECTIONS,
  clampBonusAmount,
  computeCiiV2Result,
  levelFor,
  numericLevelFor,
  qualityGateCap,
} from './cii-v2.constants';

function allAnchors(anchor: number) {
  return CII_V2_SECTIONS.map((s) => ({
    id: s.id,
    criteria: s.criteria.map((c) => ({ key: c.key, anchor })),
  }));
}

describe('CII v2 — section weights', () => {
  it('sums to the documented 94 base points and 6 bonus points', () => {
    expect(CII_V2_BASE_MAX).toBe(94);
    expect(CII_V2_BONUS_MAX).toBe(6);
    for (const section of CII_V2_SECTIONS) {
      const criteriaSum = section.criteria.reduce(
        (sum, c) => sum + c.weight,
        0,
      );
      expect(criteriaSum).toBeCloseTo(section.weight, 5);
    }
  });
});

describe('CII v2 — computeCiiV2Result', () => {
  it('scores all-4 anchors with full bonus and no penalty as a perfect 100 / Level 7', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(4),
      bonus: { effort: 2, resources: 2, partners: 2 },
      integrityPenalty: 0,
    });

    expect(result.base).toBe(94);
    expect(result.bonus.total).toBe(6);
    expect(result.final).toBe(100);
    expect(result.level.level).toBe(7);
  });

  it('scores all-0 anchors as a 0 / Level 1', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(0),
      bonus: { effort: 0, resources: 0, partners: 0 },
      integrityPenalty: 0,
    });

    expect(result.final).toBe(0);
    expect(result.level.level).toBe(1);
  });

  it('caps bonus total at 6 even if channels sum higher', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(2),
      bonus: { effort: 2, resources: 2, partners: 2 },
      integrityPenalty: 0,
    });

    expect(result.bonus.total).toBe(6);
  });

  it('clamps final score at 0 even with a penalty larger than the base+bonus', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(0),
      bonus: { effort: 0, resources: 0, partners: 0 },
      integrityPenalty: 999,
    });

    expect(result.final).toBe(0);
  });

  it('never lets the badge level exceed what the quality gates allow, even at a high numeric score', () => {
    // High anchors everywhere except Section 7 (evidence) and Section 9 (sustainability) are weak —
    // numeric score can still land in the Level 7 band, but the gate must cap it.
    const sections = allAnchors(4).map((s) =>
      s.id === 7 || s.id === 9
        ? { ...s, criteria: s.criteria.map((c) => ({ ...c, anchor: 0 })) }
        : s,
    );
    const result = computeCiiV2Result({
      sections,
      bonus: { effort: 2, resources: 2, partners: 2 },
      integrityPenalty: 0,
    });

    expect(numericLevelFor(result.final).level).toBeGreaterThan(
      result.level.level,
    );
    expect(result.level.level).toBeLessThanOrEqual(4);
    expect(result.gateExplanation).toMatch(/capped at Level/);
  });

  it('caps the badge at Level 4 once the integrity penalty reaches 6, regardless of score', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(4),
      bonus: { effort: 2, resources: 2, partners: 2 },
      integrityPenalty: 6,
    });

    expect(
      qualityGateCap({
        base: result.base,
        section4Score: 32,
        section7Score: 15,
        section9Score: 6,
        integrityPenalty: 6,
      }),
    ).toBe(4);
    expect(result.level.level).toBeLessThanOrEqual(4);
  });
});

describe('CII v2 — clampBonusAmount', () => {
  it('clamps to [0, max]', () => {
    expect(clampBonusAmount(-1, 2)).toBe(0);
    expect(clampBonusAmount(5, 2)).toBe(2);
    expect(clampBonusAmount(1.5, 2)).toBe(1.5);
  });
});

describe('CII v2 — levelFor', () => {
  it('never returns a level above the gate cap', () => {
    expect(levelFor(99, 4).level).toBe(4);
    expect(levelFor(40, 7).level).toBe(1); // numeric band still wins when it is lower than the cap
  });
});

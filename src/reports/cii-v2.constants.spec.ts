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

describe('CII v3.1 — section weights', () => {
  it('sums to the documented 100 base points and 5 Extra-Mile points', () => {
    expect(CII_V2_BASE_MAX).toBe(100);
    expect(CII_V2_BONUS_MAX).toBe(5);
    for (const section of CII_V2_SECTIONS) {
      const criteriaSum = section.criteria.reduce(
        (sum, c) => sum + c.weight,
        0,
      );
      expect(criteriaSum).toBeCloseTo(section.weight, 5);
    }
  });
});

describe('CII v3.1 — computeCiiV2Result', () => {
  it('scores all-4 anchors with full Extra-Mile and no penalty as 100 / Level 7', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(4),
      bonus: { effort: 1.25, resources: 1.25, partners: 1.25, outcome: 1.25 },
      integrityPenalty: 0,
    });

    expect(result.base).toBe(100);
    expect(result.bonus.total).toBe(5);
    expect(result.final).toBe(100);
    expect(result.level.level).toBe(7);
  });

  it('scores all-0 anchors as a 0 / Level 1', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(0),
      bonus: { effort: 0, resources: 0, partners: 0, outcome: 0 },
      integrityPenalty: 0,
    });

    expect(result.final).toBe(0);
    expect(result.level.level).toBe(1);
  });

  it('applies Sound (anchor 2) at 65% of criterion weight', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(2),
      bonus: { effort: 0, resources: 0, partners: 0, outcome: 0 },
      integrityPenalty: 0,
    });

    expect(result.base).toBeCloseTo(65, 1);
  });

  it('caps Extra-Mile total at 5 even if channels sum higher', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(2),
      bonus: { effort: 1.25, resources: 1.25, partners: 1.25, outcome: 1.25 },
      integrityPenalty: 0,
    });

    expect(result.bonus.total).toBe(5);
  });

  it('clamps final score at 0 even with a penalty larger than the base+bonus', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(0),
      bonus: { effort: 0, resources: 0, partners: 0, outcome: 0 },
      integrityPenalty: 999,
    });

    expect(result.final).toBe(0);
  });

  it('caps the badge when evidence/outcome gates are weak', () => {
    // Keep numeric score high (Level 5+) but starve Sections 5/8 so Level-5+ gates fail.
    const sections = allAnchors(4).map((s) =>
      s.id === 5 || s.id === 8
        ? { ...s, criteria: s.criteria.map((c) => ({ ...c, anchor: 1 })) }
        : s,
    );
    const result = computeCiiV2Result({
      sections,
      bonus: { effort: 1.25, resources: 1.25, partners: 1.25, outcome: 1.25 },
      integrityPenalty: 0,
    });

    expect(result.numericLevel).toBeGreaterThan(4);
    expect(result.level.level).toBeLessThanOrEqual(4);
    expect(result.gateExplanation).toMatch(/capped at Level/);
  });

  it('caps the badge at Level 4 once the integrity penalty reaches 5+, regardless of score', () => {
    const result = computeCiiV2Result({
      sections: allAnchors(4),
      bonus: { effort: 1.25, resources: 1.25, partners: 1.25, outcome: 1.25 },
      integrityPenalty: 5,
    });

    expect(
      qualityGateCap({
        base: result.base,
        section4Score: 15,
        section5Score: 15,
        section8Score: 15,
        section10Score: 7,
        integrityPenalty: 5,
      }),
    ).toBe(4);
    expect(result.level.level).toBeLessThanOrEqual(4);
  });
});

describe('CII v3.1 — clampBonusAmount', () => {
  it('clamps to [0, max]', () => {
    expect(clampBonusAmount(-1, 1.25)).toBe(0);
    expect(clampBonusAmount(9, 1.25)).toBe(1.25);
    expect(clampBonusAmount(0.5, 1.25)).toBe(0.5);
  });
});

describe('CII v3.1 — level helpers', () => {
  it('maps numeric bands', () => {
    expect(numericLevelFor(92).level).toBe(7);
    expect(levelFor(92, 5).level).toBe(5);
  });
});

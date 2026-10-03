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

describe('CII v3.1 — legacy 9-section remap', () => {
  const legacyNineSectionAllFours = [
    {
      id: 1,
      criteria: [
        { key: 'role_clarity', anchor: 4 },
        { key: 'participation_quality', anchor: 4 },
        { key: 'attendance_consistency', anchor: 4 },
        { key: 'engagement_continuity', anchor: 4 },
      ],
    },
    {
      id: 2,
      criteria: [
        { key: 'need_specificity', anchor: 4 },
        { key: 'beneficiary_voice', anchor: 4 },
        { key: 'baseline_evidence', anchor: 4 },
        { key: 'contextual_understanding', anchor: 4 },
        { key: 'disciplinary_lens', anchor: 4 },
      ],
    },
    {
      id: 3,
      criteria: [
        { key: 'sdg_alignment', anchor: 4 },
        { key: 'contribution_logic', anchor: 4 },
        { key: 'activity_output_outcome_alignment', anchor: 4 },
        { key: 'sdg_restraint', anchor: 4 },
      ],
    },
    {
      id: 4,
      criteria: [
        { key: 'planned_vs_actual', anchor: 4 },
        { key: 'delivery_rigor', anchor: 4 },
        { key: 'execution_ownership', anchor: 4 },
        { key: 'output_counting_integrity', anchor: 4 },
        { key: 'depth_or_scale', anchor: 4 },
        { key: 'measurable_outcomes', anchor: 4 },
        { key: 'beneficiary_value', anchor: 4 },
        { key: 'adaptation_honesty', anchor: 4 },
      ],
    },
    {
      id: 5,
      criteria: [
        { key: 'resource_stewardship', anchor: 4 },
        { key: 'resource_traceability', anchor: 4 },
        { key: 'resource_appropriateness', anchor: 4 },
        { key: 'resource_delivery_link', anchor: 4 },
      ],
    },
    {
      id: 6,
      criteria: [
        { key: 'stakeholder_relevance', anchor: 4 },
        { key: 'stakeholder_role_clarity', anchor: 4 },
        { key: 'collaboration_quality', anchor: 4 },
        { key: 'verification_ownership', anchor: 4 },
      ],
    },
    {
      id: 7,
      criteria: [
        { key: 'evidence_participation', anchor: 4 },
        { key: 'evidence_activities', anchor: 4 },
        { key: 'evidence_beneficiaries', anchor: 4 },
        { key: 'evidence_outcomes', anchor: 4 },
        { key: 'evidence_resource_traceability', anchor: 4 },
        { key: 'ethics_integrity', anchor: 4 },
      ],
    },
    {
      id: 8,
      criteria: [
        { key: 'personal_learning', anchor: 4 },
        { key: 'academic_application', anchor: 4 },
        { key: 'ethical_understanding', anchor: 4 },
        { key: 'self_awareness', anchor: 4 },
      ],
    },
    {
      id: 9,
      criteria: [
        { key: 'continuation_assessment', anchor: 4 },
        { key: 'named_ownership', anchor: 4 },
        { key: 'continuation_mechanism', anchor: 4 },
        { key: 'scaling_realism', anchor: 4 },
      ],
    },
  ];

  it('does not collapse a full-marks v2 payload to ~36 after the v3.1 rubric shift', () => {
    const result = computeCiiV2Result({
      sections: legacyNineSectionAllFours,
      bonus: { effort: 1.25, resources: 1.25, partners: 1.25, outcome: 1.25 },
      integrityPenalty: 0,
    });

    expect(result.final).toBeGreaterThanOrEqual(95);
    expect(result.base).toBeGreaterThanOrEqual(95);
    expect(result.sections).toHaveLength(10);
    expect(result.sections.find((s) => s.id === 5)?.score).toBeGreaterThan(10);
    expect(result.sections.find((s) => s.id === 10)?.score).toBeGreaterThan(5);
  });

  it('does not remap a live v3.1 payload that only omitted section 10', () => {
    const sections = CII_V2_SECTIONS.filter((s) => s.id !== 10).map((s) => ({
      id: s.id,
      criteria: s.criteria.map((c) => ({ key: c.key, anchor: 4 })),
    }));
    const result = computeCiiV2Result({
      sections,
      bonus: { effort: 0, resources: 0, partners: 0, outcome: 0 },
      integrityPenalty: 0,
    });

    expect(result.sections.find((s) => s.id === 5)?.key).toBe('outcomes');
    expect(result.sections.find((s) => s.id === 6)?.key).toBe('resources');
    expect(result.sections.find((s) => s.id === 5)?.score).toBe(15);
    expect(result.sections.find((s) => s.id === 10)?.score).toBe(0);
  });
});

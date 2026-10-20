import {
  npeCalculate,
  npeCiiAnchor,
  npePercentile,
  npeRankPool,
} from './npe-ranking.scoring';
import type { NpeCriterionJudgment } from './npe-ranking.scoring';
import {
  NPE_CRITERIA,
  NPE_CRITERION_KEYS,
  NPE_RUBRIC_VERSION,
  NPE_WEIGHT_PROFILES,
  npeCriteriaFor,
} from './npe-ranking.constants';

function judgment(
  anchor: number,
  confidence: NpeCriterionJudgment['confidence'] = 'high',
): NpeCriterionJudgment {
  return { anchor, confidence, reason: 'test', claimIds: ['c1'] };
}

function all(
  anchor: number,
  confidence: NpeCriterionJudgment['confidence'] = 'high',
) {
  return Object.fromEntries(
    NPE_CRITERION_KEYS.map((k) => [k, judgment(anchor, confidence)]),
  ) as Record<(typeof NPE_CRITERION_KEYS)[number], NpeCriterionJudgment>;
}

describe('npe-ranking.scoring', () => {
  it('every rubric version sums to exactly 100 (CII weight + eight criteria)', () => {
    for (const [version, profile] of Object.entries(NPE_WEIGHT_PROFILES)) {
      const total =
        profile.ciiWeight +
        Object.values(profile.criteria).reduce((sum, w) => sum + w, 0);
      expect({ version, total }).toEqual({ version, total: 100 });
    }
  });

  it('the current rubric is NPE-1.2: eight criteria worth 90 + locked CII worth 10', () => {
    expect(NPE_RUBRIC_VERSION).toBe('NPE-1.2');
    expect(NPE_CRITERIA.reduce((sum, row) => sum + row.weight, 0)).toBe(90);
    expect(NPE_CRITERIA.map((c) => [c.key, c.weight])).toEqual([
      ['impact', 22],
      ['need', 13],
      ['sustain', 9],
      ['partner', 9],
      ['efficiency', 9],
      ['sdg', 9],
      ['scale', 9],
      ['learning', 10],
    ]);
    expect(
      npeCriteriaFor('NPE-1.1').reduce((sum, row) => sum + row.weight, 0),
    ).toBe(85);
    // unknown versions never throw: they score with the current weighting
    expect(
      npeCriteriaFor('NPE-9.9').reduce((sum, row) => sum + row.weight, 0),
    ).toBe(90);
  });

  it('caps locked CII at its weight even when stored CII is 110 (10 under NPE-1.2, 15 under NPE-1.1)', () => {
    expect(npeCiiAnchor(110)).toBe(10);
    expect(npeCiiAnchor(100)).toBe(10);
    expect(npeCiiAnchor(80)).toBe(8);
    expect(npeCiiAnchor(110, 'NPE-1.1')).toBe(15);
    expect(npeCiiAnchor(80, 'NPE-1.1')).toBe(12);
  });

  it('NPE-1.2: perfect anchors with full evidence and CII 100 score exactly 100', () => {
    expect(npeCalculate(100, all(5, 'high')).total).toBe(100);
  });

  it('NPE-1.2 matches the Ranking Studio formula: sum(weight * anchor/5) + 10% of CII', () => {
    const anchors = {
      impact: 4.5,
      need: 4,
      sustain: 3.5,
      partner: 3,
      efficiency: 4,
      sdg: 4.5,
      scale: 3,
      learning: 4,
    };
    const criteria = Object.fromEntries(
      Object.entries(anchors).map(([k, a]) => [k, judgment(a, 'high')]),
    ) as Record<(typeof NPE_CRITERION_KEYS)[number], NpeCriterionJudgment>;
    const studio =
      22 * (4.5 / 5) +
      13 * (4 / 5) +
      9 * (3.5 / 5) +
      9 * (3 / 5) +
      9 * (4 / 5) +
      9 * (4.5 / 5) +
      9 * (3 / 5) +
      10 * (4 / 5) +
      82 * 0.1;
    expect(npeCalculate(82, criteria).total).toBe(
      Math.round(studio * 100) / 100,
    );
  });

  it('applies evidence factor per criterion, not as a blanket multiplier', () => {
    const criteria = all(5, 'high');
    criteria.sustain = judgment(5, 'unsupported');
    const scored = npeCalculate(100, criteria);
    expect(scored.criteria.sustain).toBe(0);
    expect(scored.criteria.impact).toBe(22);
    expect(scored.total).toBe(91);
    // the same judgments under the original weighting keep their original marks
    const legacy = npeCalculate(100, criteria, 'NPE-1.1');
    expect(legacy.criteria.impact).toBe(25);
    expect(legacy.total).toBe(88);
  });

  it('uses competition ranking and ignores id for ties', () => {
    const ranked = npeRankPool([
      { id: 'b', total: 90, impact: 20, sustain: 10, cii: 90 },
      { id: 'a', total: 90, impact: 20, sustain: 10, cii: 90 },
      { id: 'c', total: 80, impact: 18, sustain: 9, cii: 80 },
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it('returns null percentile for a cohort of one', () => {
    expect(npePercentile(1, 1)).toBeNull();
    expect(npePercentile(1, 5)).toBe(100);
  });

  it('matches the HTML NPE-1.1 calculator for DEMO-01 (CII 94, per-criterion evidence)', () => {
    const criteria = {
      impact: judgment(4.6, 'high'),
      need: judgment(4.6, 'high'),
      sustain: judgment(4.5, 'high'),
      partner: judgment(4.5, 'high'),
      efficiency: judgment(4.2, 'high'),
      sdg: judgment(4.5, 'high'),
      scale: judgment(4, 'moderate'),
      learning: judgment(4.5, 'high'),
    };
    const scored = npeCalculate(94, criteria, 'NPE-1.1');
    // HTML: min(cii,100)*0.15 + sum(weight * anchor/5 * factor); round total once.
    expect(scored.cii).toBeCloseTo(14.1, 10);
    expect(scored.criteria.impact).toBeCloseTo(23, 10);
    expect(scored.criteria.scale).toBeCloseTo(4.32, 10);
    expect(scored.criteria.sustain).toBeCloseTo(10.8, 10);
    expect(scored.total).toBe(89.78);
  });

  it('does not let a weak continuation criterion change verified outcome marks', () => {
    const criteria = {
      impact: judgment(5, 'high'),
      need: judgment(4, 'high'),
      sustain: judgment(1, 'low'),
      partner: judgment(4, 'high'),
      efficiency: judgment(4, 'high'),
      sdg: judgment(4, 'high'),
      scale: judgment(3, 'moderate'),
      learning: judgment(4, 'high'),
    };
    const scored = npeCalculate(80, criteria, 'NPE-1.1');
    expect(scored.criteria.impact).toBe(25);
    expect(scored.criteria.sustain).toBeCloseTo(1.8, 10);
  });
});

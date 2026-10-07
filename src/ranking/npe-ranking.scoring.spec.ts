import { npeCalculate, npeCiiAnchor, npePercentile, npeRankPool } from './npe-ranking.scoring';
import type { NpeCriterionJudgment } from './npe-ranking.scoring';
import { NPE_CRITERIA, NPE_CRITERION_KEYS } from './npe-ranking.constants';

function judgment(
  anchor: number,
  confidence: NpeCriterionJudgment['confidence'] = 'high',
): NpeCriterionJudgment {
  return { anchor, confidence, reason: 'test', claimIds: ['c1'] };
}

function all(anchor: number, confidence: NpeCriterionJudgment['confidence'] = 'high') {
  return Object.fromEntries(
    NPE_CRITERION_KEYS.map((k) => [k, judgment(anchor, confidence)]),
  ) as Record<(typeof NPE_CRITERION_KEYS)[number], NpeCriterionJudgment>;
}

describe('npe-ranking.scoring', () => {
  it('keeps the NPE-1.1 15 + 85 split', () => {
    expect(NPE_CRITERIA.reduce((sum, row) => sum + row.weight, 0)).toBe(85);
  });

  it('caps locked CII at 15 even when stored CII is 110', () => {
    expect(npeCiiAnchor(110)).toBe(15);
    expect(npeCiiAnchor(100)).toBe(15);
    expect(npeCiiAnchor(80)).toBe(12);
  });

  it('applies evidence factor per criterion, not as a blanket multiplier', () => {
    const criteria = all(5, 'high');
    criteria.sustain = judgment(5, 'unsupported');
    const scored = npeCalculate(100, criteria);
    expect(scored.criteria.sustain).toBe(0);
    expect(scored.criteria.impact).toBe(25);
    expect(scored.total).toBe(88);
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
    const scored = npeCalculate(94, criteria);
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
    const scored = npeCalculate(80, criteria);
    expect(scored.criteria.impact).toBe(25);
    expect(scored.criteria.sustain).toBeCloseTo(1.8, 10);
  });
});

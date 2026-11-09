import { applyCriterionOverrides } from './npe-overrides.util';
import { npeCalculate } from './npe-ranking.scoring';
import { NPE_CRITERIA, npeMethodFamily } from './npe-ranking.constants';
import { studioSignature } from './npe-studio.util';
import type { NpeCriterionJudgment } from './npe-ranking.scoring';

function judgments(anchor = 3): Record<string, NpeCriterionJudgment> {
  return Object.fromEntries(
    NPE_CRITERIA.map((c) => [
      c.key,
      { anchor, confidence: 'high', reason: 'ok', claimIds: [] },
    ]),
  );
}

describe('NPE-1.3 Admin criterion corrections', () => {
  it('lays a correction over the AI anchor without mutating the AI judgment, keeping its confidence', () => {
    const ai = judgments(3);
    const out = applyCriterionOverrides(
      ai,
      [
        {
          id: 'o1',
          criterion: 'impact',
          anchor: 5,
          packageVersion: 'v1',
          locator: 'EV-3 p.2',
          reason: 'Endline table overlooked',
        },
      ],
      'v1',
    );
    expect(out.criteria.impact.anchor).toBe(5);
    expect(out.criteria.impact.confidence).toBe('high');
    expect(ai.impact.anchor).toBe(3);
    expect(out.applied).toEqual([
      expect.objectContaining({
        id: 'o1',
        criterion: 'impact',
        anchor: 5,
        aiAnchor: 3,
        locator: 'EV-3 p.2',
      }),
    ]);
    expect(out.stale).toEqual([]);
  });

  it('ignores corrections made for another package version (reported as stale) and unknown criteria', () => {
    const out = applyCriterionOverrides(
      judgments(2),
      [
        { id: 'a', criterion: 'need', anchor: 4, packageVersion: 'old' },
        { id: 'b', criterion: 'bogus', anchor: 4, packageVersion: 'v1' },
      ],
      'v1',
    );
    expect(out.criteria.need.anchor).toBe(2);
    expect(out.stale).toEqual(['need']);
    expect(out.applied).toEqual([]);
  });

  it('never credits an unsupported criterion through a correction and clamps anchors to 0–5', () => {
    const ai = judgments(2);
    ai.sdg = { ...ai.sdg, confidence: 'unsupported' };
    const out = applyCriterionOverrides(
      ai,
      [
        { id: 'a', criterion: 'sdg', anchor: 5, packageVersion: 'v1' },
        { id: 'b', criterion: 'scale', anchor: 9, packageVersion: 'v1' },
      ],
      'v1',
    );
    expect(out.criteria.sdg.anchor).toBe(2);
    expect(out.criteria.scale.anchor).toBe(5);
    expect(out.applied.map((a) => a.criterion)).toEqual(['scale']);
  });

  it('a corrected anchor changes the comparator exactly by weight × Δanchor/5 (CII untouched)', () => {
    const ai = judgments(3);
    const before = npeCalculate(80, ai as never, 'NPE-1.3');
    const corrected = applyCriterionOverrides(
      ai,
      [{ id: 'a', criterion: 'impact', anchor: 5, packageVersion: 'v1' }],
      'v1',
    ).criteria;
    const after = npeCalculate(80, corrected as never, 'NPE-1.3');
    expect(after.cii).toBe(before.cii);
    expect(after.total - before.total).toBeCloseTo(22 * (2 / 5), 6);
  });
});

describe('NPE-1.3 method family', () => {
  it('NPE-1.3 and NPE-1.2 are the same ranking (revision chain continues); NPE-1.1 is not', () => {
    expect(npeMethodFamily('NPE-1.3')).toBe('NPE-1.2');
    expect(npeMethodFamily('NPE-1.2')).toBe('NPE-1.2');
    expect(npeMethodFamily('NPE-1.1')).toBe('NPE-1.1');
    const sig = (v: string) =>
      studioSignature(
        'excellence' as never,
        'project' as never,
        { year: '2026' } as never,
        null,
        v,
      );
    expect(sig('NPE-1.3')).toBe(sig('NPE-1.2'));
    expect(sig('NPE-1.3')).not.toBe(sig('NPE-1.1'));
  });
});

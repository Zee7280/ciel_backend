import { applyMetricDelta, summaryKeysFor } from './summaries.util';
import { validateMetricValues } from '../metrics/metric-catalog.service';
import { ExternalMetricCatalog } from '../entities';

function def(
  code: string,
  over: Partial<ExternalMetricCatalog> = {},
): ExternalMetricCatalog {
  return {
    code,
    unit: 'count',
    dataType: 'integer',
    aggregation: 'sum',
    defaultClassification: 'observed',
    minValue: '0',
    maxValue: null,
    active: true,
    ...over,
  } as ExternalMetricCatalog;
}

describe('summaries', () => {
  const catalog = new Map([
    ['trees_planted', def('trees_planted')],
    [
      'survival_rate',
      def('survival_rate', {
        aggregation: 'latest',
        dataType: 'number',
        unit: 'percent',
      }),
    ],
  ]);

  it('produces connection, type, activity and monthly keys', () => {
    const keys = summaryKeysFor({
      activityType: 'plantation',
      externalActivityId: 'p-1',
      occurredOn: '2026-11-03',
    });
    expect(keys).toEqual([
      { scopeKey: 'connection', period: 'all' },
      { scopeKey: 'type:plantation', period: 'all' },
      { scopeKey: 'activity:p-1', period: 'all' },
      { scopeKey: 'connection', period: '2026-11' },
      { scopeKey: 'type:plantation', period: '2026-11' },
    ]);
  });

  it('corrects 40 → 32 trees by subtracting the old version and adding the new', () => {
    let totals = applyMetricDelta(
      {},
      [{ code: 'trees_planted', value: 40 }],
      catalog,
      1,
    );
    expect(totals.trees_planted).toBe(40);
    totals = applyMetricDelta(
      totals,
      [{ code: 'trees_planted', value: 40 }],
      catalog,
      -1,
    );
    totals = applyMetricDelta(
      totals,
      [{ code: 'trees_planted', value: 32 }],
      catalog,
      1,
    );
    expect(totals.trees_planted).toBe(32);
    totals = applyMetricDelta(
      totals,
      [{ code: 'survival_rate', value: 87.5 }],
      catalog,
      1,
    );
    expect(totals.survival_rate).toBe(87.5);
    totals = applyMetricDelta(
      totals,
      [{ code: 'survival_rate', value: 87.5 }],
      catalog,
      -1,
    );
    expect(totals.survival_rate).toBe(87.5);
  });
});

describe('validateMetricValues', () => {
  const catalog = new Map([
    ['trees_planted', def('trees_planted', { maxValue: '100000' })],
    ['retired_metric', def('retired_metric', { active: false })],
  ]);

  it('normalizes unit and classification from the catalog', () => {
    const r = validateMetricValues(
      [{ code: 'trees_planted', value: 40 }],
      catalog,
    );
    expect(r).toEqual({
      ok: true,
      metrics: [
        {
          code: 'trees_planted',
          value: 40,
          unit: 'count',
          classification: 'observed',
        },
      ],
    });
  });

  it('rejects unknown, inactive, repeated, non-integer and out-of-range values', () => {
    const r = validateMetricValues(
      [
        { code: 'nope', value: 1 },
        { code: 'retired_metric', value: 1 },
        { code: 'trees_planted', value: 1.5 },
        { code: 'trees_planted', value: 200000 },
        { code: 'trees_planted', value: -1 },
      ],
      catalog,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(5);
    }
  });
});

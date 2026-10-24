import { ExternalMetricCatalog, ExternalMetricValue } from '../entities';

export type SummaryKey = { scopeKey: string; period: string };

/** The summary rows one record contributes to (design §10: targeted updates, no full recompute). */
export function summaryKeysFor(record: {
  activityType: string;
  externalActivityId: string;
  occurredOn: string | null;
}): SummaryKey[] {
  const month = record.occurredOn ? record.occurredOn.slice(0, 7) : null;
  const keys: SummaryKey[] = [
    { scopeKey: 'connection', period: 'all' },
    { scopeKey: `type:${record.activityType}`, period: 'all' },
    { scopeKey: `activity:${record.externalActivityId}`, period: 'all' },
  ];
  if (month) {
    keys.push({ scopeKey: 'connection', period: month });
    keys.push({ scopeKey: `type:${record.activityType}`, period: month });
  }
  return keys;
}

/**
 * Applies metric values to a totals map. `sum` metrics add or subtract; `latest` metrics are set
 * on add and left alone on subtract; average / unique_count / non_additive are not totaled (they
 * are shown per record). Returns a new object.
 */
export function applyMetricDelta(
  totals: Record<string, number>,
  metrics: ExternalMetricValue[],
  catalog: Map<string, Pick<ExternalMetricCatalog, 'aggregation'>>,
  sign: 1 | -1,
): Record<string, number> {
  const out: Record<string, number> = { ...totals };
  for (const m of metrics) {
    const agg = catalog.get(m.code)?.aggregation ?? 'sum';
    if (agg === 'sum') {
      const next = (out[m.code] ?? 0) + sign * m.value;
      out[m.code] = Math.abs(next) < 1e-9 ? 0 : Number(next.toFixed(6));
    } else if (agg === 'latest' && sign === 1) {
      out[m.code] = m.value;
    }
  }
  return out;
}

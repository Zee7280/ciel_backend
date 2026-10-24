import { ExternalPlatform, ExternalPlatformSettings } from './entities';

export const HUB_DEFAULT_SETTINGS: Required<ExternalPlatformSettings> = {
  rate_limit_per_minute: 120,
  max_batch_size: 50,
  max_payload_bytes: 256 * 1024,
  max_evidence_bytes: 10 * 1024 * 1024,
  evidence_mime_allowlist: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
  ],
  retention_days: 365,
  log_retention_days: 30,
  failure_rate_alert_threshold: 0.2,
};

/** Hard ceilings an admin cannot raise through settings. */
export const HUB_HARD_LIMITS = {
  max_batch_size: 200,
  max_payload_bytes: 2 * 1024 * 1024,
  max_event_bytes: 64 * 1024,
  max_evidence_bytes: 50 * 1024 * 1024,
  rate_limit_per_minute: 6000,
};

export function effectiveSettings(
  platform: Pick<ExternalPlatform, 'settings'>,
): Required<ExternalPlatformSettings> {
  const s = platform.settings ?? {};
  const num = (v: unknown, d: number, cap?: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
    return cap ? Math.min(n, cap) : n;
  };
  return {
    rate_limit_per_minute: num(
      s.rate_limit_per_minute,
      HUB_DEFAULT_SETTINGS.rate_limit_per_minute,
      HUB_HARD_LIMITS.rate_limit_per_minute,
    ),
    max_batch_size: num(
      s.max_batch_size,
      HUB_DEFAULT_SETTINGS.max_batch_size,
      HUB_HARD_LIMITS.max_batch_size,
    ),
    max_payload_bytes: num(
      s.max_payload_bytes,
      HUB_DEFAULT_SETTINGS.max_payload_bytes,
      HUB_HARD_LIMITS.max_payload_bytes,
    ),
    max_evidence_bytes: num(
      s.max_evidence_bytes,
      HUB_DEFAULT_SETTINGS.max_evidence_bytes,
      HUB_HARD_LIMITS.max_evidence_bytes,
    ),
    evidence_mime_allowlist:
      Array.isArray(s.evidence_mime_allowlist) &&
      s.evidence_mime_allowlist.length > 0
        ? s.evidence_mime_allowlist.map((m) => String(m).toLowerCase())
        : HUB_DEFAULT_SETTINGS.evidence_mime_allowlist,
    retention_days: num(s.retention_days, HUB_DEFAULT_SETTINGS.retention_days),
    log_retention_days: num(
      s.log_retention_days,
      HUB_DEFAULT_SETTINGS.log_retention_days,
    ),
    failure_rate_alert_threshold:
      typeof s.failure_rate_alert_threshold === 'number' &&
      s.failure_rate_alert_threshold > 0 &&
      s.failure_rate_alert_threshold <= 1
        ? s.failure_rate_alert_threshold
        : HUB_DEFAULT_SETTINGS.failure_rate_alert_threshold,
  };
}

export type HubPage = { page: number; limit: number; skip: number };

export function parsePage(
  page: unknown,
  limit: unknown,
  defaults = { limit: 25, max: 100 },
): HubPage {
  const toInt = (v: unknown, d: number): number => {
    const n =
      typeof v === 'number'
        ? v
        : typeof v === 'string'
          ? parseInt(v, 10)
          : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  const p = toInt(page, 1);
  const l = Math.min(defaults.max, toInt(limit, defaults.limit));
  return { page: p, limit: l, skip: (p - 1) * l };
}

export function isUuid(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

/** A permanent, vendor-attributable failure: the event is marked rejected, never retried. */
export class HubRejectError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HubRejectError';
  }
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

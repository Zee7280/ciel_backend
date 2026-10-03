export const MEDIA_VISIBILITY_VALUES = ['public', 'restricted', 'private'] as const;

export type MediaVisibility = (typeof MEDIA_VISIBILITY_VALUES)[number];

export const DEFAULT_MEDIA_VISIBILITY: MediaVisibility = 'restricted';

export const PUBLIC_EVIDENCE_LOCKED_LABEL =
  '🔒 Evidence verified — not publicly available';

const ALIASES: Record<string, MediaVisibility> = {
  public: 'public',
  restricted: 'restricted',
  limited: 'restricted',
  institutional: 'restricted',
  private: 'private',
  internal: 'private',
};

export const MEDIA_VISIBILITY_LABELS: Record<MediaVisibility, string> = {
  public: 'Public',
  restricted: 'Restricted',
  private: 'Private',
};

export function normalizeMediaVisibility(value: unknown): MediaVisibility | '' {
  const key = String(value || '')
    .trim()
    .toLowerCase();
  return ALIASES[key] || '';
}

export function resolveMediaVisibility(value: unknown): MediaVisibility {
  return normalizeMediaVisibility(value) || DEFAULT_MEDIA_VISIBILITY;
}

export function isPublicMediaVisibility(value: unknown): boolean {
  return normalizeMediaVisibility(value) === 'public';
}

export function hasPublicSharePermission(section8: unknown): boolean {
  if (!section8 || typeof section8 !== 'object') return false;
  const row = section8 as Record<string, unknown>;
  if (row.public_share_permission === true) return true;
  const ethics =
    row.ethical_compliance && typeof row.ethical_compliance === 'object'
      ? (row.ethical_compliance as Record<string, unknown>)
      : {};
  return (
    ethics.privacy_respected === true ||
    row.consent_informed === true ||
    row.consent_authentic === true
  );
}

export function persistSection8Visibility<T>(section8: T): T {
  if (!section8 || typeof section8 !== 'object') return section8;
  const row = section8 as Record<string, unknown>;
  const vis = resolveMediaVisibility(row.media_visible ?? row.media_usage);
  return {
    ...row,
    media_visible: vis,
    media_usage: vis,
    public_share_permission:
      vis === 'public' ? hasPublicSharePermission(row) : false,
  } as T;
}

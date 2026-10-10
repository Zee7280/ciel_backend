import {
  MediaVisibility,
  hasPublicSharePermission,
  resolveMediaVisibility,
} from './media-visibility.util';

/**
 * Evidence sharing matrix (CIEL PK Impact Package, "Sharing rules"). One project-level choice
 * (`section8.media_visible`) applies to every evidence file:
 *
 *  - public:     anyone views (student, NGO, partner, faculty, university, admin, public);
 *                originals downloadable. Needs the public-share permission, otherwise restricted.
 *  - restricted / private: Student, Super Admin, Faculty and University may view (read-only).
 *                Partner / NGO / public never see the files. Never shown publicly.
 *                Downloads blocked for every role, Super Admin included.
 */
export type EvidenceViewerRole =
  | 'student'
  | 'admin'
  | 'faculty'
  | 'university'
  | 'partner'
  | 'public';

export function effectiveEvidenceVisibility(
  section8: unknown,
): MediaVisibility {
  const raw =
    section8 && typeof section8 === 'object'
      ? ((section8 as Record<string, unknown>).media_visible ??
        (section8 as Record<string, unknown>).media_usage)
      : undefined;
  const vis = resolveMediaVisibility(raw);
  return vis === 'public' && !hasPublicSharePermission(section8)
    ? 'restricted'
    : vis;
}

export function isAdminApprovedForEvidence(report: {
  admin_status?: string | null;
}): boolean {
  return String(report.admin_status || '').toLowerCase() === 'approved';
}

export function canViewEvidence(
  report: { section8?: unknown; admin_status?: string | null },
  role: EvidenceViewerRole,
): boolean {
  if (effectiveEvidenceVisibility(report.section8) === 'public') return true;
  if (
    role === 'student' ||
    role === 'admin' ||
    role === 'faculty' ||
    role === 'university'
  ) {
    return true;
  }
  return false;
}

/** Downloads exist only for public evidence; restricted/private is blocked for all roles. */
export function canDownloadEvidence(report: { section8?: unknown }): boolean {
  return effectiveEvidenceVisibility(report.section8) === 'public';
}

const FILE_LIST_KEYS = new Set([
  'media_urls',
  'evidence_files',
  'formalization_files',
  'partner_verification_files',
  'evidence_urls',
]);
const FILE_SCALAR_KEYS = new Set(['evidence_url', 'evidence_file']);

function stripDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDeep);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FILE_LIST_KEYS.has(k)) out[k] = [];
    else if (FILE_SCALAR_KEYS.has(k)) out[k] = null;
    else out[k] = stripDeep(v);
  }
  return out;
}

/**
 * Removes evidence file URLs from a formatted report response when `role` may not view them.
 * Metadata (counts of sections, ids, claims text) is untouched; only file links are emptied and
 * `evidence_access` tells the UI why.
 */
export function applyEvidenceAccess<
  T extends { data?: Record<string, unknown> },
>(response: T, role: EvidenceViewerRole): T {
  const data = response?.data;
  if (!data) return response;
  const visibility = effectiveEvidenceVisibility(data.section8);
  const allowed = canViewEvidence(
    {
      section8: data.section8,
      admin_status: data.admin_status as string | null | undefined,
    },
    role,
  );
  const access = {
    visibility,
    can_view: allowed,
    can_download: canDownloadEvidence({ section8: data.section8 }),
    message: allowed
      ? null
      : 'Evidence verified — not publicly available',
  };
  if (allowed) {
    return { ...response, data: { ...data, evidence_access: access } };
  }
  const stripped = stripDeep(data) as Record<string, unknown>;
  const pkg = stripped.review_package as
    | { documents?: { evidence?: Record<string, unknown> } }
    | null
    | undefined;
  if (pkg?.documents?.evidence) {
    pkg.documents.evidence = { ...pkg.documents.evidence, count: 0, files: [] };
  }
  return { ...response, data: { ...stripped, evidence_access: access } };
}

/**
 * R3: Admin supplemental evidence on a report. These are the files a CIEL PK Super Admin attaches
 * during review: kept apart from the student's originals, always labelled, and visible to Admin only.
 * They join the evidence inventory and the analysis fingerprint (so adding or removing one makes a
 * stored analysis stale and forces a re-run before approval), but they never feed the AI report-
 * quality score and never change a mark by themselves.
 */

export const SUPPLEMENTAL_VISIBILITIES = [
  'public',
  'restricted',
  'private',
] as const;
export type SupplementalVisibility = (typeof SUPPLEMENTAL_VISIBILITIES)[number];

export type SupplementalEvidenceItem = {
  id: string;
  url: string;
  name: string;
  /** Why the file was added, shown wherever the file is listed. */
  label: string;
  /** Report section the file relates to ('general' when it supports the whole report). */
  section: string;
  visibility: SupplementalVisibility;
  caption: string | null;
  addedByAdminId: string;
  addedAt: string;
  removedAt?: string | null;
  removedByAdminId?: string | null;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Every stored item (including removed ones), validated; malformed rows are dropped. */
export function parseSupplementalEvidence(
  raw: unknown,
): SupplementalEvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SupplementalEvidenceItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    const url = str(r.url);
    if (!id || !url) continue;
    const visibility = SUPPLEMENTAL_VISIBILITIES.includes(
      r.visibility as SupplementalVisibility,
    )
      ? (r.visibility as SupplementalVisibility)
      : 'restricted';
    out.push({
      id,
      url,
      name: str(r.name) || id,
      label: str(r.label) || 'Supplemental evidence',
      section: str(r.section) || 'general',
      visibility,
      caption: str(r.caption) || null,
      addedByAdminId: str(r.addedByAdminId),
      addedAt: str(r.addedAt),
      removedAt: str(r.removedAt) || null,
      removedByAdminId: str(r.removedByAdminId) || null,
    });
  }
  return out;
}

/** Items still in force (not soft-removed), in the order they were added. */
export function activeSupplementalEvidence(
  raw: unknown,
): SupplementalEvidenceItem[] {
  return parseSupplementalEvidence(raw).filter((i) => !i.removedAt);
}

/** Stable inventory id for the n-th active supplemental file: ADM-001, ADM-002, ... */
export function supplementalFileId(index: number): string {
  return `ADM-${String(index + 1).padStart(3, '0')}`;
}

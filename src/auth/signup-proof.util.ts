import type { SignupProofDocument } from '../organizations/entities/organization.entity';

export const SIGNUP_PROOF_FOLDER = 'signup-proofs';

/**
 * Keep only documents our own signup-proof endpoint produced: the client sends the URLs back, so
 * anything outside `signup-proofs/` on our bucket (an arbitrary link for the admin to click) is dropped.
 */
export function sanitizeSignupProofDocuments(
  docs: { label?: unknown; url?: unknown; fileName?: unknown }[] | undefined,
  keyFromPublicUrl: (url: string) => string | null,
  now: Date = new Date(),
): SignupProofDocument[] {
  if (!Array.isArray(docs)) return [];
  const out: SignupProofDocument[] = [];
  for (const d of docs.slice(0, 4)) {
    const url = typeof d?.url === 'string' ? d.url.trim() : '';
    const key = url ? keyFromPublicUrl(url) : null;
    if (!key || !key.startsWith(`${SIGNUP_PROOF_FOLDER}/`)) continue;
    const label = typeof d.label === 'string' ? d.label.trim() : '';
    const fileName = typeof d.fileName === 'string' ? d.fileName.trim() : '';
    out.push({
      label: label.slice(0, 120) || 'Proof document',
      url,
      fileName: fileName.slice(0, 200),
      uploadedAt: now.toISOString(),
    });
  }
  return out;
}

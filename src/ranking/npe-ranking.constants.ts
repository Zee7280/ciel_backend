/** National Project Excellence — second layer. Never overwrites locked CII. */

/**
 * Rubric versions. A run, its evaluations and its published snapshot are always scored with the
 * version they were created under, so publishing a new weighting never rewrites an older ranking.
 *  - NPE-1.1: locked CII 15 + eight criteria 85 (original weighting).
 *  - NPE-1.2: locked CII 10 + eight criteria 90 (Ranking Studio weighting). Current default.
 * The AI judgment (anchor 0–5 + confidence per criterion) is identical in both, so an evaluation
 * read under one version is re-scored — never re-read — under the other.
 * To switch the default weighting back, change NPE_RUBRIC_VERSION only.
 */
export const NPE_RUBRIC_VERSION = 'NPE-1.2' as const;
export const NPE_SUPPORTED_RUBRIC_VERSIONS = ['NPE-1.2', 'NPE-1.1'] as const;
export type NpeRubricVersion = (typeof NPE_SUPPORTED_RUBRIC_VERSIONS)[number];
export const NPE_CII_SCALE = 'base100_bonus110' as const;

/**
 * Version of what the AI is shown for one package. Raise it whenever the package payload changes
 * materially. An evaluation is only re-used when it was made with the current payload, so a ranking
 * never silently keeps judgments that were formed from a thinner package.
 *  - 1 (unmarked): sections S1–S10 only; top-level redaction; images only.
 *  - 2: flashcard + all sections + full system analysis + evidence manifest, PDF text, read status,
 *       deep personal-data redaction.
 */
export const NPE_PAYLOAD_VERSION = 2 as const;

export function isSupportedNpeRubricVersion(v: unknown): v is NpeRubricVersion {
  return (NPE_SUPPORTED_RUBRIC_VERSIONS as readonly string[]).includes(String(v));
}

export const NPE_EVIDENCE_FACTORS = {
  high: 1,
  moderate: 0.9,
  low: 0.75,
  unsupported: 0,
} as const;

export type NpeEvidenceConfidence = keyof typeof NPE_EVIDENCE_FACTORS;

export const NPE_CRITERIA = [
  {
    key: 'impact',
    title: 'Verified outcome & impact depth',
    label: 'Community Impact',
    question: 'Documented improvement for beneficiaries',
    weight: 22,
    source: 'S4–S5',
  },
  {
    key: 'need',
    title: 'Relevance, need & equity',
    label: 'Need & Relevance',
    question: 'Real, identified community need',
    weight: 13,
    source: 'S2',
  },
  {
    key: 'sustain',
    title: 'Sustainability & system influence',
    label: 'Sustainability',
    question: 'Ownership after completion',
    weight: 9,
    source: 'S10',
  },
  {
    key: 'partner',
    title: 'Partnership & community ownership',
    label: 'Collaboration',
    question: 'Community / partner involvement',
    weight: 9,
    source: 'S7',
  },
  {
    key: 'efficiency',
    title: 'Efficiency & resource use',
    label: 'Resource Efficiency',
    question: 'Meaningful outcomes per resources',
    weight: 9,
    source: 'S1 + S6',
  },
  {
    key: 'sdg',
    title: 'SDG coherence',
    label: 'SDG Contribution',
    question: 'Contribution to a specific target',
    weight: 9,
    source: 'S3',
  },
  {
    key: 'scale',
    title: 'Scalability & replicability',
    label: 'Transferability',
    question: 'Replicable learning and practice',
    weight: 9,
    source: 'S10',
  },
  {
    key: 'learning',
    title: 'Learning, adaptation & innovation',
    label: 'Student Learning',
    question: 'Skills, initiative and reflection',
    weight: 10,
    source: 'S4 + S9',
  },
] as const;

export type NpeCriterionKey = (typeof NPE_CRITERIA)[number]['key'];

export const NPE_CRITERION_KEYS = NPE_CRITERIA.map((c) => c.key);

/** Criterion weights and locked-CII weight per rubric version (each sums to 100). */
export const NPE_WEIGHT_PROFILES: Record<
  NpeRubricVersion,
  { ciiWeight: number; criteria: Record<NpeCriterionKey, number> }
> = {
  'NPE-1.2': {
    ciiWeight: 10,
    criteria: {
      impact: 22,
      need: 13,
      sustain: 9,
      partner: 9,
      efficiency: 9,
      sdg: 9,
      scale: 9,
      learning: 10,
    },
  },
  'NPE-1.1': {
    ciiWeight: 15,
    criteria: {
      impact: 25,
      need: 12,
      sustain: 12,
      partner: 10,
      efficiency: 8,
      sdg: 6,
      scale: 6,
      learning: 6,
    },
  },
};

/** The criteria list with the weights of a given rubric version (unknown versions fall back to current). */
export function npeCriteriaFor(version: string) {
  const profile = isSupportedNpeRubricVersion(version)
    ? NPE_WEIGHT_PROFILES[version]
    : NPE_WEIGHT_PROFILES[NPE_RUBRIC_VERSION];
  return NPE_CRITERIA.map((c) => ({ ...c, weight: profile.criteria[c.key] }));
}

export type NpePackageStatus =
  | 'Eligible'
  | 'Review'
  | 'Excluded'
  | 'Ready'
  | 'Ranked';

export type NpeStanding = {
  snapshotId: string;
  scope: string;
  excellenceScore: number;
  nationalRank: number | null;
  universityRank: number | null;
  publishedAt: string;
};

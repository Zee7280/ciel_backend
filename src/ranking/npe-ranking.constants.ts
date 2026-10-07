/** National Project Excellence — second layer. Never overwrites locked CII. */
export const NPE_RUBRIC_VERSION = 'NPE-1.1' as const;
export const NPE_CII_SCALE = 'base100_bonus110' as const;

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
    weight: 25,
    source: 'S4–S5',
  },
  {
    key: 'need',
    title: 'Relevance, need & equity',
    weight: 12,
    source: 'S2',
  },
  {
    key: 'sustain',
    title: 'Sustainability & system influence',
    weight: 12,
    source: 'S10',
  },
  {
    key: 'partner',
    title: 'Partnership & community ownership',
    weight: 10,
    source: 'S7',
  },
  {
    key: 'efficiency',
    title: 'Efficiency & resource use',
    weight: 8,
    source: 'S1 + S6',
  },
  {
    key: 'sdg',
    title: 'SDG coherence',
    weight: 6,
    source: 'S3',
  },
  {
    key: 'scale',
    title: 'Scalability & replicability',
    weight: 6,
    source: 'S10',
  },
  {
    key: 'learning',
    title: 'Learning, adaptation & innovation',
    weight: 6,
    source: 'S4 + S9',
  },
] as const;

export type NpeCriterionKey = (typeof NPE_CRITERIA)[number]['key'];

export const NPE_CRITERION_KEYS = NPE_CRITERIA.map((c) => c.key);

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

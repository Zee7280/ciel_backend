/**
 * Composite Impact Index (CII) v2 — Community Service scoring engine.
 *
 * Ported from the CIEL PK "Faculty Composite Impact Index Analyser v2" design mockup.
 * 9 weighted sections = 94 base points (Section 1 is scored per-student/"individual",
 * Sections 2-9 are shared "project quality" scored once per project/team) + up to 6
 * capped, per-student bonus points - integrity penalty = final score (0-100).
 *
 * The AI evaluator only supplies a 0-4 anchor rating per criterion (plus bonus tier
 * amounts and an integrity penalty). All arithmetic here is recomputed server-side from
 * those anchors - the model's own arithmetic is never trusted, matching the existing
 * `parseSection11V81Response`/`buildCiiSnapshotFromV81` convention.
 *
 * Keep in sync with `ciel_frontend/src/utils/communityCiiAnalyser.ts`.
 */

export interface CiiV2Criterion {
  key: string;
  label: string;
  /** Max points this criterion can contribute (points = weight * anchor / 4). */
  weight: number;
  evidenceHint: string;
}

export interface CiiV2Section {
  id: number;
  key: string;
  title: string;
  /** Sum of its criteria weights. */
  weight: number;
  rationale: string;
  criteria: CiiV2Criterion[];
}

export const CII_V2_ANCHORS = [
  'Missing / Invalid',
  'Basic',
  'Sound',
  'Strong',
  'Exceptional',
] as const;

export const CII_V2_SECTIONS: CiiV2Section[] = [
  {
    id: 1,
    key: 'participation',
    title: 'Participation Quality & Individual Commitment',
    weight: 8,
    rationale:
      'Minimum hours are a mandatory compliance gate, not a scored achievement. This section differentiates students by the quality, continuity, evidence and clarity of their own contribution.',
    criteria: [
      {
        key: 'role_clarity',
        label: 'Individual role clarity & responsibility',
        weight: 2,
        evidenceHint: 'Activity responsibilities + member record',
      },
      {
        key: 'participation_quality',
        label: 'Quality & realism of participation',
        weight: 2,
        evidenceHint: 'Session ledger + timestamps',
      },
      {
        key: 'attendance_consistency',
        label: 'Evidence-backed attendance consistency',
        weight: 2,
        evidenceHint: 'Attendance register + session proof',
      },
      {
        key: 'engagement_continuity',
        label: 'Depth / continuity of engagement',
        weight: 2,
        evidenceHint: 'Session pattern + activity history',
      },
    ],
  },
  {
    id: 2,
    key: 'context',
    title: 'Community Context, Voice, Need & Baseline',
    weight: 10,
    rationale:
      'A universal community-service score must start with whether the intervention responds to a real, evidenced need and whether community or beneficiary voice is visible.',
    criteria: [
      {
        key: 'need_specificity',
        label: 'Specificity & significance of the community need',
        weight: 2,
        evidenceHint: 'Baseline narrative + site audit',
      },
      {
        key: 'beneficiary_voice',
        label: 'Community / beneficiary voice & reciprocity',
        weight: 2,
        evidenceHint: 'Partner input + feedback',
      },
      {
        key: 'baseline_evidence',
        label: 'Evidence-informed baseline',
        weight: 3,
        evidenceHint: 'Before photos + attendance records',
      },
      {
        key: 'contextual_understanding',
        label: 'Local / contextual understanding',
        weight: 1.5,
        evidenceHint: 'Need assessment',
      },
      {
        key: 'disciplinary_lens',
        label: 'Academic / disciplinary lens where relevant',
        weight: 1.5,
        evidenceHint: 'Academic application field',
      },
    ],
  },
  {
    id: 3,
    key: 'sdg',
    title: 'SDG Relevance & Contribution Logic',
    weight: 6,
    rationale:
      'SDG alignment should be technically defensible but must not dominate the score. Correct logic matters more than selecting many goals.',
    criteria: [
      {
        key: 'sdg_alignment',
        label: 'Correct primary SDG / target alignment',
        weight: 2,
        evidenceHint: 'Opportunity SDG + target',
      },
      {
        key: 'contribution_logic',
        label: 'Need → activity → output → outcome → SDG logic',
        weight: 2,
        evidenceHint: 'Contribution narrative',
      },
      {
        key: 'activity_output_outcome_alignment',
        label: 'Activity / output / outcome alignment',
        weight: 1.5,
        evidenceHint: 'Activities + outcomes',
      },
      {
        key: 'sdg_restraint',
        label: 'Restraint / no SDG inflation',
        weight: 0.5,
        evidenceHint: 'Full SDG set',
      },
    ],
  },
  {
    id: 4,
    key: 'execution',
    title: 'Execution, Outputs & Outcomes · What We Did → What Changed',
    weight: 32,
    rationale:
      'This is the largest component because CIEL PK must distinguish attendance from genuine delivery and delivery from demonstrated community value.',
    criteria: [
      {
        key: 'planned_vs_actual',
        label: 'Planned intention → actual execution',
        weight: 4,
        evidenceHint: 'Activity records',
      },
      {
        key: 'delivery_rigor',
        label: 'Rigor & quality of delivery',
        weight: 5,
        evidenceHint: 'Activity descriptions + photos',
      },
      {
        key: 'execution_ownership',
        label: 'Execution ownership & depth of engagement',
        weight: 4,
        evidenceHint: 'Session ledger + responsibilities',
      },
      {
        key: 'output_counting_integrity',
        label: 'Outputs & counting integrity',
        weight: 4,
        evidenceHint: 'Output records + partner register',
      },
      {
        key: 'depth_or_scale',
        label: 'Depth OR verified scale',
        weight: 3,
        evidenceHint: 'Unique reach + session history',
      },
      {
        key: 'measurable_outcomes',
        label: 'Outcomes / measurable change',
        weight: 8,
        evidenceHint: 'Attendance registers + condition checklist',
      },
      {
        key: 'beneficiary_value',
        label: 'Beneficiary value, inclusion & appropriateness',
        weight: 2,
        evidenceHint: 'Beneficiary narrative + feedback',
      },
      {
        key: 'adaptation_honesty',
        label: 'Adaptation, limitations & attribution honesty',
        weight: 2,
        evidenceHint: 'Limitations narrative',
      },
    ],
  },
  {
    id: 5,
    key: 'resources',
    title: 'Resource Stewardship & Efficiency',
    weight: 6,
    rationale:
      'A zero-budget project can earn full core marks. This section scores whether available time, skills, money or in-kind inputs were appropriate, traceable and efficiently used - not how wealthy the project was.',
    criteria: [
      {
        key: 'resource_stewardship',
        label: 'Stewardship / efficient use of available resources',
        weight: 2,
        evidenceHint: 'Resource pathway + outputs',
      },
      {
        key: 'resource_traceability',
        label: 'Traceability & verification',
        weight: 1.5,
        evidenceHint: 'Receipts + handover records',
      },
      {
        key: 'resource_appropriateness',
        label: 'Appropriateness / proportionality',
        weight: 1.5,
        evidenceHint: 'Resource ledger + activity need',
      },
      {
        key: 'resource_delivery_link',
        label: 'Resource → delivery link',
        weight: 1,
        evidenceHint: 'Enabled-by statements',
      },
    ],
  },
  {
    id: 6,
    key: 'partnerships',
    title: 'Community Collaboration, Reciprocity & Ownership',
    weight: 6,
    rationale:
      'Formal partner count is not the objective. One deep, reciprocal community relationship can outrank several superficial logos.',
    criteria: [
      {
        key: 'stakeholder_relevance',
        label: 'Relevance & reciprocity of stakeholder relationship',
        weight: 1.5,
        evidenceHint: 'Partner/community identity + role',
      },
      {
        key: 'stakeholder_role_clarity',
        label: 'Clarity of stakeholder / partner role',
        weight: 1.5,
        evidenceHint: 'Partner roles',
      },
      {
        key: 'collaboration_quality',
        label: 'Quality of collaboration / co-design',
        weight: 1.5,
        evidenceHint: 'Coordination evidence',
      },
      {
        key: 'verification_ownership',
        label: 'Verification, ownership & continuation involvement',
        weight: 1.5,
        evidenceHint: 'Verification letter + handover',
      },
    ],
  },
  {
    id: 7,
    key: 'evidence',
    title: 'Evidence, Verification & Integrity',
    weight: 15,
    rationale:
      'High-tier recognition requires claims that can be checked. Evidence quality must match the claim type: photos prove occurrence, registers prove participation, receipts prove resources and before/after data support outcome claims.',
    criteria: [
      {
        key: 'evidence_participation',
        label: 'Evidence supports participation / hours',
        weight: 2,
        evidenceHint: 'Attendance evidence',
      },
      {
        key: 'evidence_activities',
        label: 'Evidence supports activities / outputs',
        weight: 3,
        evidenceHint: 'Activity/output evidence',
      },
      {
        key: 'evidence_beneficiaries',
        label: 'Evidence supports beneficiaries / scale',
        weight: 2.5,
        evidenceHint: 'Beneficiary reach evidence',
      },
      {
        key: 'evidence_outcomes',
        label: 'Evidence supports outcomes / change',
        weight: 4,
        evidenceHint: 'Before/after outcome evidence',
      },
      {
        key: 'evidence_resource_traceability',
        label: 'Resource / stakeholder traceability',
        weight: 1.5,
        evidenceHint: 'Resource/stakeholder evidence',
      },
      {
        key: 'ethics_integrity',
        label: 'Ethics, consent, consistency & integrity',
        weight: 2,
        evidenceHint: 'Evidence declarations + consistency scan',
      },
    ],
  },
  {
    id: 8,
    key: 'learning',
    title: 'Reflection, Learning & Academic Application',
    weight: 5,
    rationale:
      'Community service should produce learning as well as activity. Reflection is scored for specificity and self-awareness, not for polished language.',
    criteria: [
      {
        key: 'personal_learning',
        label: 'Specific, honest personal learning',
        weight: 1.5,
        evidenceHint: 'Personal reflection',
      },
      {
        key: 'academic_application',
        label: 'Application of discipline / knowledge where relevant',
        weight: 1,
        evidenceHint: 'Academic application',
      },
      {
        key: 'ethical_understanding',
        label: 'Ethical / community understanding',
        weight: 1.5,
        evidenceHint: 'Reflection narrative',
      },
      {
        key: 'self_awareness',
        label: 'Self-awareness, challenge & future improvement',
        weight: 1,
        evidenceHint: 'Future-action reflection',
      },
    ],
  },
  {
    id: 9,
    key: 'sustainability',
    title: 'Sustainability, Handover & Continuation',
    weight: 6,
    rationale:
      'Not every project must continue forever. High scores come from honest continuation logic, local ownership and realistic handover - not from automatically selecting "sustainable".',
    criteria: [
      {
        key: 'continuation_assessment',
        label: 'Realistic continuation assessment',
        weight: 1.5,
        evidenceHint: 'Sustainability narrative',
      },
      {
        key: 'named_ownership',
        label: 'Named ownership / handover',
        weight: 1.5,
        evidenceHint: 'Handover record',
      },
      {
        key: 'continuation_mechanism',
        label: 'Continuation mechanism / follow-up',
        weight: 1.5,
        evidenceHint: 'Handover + follow-up',
      },
      {
        key: 'scaling_realism',
        label: 'Scaling / system influence realism',
        weight: 1.5,
        evidenceHint: 'Scaling statement',
      },
    ],
  },
];

export const CII_V2_BASE_MAX = CII_V2_SECTIONS.reduce(
  (sum, s) => sum + s.weight,
  0,
); // 94
export const CII_V2_BONUS_MAX = 6;
export const CII_V2_MAX = CII_V2_BASE_MAX + CII_V2_BONUS_MAX; // 100

export interface CiiV2Level {
  level: number;
  min: number;
  max: number;
  name: string;
  quality: string;
  icon: string;
}

export const CII_V2_LEVELS: CiiV2Level[] = [
  {
    level: 7,
    min: 92,
    max: 100,
    name: 'Transformative Impact Contributor',
    quality: 'PHENOMENAL',
    icon: '🏆',
  },
  {
    level: 6,
    min: 84,
    max: 91.999,
    name: 'Distinguished Impact Contributor',
    quality: 'EXCELLENT',
    icon: '💎',
  },
  {
    level: 5,
    min: 75,
    max: 83.999,
    name: 'Strong Impact Contributor',
    quality: 'VERY GOOD',
    icon: '⭐',
  },
  {
    level: 4,
    min: 67,
    max: 74.999,
    name: 'Developing Impact Contributor',
    quality: 'GOOD',
    icon: '🌟',
  },
  {
    level: 3,
    min: 58,
    max: 66.999,
    name: 'Emerging Community Contributor',
    quality: 'AVERAGE',
    icon: '🌱',
  },
  {
    level: 2,
    min: 48,
    max: 57.999,
    name: 'Foundation Stage Contributor',
    quality: 'FOUNDATION',
    icon: '🔹',
  },
  {
    level: 1,
    min: 0,
    max: 47.999,
    name: 'Participation Acknowledgement',
    quality: 'BASIC',
    icon: '🔸',
  },
];

export interface CiiV2BonusTier {
  label: string;
  amount: number;
}

export interface CiiV2BonusChannel {
  key: 'effort' | 'resources' | 'partners';
  name: string;
  max: number;
  tiers: CiiV2BonusTier[];
}

export const CII_V2_BONUS_CHANNELS: CiiV2BonusChannel[] = [
  {
    key: 'effort',
    name: 'Extra verified effort above the opportunity minimum',
    max: 2,
    tiers: [
      { label: '≤ 1.00× required hours', amount: 0 },
      { label: '1.01–1.24×', amount: 0.25 },
      { label: '1.25–1.49×', amount: 0.5 },
      { label: '1.50–1.99×', amount: 1 },
      { label: '2.00–2.49×', amount: 1.5 },
      { label: '≥ 2.50×', amount: 2 },
    ],
  },
  {
    key: 'resources',
    name: 'Verified resource mobilisation / external leverage',
    max: 2,
    tiers: [
      { label: 'None / unverified', amount: 0 },
      { label: 'One modest verified contribution', amount: 0.5 },
      {
        label: 'Multiple relevant inputs OR removes a delivery constraint',
        amount: 1,
      },
      {
        label: 'Diverse, verified support materially expands delivery',
        amount: 1.5,
      },
      {
        label:
          'Exceptional verified leverage enabling major expansion / continuation',
        amount: 2,
      },
    ],
  },
  {
    key: 'partners',
    name: 'Verified partnership-building / external collaboration',
    max: 2,
    tiers: [
      { label: 'No additional partnership-building', amount: 0 },
      { label: 'Student activates one relevant stakeholder', amount: 0.5 },
      {
        label: 'Partner actively contributes to delivery / verification',
        amount: 1,
      },
      { label: 'Co-design/co-delivery + documented contribution', amount: 1.5 },
      {
        label:
          'Sustained ownership / replication or multi-stakeholder coordination',
        amount: 2,
      },
    ],
  },
];

export function sectionById(id: number): CiiV2Section | undefined {
  return CII_V2_SECTIONS.find((s) => s.id === id);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CiiV2CriterionAnchor {
  key: string;
  /** 0-4 analytic anchor rating. */
  anchor: number;
  note?: string;
}

export interface CiiV2SectionInput {
  id: number;
  criteria: CiiV2CriterionAnchor[];
  good?: string;
  limit?: string;
}

export interface CiiV2BonusInput {
  effort: number;
  resources: number;
  partners: number;
}

export interface CiiV2EvidenceRow {
  id: string;
  file: string;
  claim: string;
  type: string;
  match: number;
  verdict: 'MATCH' | 'PARTIAL' | 'MISMATCH';
  why: string;
}

export interface CiiV2ComputeInput {
  sections: CiiV2SectionInput[];
  bonus: CiiV2BonusInput;
  integrityPenalty: number;
  evidence?: CiiV2EvidenceRow[];
}

export interface CiiV2SectionResult {
  id: number;
  key: string;
  title: string;
  weight: number;
  score: number;
  good?: string;
  limit?: string;
  criteria: Array<{
    key: string;
    label: string;
    weight: number;
    anchor: number;
    points: number;
    note?: string;
  }>;
}

export interface CiiV2Result {
  sections: CiiV2SectionResult[];
  individualCore: number;
  projectQuality: number;
  base: number;
  bonus: CiiV2BonusInput & { total: number };
  integrityPenalty: number;
  final: number;
  numericLevel: number;
  level: CiiV2Level;
  gateCap: number;
  gateExplanation: string;
  evidence: CiiV2EvidenceRow[];
  evidenceAverage: number;
}

function anchorFor(
  input: CiiV2SectionInput | undefined,
  criterionKey: string,
): number {
  const found = input?.criteria.find((c) => c.key === criterionKey);
  const anchor = found?.anchor ?? 0;
  return Math.min(4, Math.max(0, anchor));
}

function noteFor(
  input: CiiV2SectionInput | undefined,
  criterionKey: string,
): string | undefined {
  return input?.criteria.find((c) => c.key === criterionKey)?.note;
}

function scoreSection(
  section: CiiV2Section,
  input: CiiV2SectionInput | undefined,
): CiiV2SectionResult {
  const criteria = section.criteria.map((c) => {
    const anchor = anchorFor(input, c.key);
    const points = round2((c.weight * anchor) / 4);
    return {
      key: c.key,
      label: c.label,
      weight: c.weight,
      anchor,
      points,
      note: noteFor(input, c.key),
    };
  });
  const score = round2(criteria.reduce((sum, c) => sum + c.points, 0));
  return {
    id: section.id,
    key: section.key,
    title: section.title,
    weight: section.weight,
    score,
    good: input?.good,
    limit: input?.limit,
    criteria,
  };
}

export function clampBonusAmount(amount: number, max: number): number {
  return round2(Math.min(max, Math.max(0, amount || 0)));
}

export function numericLevelFor(score: number): CiiV2Level {
  return (
    CII_V2_LEVELS.find((l) => score >= l.min && score <= l.max) ||
    CII_V2_LEVELS[CII_V2_LEVELS.length - 1]
  );
}

export function qualityGateCap(params: {
  base: number;
  section4Score: number;
  section7Score: number;
  section9Score: number;
  integrityPenalty: number;
}): number {
  const section4 = sectionById(4)!;
  const section7 = sectionById(7)!;
  const section9 = sectionById(9)!;
  const impl = params.section4Score / section4.weight;
  const evid = params.section7Score / section7.weight;
  const sus = params.section9Score / section9.weight;
  const { base, integrityPenalty } = params;

  if (integrityPenalty >= 6) return 4;
  if (
    base >= 87 &&
    impl >= 0.84 &&
    evid >= 0.85 &&
    sus >= 0.75 &&
    integrityPenalty === 0
  )
    return 7;
  if (
    base >= 78 &&
    impl >= 0.75 &&
    evid >= 0.73 &&
    sus >= 0.55 &&
    integrityPenalty < 3
  )
    return 6;
  if (base >= 69 && impl >= 0.62 && evid >= 0.6 && integrityPenalty < 6)
    return 5;
  return 4;
}

export function levelFor(score: number, gateCap: number): CiiV2Level {
  const numeric = numericLevelFor(score);
  const cappedLevel = Math.min(numeric.level, gateCap);
  return CII_V2_LEVELS.find((l) => l.level === cappedLevel) || numeric;
}

export function gateExplanationFor(
  finalScore: number,
  gateCap: number,
): string {
  const numeric = numericLevelFor(finalScore);
  const actual = levelFor(finalScore, gateCap);
  if (numeric.level === actual.level) {
    return `Quality gates satisfied for Level ${actual.level}.`;
  }
  return `Numeric score reaches Level ${numeric.level}, but the badge is capped at Level ${actual.level} because a required outcome/evidence/sustainability or integrity gate is not met.`;
}

export function computeCiiV2Result(input: CiiV2ComputeInput): CiiV2Result {
  const inputById = new Map(input.sections.map((s) => [s.id, s]));
  const sections = CII_V2_SECTIONS.map((s) =>
    scoreSection(s, inputById.get(s.id)),
  );

  const individualCore = sections.find((s) => s.id === 1)?.score ?? 0;
  const projectQuality = round2(
    sections.filter((s) => s.id !== 1).reduce((sum, s) => sum + s.score, 0),
  );
  const base = round2(individualCore + projectQuality);

  const bonus = {
    effort: clampBonusAmount(input.bonus.effort, 2),
    resources: clampBonusAmount(input.bonus.resources, 2),
    partners: clampBonusAmount(input.bonus.partners, 2),
  };
  const bonusTotal = round2(
    Math.min(CII_V2_BONUS_MAX, bonus.effort + bonus.resources + bonus.partners),
  );

  const integrityPenalty = Math.max(0, input.integrityPenalty || 0);
  const final = round2(
    Math.min(100, Math.max(0, base + bonusTotal - integrityPenalty)),
  );

  const section4Score = sections.find((s) => s.id === 4)?.score ?? 0;
  const section7Score = sections.find((s) => s.id === 7)?.score ?? 0;
  const section9Score = sections.find((s) => s.id === 9)?.score ?? 0;

  const gateCap = qualityGateCap({
    base,
    section4Score,
    section7Score,
    section9Score,
    integrityPenalty,
  });
  const numericLevel = numericLevelFor(final).level;
  const level = levelFor(final, gateCap);
  const gateExplanation = gateExplanationFor(final, gateCap);

  const evidence = input.evidence || [];
  const evidenceAverage = evidence.length
    ? Math.round(
        evidence.reduce((sum, e) => sum + (e.match || 0), 0) / evidence.length,
      )
    : 0;

  return {
    sections,
    individualCore,
    projectQuality,
    base,
    bonus: { ...bonus, total: bonusTotal },
    integrityPenalty,
    final,
    numericLevel,
    level,
    gateCap,
    gateExplanation,
    evidence,
    evidenceAverage,
  };
}

export function getCiiV2ScoringConfig() {
  return {
    cii_v2_framework_version: 'v2.0',
    base_max: CII_V2_BASE_MAX,
    bonus_max: CII_V2_BONUS_MAX,
    max_total: CII_V2_MAX,
    sections: CII_V2_SECTIONS,
    levels: CII_V2_LEVELS,
    bonus_channels: CII_V2_BONUS_CHANNELS,
    anchors: CII_V2_ANCHORS,
  };
}

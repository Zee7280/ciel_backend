/**
 * Composite Impact Index (CII) — Community Service scoring engine.
 *
 * Live framework: Balanced CII Rubric v3.1 (admin AI Analyzer).
 * 10 weighted sections = 100 base points + up to +5 verified Extra-Mile uplift
 * − integrity penalty = final score (0–100).
 *
 * The AI evaluator supplies a 0–4 anchor rating per criterion (plus Extra-Mile
 * amounts and an integrity penalty). All arithmetic is recomputed server-side.
 *
 * Keep in sync with `ciel_frontend/src/utils/communityCiiAnalyser.ts`.
 */

export interface CiiV2Criterion {
  key: string;
  label: string;
  /** Max points this criterion can contribute. */
  weight: number;
  evidenceHint: string;
}

export interface CiiV2Section {
  id: number;
  key: string;
  title: string;
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

/** v3.1 balanced anchor factors (not linear /4). */
export const CII_V2_ANCHOR_FACTORS = [0, 0.45, 0.65, 0.82, 1] as const;

export const CII_V2_SECTIONS: CiiV2Section[] = [
  {
    id: 1,
    key: 'participation',
    title: 'Participation & Verified Effort',
    weight: 8,
    rationale:
      'Evaluate individual role, verified hours, continuity, participation quality, attendance realism and repeated engagement. Required hours are compliance, not exceptional marks.',
    criteria: [
      { key: 'role_clarity', label: 'Individual role clarity & responsibility', weight: 2, evidenceHint: 'Activity responsibilities + member record' },
      { key: 'participation_quality', label: 'Quality & realism of participation', weight: 2, evidenceHint: 'Session ledger + timestamps' },
      { key: 'attendance_consistency', label: 'Evidence-backed attendance consistency', weight: 2, evidenceHint: 'Attendance register + session proof' },
      { key: 'engagement_continuity', label: 'Depth / continuity of engagement', weight: 2, evidenceHint: 'Session pattern + activity history' },
    ],
  },
  {
    id: 2,
    key: 'context',
    title: 'Community Need & Starting Point',
    weight: 10,
    rationale:
      'Evaluate actual community need, beneficiary group, community/beneficiary voice, starting situation, local context and discipline relevance. Formal research-grade baseline is not mandatory for Sound.',
    criteria: [
      { key: 'need_specificity', label: 'Specificity & significance of the community need', weight: 2, evidenceHint: 'Baseline narrative + site audit' },
      { key: 'beneficiary_voice', label: 'Community / beneficiary voice & reciprocity', weight: 2, evidenceHint: 'Partner input + feedback' },
      { key: 'baseline_context', label: 'Starting situation / baseline context', weight: 2, evidenceHint: 'Before photos + observed conditions' },
      { key: 'contextual_understanding', label: 'Local / contextual understanding', weight: 2, evidenceHint: 'Need assessment' },
      { key: 'disciplinary_relevance', label: 'Academic / disciplinary relevance', weight: 2, evidenceHint: 'Academic application field' },
    ],
  },
  {
    id: 3,
    key: 'sdg',
    title: 'SDG Contribution',
    weight: 7,
    rationale:
      'Evaluate Need → Activity → Output → Outcome → SDG. One correctly justified SDG is stronger than several weakly connected SDGs.',
    criteria: [
      { key: 'sdg_alignment', label: 'Correct primary SDG / target alignment', weight: 2, evidenceHint: 'Opportunity SDG + target' },
      { key: 'contribution_logic', label: 'Need → activity → output → outcome → SDG logic', weight: 2, evidenceHint: 'Contribution narrative' },
      { key: 'activity_output_outcome_alignment', label: 'Activity / output / outcome alignment', weight: 2, evidenceHint: 'Activities + outcomes' },
      { key: 'sdg_restraint', label: 'Restraint / no SDG inflation', weight: 1, evidenceHint: 'Full SDG set' },
    ],
  },
  {
    id: 4,
    key: 'activities',
    title: 'Activities & Outputs',
    weight: 15,
    rationale:
      'WHAT WAS ACTUALLY DONE AND PRODUCED. Small scale does not cap the score; large scale does not automatically increase it.',
    criteria: [
      { key: 'planned_vs_actual', label: 'Planned intention → actual execution', weight: 3, evidenceHint: 'Activity records' },
      { key: 'delivery_rigor', label: 'Rigor & quality of delivery', weight: 3, evidenceHint: 'Activity descriptions + photos' },
      { key: 'execution_ownership', label: 'Execution ownership & depth of engagement', weight: 3, evidenceHint: 'Session ledger + responsibilities' },
      { key: 'output_quality_integrity', label: 'Outputs & counting integrity', weight: 3, evidenceHint: 'Output records + partner register' },
      { key: 'depth_or_scale', label: 'Depth OR verified scale', weight: 3, evidenceHint: 'Unique reach + session history' },
    ],
  },
  {
    id: 5,
    key: 'outcomes',
    title: 'Outcomes & Measured Change',
    weight: 15,
    rationale:
      'WHAT CHANGED BECAUSE OF THE WORK. A credible narrative outcome without formal measurement may receive Sound. Formal measurement primarily supports Strong/Exceptional.',
    criteria: [
      { key: 'outcome_clarity', label: 'Outcome clarity', weight: 3, evidenceHint: 'Before/after narrative' },
      { key: 'measurable_change', label: 'Measurable / demonstrated change', weight: 4, evidenceHint: 'Registers + assessment data' },
      { key: 'outcome_source_quality', label: 'Outcome source quality', weight: 3, evidenceHint: 'Data source / feedback instrument' },
      { key: 'beneficiary_value', label: 'Beneficiary value, inclusion & appropriateness', weight: 3, evidenceHint: 'Beneficiary narrative + feedback' },
      { key: 'attribution_honesty', label: 'Attribution honesty & limitations', weight: 2, evidenceHint: 'Limitations narrative' },
    ],
  },
  {
    id: 6,
    key: 'resources',
    title: 'Resources & Stewardship',
    weight: 8,
    rationale:
      'Judge HOW WELL AVAILABLE RESOURCES WERE USED, not HOW RICH THE PROJECT WAS. Zero-budget projects may receive full marks.',
    criteria: [
      { key: 'resource_stewardship', label: 'Stewardship / efficient use of available resources', weight: 2, evidenceHint: 'Resource pathway + outputs' },
      { key: 'resource_traceability', label: 'Traceability & verification', weight: 2, evidenceHint: 'Receipts + handover records' },
      { key: 'resource_appropriateness', label: 'Appropriateness / proportionality', weight: 2, evidenceHint: 'Resource ledger + activity need' },
      { key: 'resource_delivery_link', label: 'Resource → delivery link', weight: 2, evidenceHint: 'Enabled-by statements' },
    ],
  },
  {
    id: 7,
    key: 'partnerships',
    title: 'Partnership & Collaboration',
    weight: 8,
    rationale:
      'One meaningful partner can score strongly. Multiple logos do not automatically receive more marks.',
    criteria: [
      { key: 'stakeholder_relevance', label: 'Relevance & reciprocity of stakeholder relationship', weight: 2, evidenceHint: 'Partner/community identity + role' },
      { key: 'stakeholder_role_clarity', label: 'Clarity of stakeholder / partner role', weight: 2, evidenceHint: 'Partner roles' },
      { key: 'collaboration_quality', label: 'Quality of collaboration / co-design', weight: 2, evidenceHint: 'Coordination evidence' },
      { key: 'ownership_verification', label: 'Verification, ownership & continuation involvement', weight: 2, evidenceHint: 'Verification letter + handover' },
    ],
  },
  {
    id: 8,
    key: 'evidence',
    title: 'Evidence, Ethics & Verification',
    weight: 15,
    rationale:
      'Score only AFTER the complete evidence audit. Do not count files — judge what those files actually prove.',
    criteria: [
      { key: 'participation_evidence', label: 'Evidence supports participation / hours', weight: 2, evidenceHint: 'Attendance evidence' },
      { key: 'activity_output_evidence', label: 'Evidence supports activities / outputs', weight: 3, evidenceHint: 'Activity/output evidence' },
      { key: 'beneficiary_scale_evidence', label: 'Evidence supports beneficiaries / scale', weight: 2, evidenceHint: 'Beneficiary reach evidence' },
      { key: 'outcome_evidence', label: 'Evidence supports outcomes / change', weight: 3, evidenceHint: 'Before/after outcome evidence' },
      { key: 'resource_partner_evidence', label: 'Resource / partner evidence', weight: 2, evidenceHint: 'Resource/stakeholder evidence' },
      { key: 'ethics_integrity', label: 'Ethics, consent, consistency & integrity', weight: 2, evidenceHint: 'Evidence declarations + consistency scan' },
      { key: 'evidence_coverage_traceability', label: 'Evidence coverage & traceability', weight: 1, evidenceHint: 'Claim-to-file mapping' },
    ],
  },
  {
    id: 9,
    key: 'learning',
    title: 'Reflection & Academic Growth',
    weight: 7,
    rationale:
      'Score specificity and self-awareness, not polished language. External evidence is not required for genuine personal reflection.',
    criteria: [
      { key: 'personal_learning', label: 'Specific, honest personal learning', weight: 2, evidenceHint: 'Personal reflection' },
      { key: 'academic_application', label: 'Application of discipline / knowledge where relevant', weight: 1.5, evidenceHint: 'Academic application' },
      { key: 'ethical_understanding', label: 'Ethical / community understanding', weight: 1.5, evidenceHint: 'Reflection narrative' },
      { key: 'self_awareness', label: 'Self-awareness, challenge & future improvement', weight: 2, evidenceHint: 'Future-action reflection' },
    ],
  },
  {
    id: 10,
    key: 'sustainability',
    title: 'Sustainability & Handover',
    weight: 7,
    rationale:
      'Not every project must continue forever. An honest No or Partial with clear reasoning may score higher than an unsupported Yes.',
    criteria: [
      { key: 'continuation_assessment', label: 'Realistic continuation assessment', weight: 2, evidenceHint: 'Sustainability narrative' },
      { key: 'named_ownership', label: 'Named ownership / handover', weight: 2, evidenceHint: 'Handover record' },
      { key: 'continuation_mechanism', label: 'Continuation mechanism / follow-up', weight: 2, evidenceHint: 'Handover + follow-up' },
      { key: 'scaling_realism', label: 'Scaling / system influence realism', weight: 1, evidenceHint: 'Scaling statement' },
    ],
  },
];

export const CII_V2_BASE_MAX = CII_V2_SECTIONS.reduce((sum, s) => sum + s.weight, 0); // 100
export const CII_V2_BONUS_MAX = 5; // Extra-Mile uplift
export const CII_V2_MAX = 100;

export interface CiiV2Level {
  level: number;
  min: number;
  max: number;
  name: string;
  quality: string;
  icon: string;
}

export const CII_V2_LEVELS: CiiV2Level[] = [
  { level: 7, min: 92, max: 100, name: 'Transformative Impact Contributor', quality: 'PHENOMENAL', icon: '🏆' },
  { level: 6, min: 84, max: 91.999, name: 'Distinguished Impact Contributor', quality: 'EXCELLENT', icon: '💎' },
  { level: 5, min: 75, max: 83.999, name: 'Strong Impact Contributor', quality: 'VERY GOOD', icon: '⭐' },
  { level: 4, min: 67, max: 74.999, name: 'Developing Impact Contributor', quality: 'GOOD', icon: '🌟' },
  { level: 3, min: 58, max: 66.999, name: 'Emerging Community Contributor', quality: 'AVERAGE', icon: '🌱' },
  { level: 2, min: 48, max: 57.999, name: 'Foundation Stage Contributor', quality: 'FOUNDATION', icon: '🔹' },
  { level: 1, min: 0, max: 47.999, name: 'Participation Acknowledgement', quality: 'BASIC', icon: '🔸' },
];

export interface CiiV2BonusTier {
  label: string;
  amount: number;
}

export interface CiiV2BonusChannel {
  key: 'effort' | 'resources' | 'partners' | 'outcome';
  name: string;
  max: number;
  tiers: CiiV2BonusTier[];
}

/** Extra-Mile channels (v3.1). Keys kept for stored/UI compatibility. */
export const CII_V2_BONUS_CHANNELS: CiiV2BonusChannel[] = [
  {
    key: 'effort',
    name: 'Extra verified effort above the opportunity minimum',
    max: 1.25,
    tiers: [
      { label: '≤ 1.24×', amount: 0 },
      { label: '1.25–1.49×', amount: 0.25 },
      { label: '1.50–1.99×', amount: 0.5 },
      { label: '2.00–2.49×', amount: 0.75 },
      { label: '≥ 2.50×', amount: 1.25 },
    ],
  },
  {
    key: 'resources',
    name: 'Exceptional resource mobilisation',
    max: 1.25,
    tiers: [
      { label: 'None', amount: 0 },
      { label: 'Useful additional verified contribution', amount: 0.25 },
      { label: 'Multiple meaningful resources / notable initiative', amount: 0.5 },
      { label: 'Resources materially strengthen delivery', amount: 0.75 },
      { label: 'Significant external leverage', amount: 1 },
      { label: 'Exceptional verified mobilisation', amount: 1.25 },
    ],
  },
  {
    key: 'partners',
    name: 'Exceptional partnership building',
    max: 1.25,
    tiers: [
      { label: 'None', amount: 0 },
      { label: 'Activates one useful stakeholder', amount: 0.25 },
      { label: 'One genuine participating partner', amount: 0.5 },
      { label: 'Partner meaningfully contributes', amount: 0.75 },
      { label: 'Co-delivery / sustained collaboration', amount: 1 },
      { label: 'Continuation / multi-stakeholder coordination', amount: 1.25 },
    ],
  },
  {
    key: 'outcome',
    name: 'Exceptional outcome contribution',
    max: 1.25,
    tiers: [
      { label: 'None', amount: 0 },
      { label: 'Clearly above-normal verified result', amount: 0.25 },
      { label: 'Meaningful measurable improvement', amount: 0.5 },
      { label: 'Strong verified beneficiary change', amount: 0.75 },
      { label: 'Unusually strong verified impact', amount: 1 },
      { label: 'Exceptional evidence-backed outcome', amount: 1.25 },
    ],
  },
];

export function sectionById(id: number): CiiV2Section | undefined {
  return CII_V2_SECTIONS.find((s) => s.id === id);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CiiV2CriterionAnchor {
  key: string;
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
  /** v3.1 Extra-Mile D — exceptional outcome (optional for older payloads). */
  outcome?: number;
}

export interface CiiV2EvidenceRow {
  id: string;
  file: string;
  claim: string;
  type: string;
  match: number;
  verdict: 'MATCH' | 'PARTIAL' | 'MISMATCH';
  claimSupport?: 'supported' | 'partially_supported' | 'unsupported' | 'contradicted';
  flag?: string;
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

function anchorFor(input: CiiV2SectionInput | undefined, criterionKey: string): number {
  const found = input?.criteria.find((c) => c.key === criterionKey);
  const anchor = found?.anchor ?? 0;
  return Math.min(4, Math.max(0, Math.round(anchor)));
}

function noteFor(input: CiiV2SectionInput | undefined, criterionKey: string): string | undefined {
  return input?.criteria.find((c) => c.key === criterionKey)?.note;
}

function scoreSection(section: CiiV2Section, input: CiiV2SectionInput | undefined): CiiV2SectionResult {
  const criteria = section.criteria.map((c) => {
    const anchor = anchorFor(input, c.key);
    const factor = CII_V2_ANCHOR_FACTORS[anchor] ?? 0;
    const points = round2(c.weight * factor);
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
  return CII_V2_LEVELS.find((l) => score >= l.min && score <= l.max) || CII_V2_LEVELS[CII_V2_LEVELS.length - 1];
}

/** v3.1 high-tier quality gates (sections 4/5/8/10). */
export function qualityGateCap(params: {
  base: number;
  section4Score: number;
  section5Score: number;
  section8Score: number;
  section10Score: number;
  integrityPenalty: number;
}): number {
  const s4 = sectionById(4)!;
  const s5 = sectionById(5)!;
  const s8 = sectionById(8)!;
  const s10 = sectionById(10)!;
  const act = params.section4Score / s4.weight;
  const out = params.section5Score / s5.weight;
  const evid = params.section8Score / s8.weight;
  const sus = params.section10Score / s10.weight;
  const { integrityPenalty } = params;

  if (
    out >= 0.8 &&
    evid >= 0.85 &&
    sus >= 0.7 &&
    integrityPenalty === 0
  ) {
    return 7;
  }
  if (out >= 0.7 && evid >= 0.7 && sus >= 0.55 && integrityPenalty < 3) {
    return 6;
  }
  if (act >= 0.65 && out >= 0.55 && evid >= 0.55 && integrityPenalty < 5) {
    return 5;
  }
  return 4;
}

export function levelFor(score: number, gateCap: number): CiiV2Level {
  const numeric = numericLevelFor(score);
  const cappedLevel = Math.min(numeric.level, gateCap);
  return CII_V2_LEVELS.find((l) => l.level === cappedLevel) || numeric;
}

export function gateExplanationFor(finalScore: number, gateCap: number): string {
  const numeric = numericLevelFor(finalScore);
  const actual = levelFor(finalScore, gateCap);
  if (numeric.level === actual.level) {
    return `Quality gates satisfied for Level ${actual.level}.`;
  }
  return `Numeric score reaches Level ${numeric.level}, but the badge is capped at Level ${actual.level} because a required outcome/evidence/sustainability or integrity gate is not met.`;
}

export function computeCiiV2Result(input: CiiV2ComputeInput): CiiV2Result {
  const inputById = new Map(input.sections.map((s) => [s.id, s]));
  const sections = CII_V2_SECTIONS.map((s) => scoreSection(s, inputById.get(s.id)));

  const individualCore = sections.find((s) => s.id === 1)?.score ?? 0;
  const projectQuality = round2(
    sections.filter((s) => s.id !== 1).reduce((sum, s) => sum + s.score, 0),
  );
  const base = round2(individualCore + projectQuality);

  const bonus = {
    effort: clampBonusAmount(input.bonus.effort, 1.25),
    resources: clampBonusAmount(input.bonus.resources, 1.25),
    partners: clampBonusAmount(input.bonus.partners, 1.25),
    outcome: clampBonusAmount(input.bonus.outcome ?? 0, 1.25),
  };
  const bonusTotal = round2(
    Math.min(
      CII_V2_BONUS_MAX,
      bonus.effort + bonus.resources + bonus.partners + bonus.outcome,
    ),
  );

  const integrityPenalty = Math.max(0, input.integrityPenalty || 0);
  const final = round1(
    Math.min(100, Math.max(0, base + bonusTotal - integrityPenalty)),
  );

  const section4Score = sections.find((s) => s.id === 4)?.score ?? 0;
  const section5Score = sections.find((s) => s.id === 5)?.score ?? 0;
  const section8Score = sections.find((s) => s.id === 8)?.score ?? 0;
  const section10Score = sections.find((s) => s.id === 10)?.score ?? 0;

  const gateCap = qualityGateCap({
    base,
    section4Score,
    section5Score,
    section8Score,
    section10Score,
    integrityPenalty,
  });
  const numericLevel = numericLevelFor(final).level;
  const level = levelFor(final, gateCap);
  const gateExplanation = gateExplanationFor(final, gateCap);

  const evidence = input.evidence || [];
  const evidenceAverage = evidence.length
    ? Math.round(evidence.reduce((sum, e) => sum + (e.match || 0), 0) / evidence.length)
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
    cii_v2_framework_version: 'v3.1-balanced',
    base_max: CII_V2_BASE_MAX,
    bonus_max: CII_V2_BONUS_MAX,
    max_total: CII_V2_MAX,
    sections: CII_V2_SECTIONS,
    levels: CII_V2_LEVELS,
    bonus_channels: CII_V2_BONUS_CHANNELS,
    anchors: CII_V2_ANCHORS,
    anchor_factors: CII_V2_ANCHOR_FACTORS,
  };
}

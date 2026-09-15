/**
 * FYP AI Analysis — AI-assisted pre-analysis of a submitted FYP/Thesis for faculty review.
 *
 * Additive to the existing deterministic FYP Merit Model (merit-model/fyp-merit-model.util.ts) —
 * that rubric keeps ranking approved FYPs exactly as it does today. This is a separate, AI-scored
 * 100-point rubric ("FYP-MM 1.0" per the locked design mockup) that a supervisor can run before
 * deciding whether to approve/revise/reject a submission, mirroring the CII v2 pattern used for
 * Community Service reports (see reports/cii-v2.constants.ts): the AI supplies a per-dimension
 * score + rationale, all arithmetic (total, anti-inflation gates, classification band) is
 * recomputed server-side from those scores — the model's own totals are never trusted.
 *
 * Keep in sync with the locked "CIEL_PK_FYP_Faculty_Review_Loop" design mockup rubric.
 */

export interface FypAiDimension {
  key: string;
  label: string;
  max: number;
}

export const FYP_AI_RUBRIC: FypAiDimension[] = [
  { key: 'challenge', label: 'Challenge, Purpose & Significance', max: 10 },
  { key: 'grounding', label: 'Disciplinary Grounding & Context', max: 10 },
  { key: 'originality', label: 'Originality, Independence & Contribution', max: 15 },
  { key: 'rigor', label: 'Method / Process & Disciplinary Rigor', max: 20 },
  { key: 'analysis', label: 'Analysis, Development & Critical Reasoning', max: 15 },
  { key: 'output', label: 'Quality & Resolution of Final Output', max: 15 },
  { key: 'evidence', label: 'Evidence, Validation & Results', max: 10 },
  { key: 'reflection', label: 'Limitations, Reflection & Future Direction', max: 5 },
];

export const FYP_AI_MAX = FYP_AI_RUBRIC.reduce((sum, d) => sum + d.max, 0); // 100

export interface FypAiSection {
  key: string;
  label: string;
}

/** Maps 1:1 onto FypEntry.sectionSummaries — the AI comments on the student's own section text. */
export const FYP_AI_SECTIONS: FypAiSection[] = [
  { key: 'project', label: 'Project & Route' },
  { key: 'background', label: 'Background & Problem' },
  { key: 'objectives', label: 'Objectives & Scope' },
  { key: 'literature', label: 'Literature / Groundwork' },
  { key: 'methodology', label: 'Methodology' },
  { key: 'findings', label: 'Findings & Evidence' },
  { key: 'sdg', label: 'Sustainability (SDG)' },
  { key: 'reflection', label: 'Reflection' },
];

export interface FypAiLevel {
  min: number;
  name: string;
}

export const FYP_AI_LEVELS: FypAiLevel[] = [
  { min: 90, name: 'Exceptional / Benchmark' },
  { min: 80, name: 'Excellent / Advanced' },
  { min: 70, name: 'Strong' },
  { min: 60, name: 'Competent / Proficient' },
  { min: 50, name: 'Developing / Basic' },
  { min: 40, name: 'Foundational / Weak' },
  { min: 0, name: 'Insufficiently Demonstrated' },
];

export function fypAiClassification(score: number): string {
  return (
    FYP_AI_LEVELS.find((l) => score >= l.min) ||
    FYP_AI_LEVELS[FYP_AI_LEVELS.length - 1]
  ).name;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface FypAiDimensionInput {
  key: string;
  score: number;
  rationale?: string;
}

export interface FypAiSectionInput {
  key: string;
  analysis: string;
}

export interface FypAiComputeInput {
  dimensions: FypAiDimensionInput[];
}

export interface FypAiDimensionResult {
  key: string;
  label: string;
  max: number;
  score: number;
  rationale?: string;
}

export interface FypAiResult {
  dimensions: FypAiDimensionResult[];
  rawTotal: number;
  final: number;
  classification: string;
  gatesApplied: string[];
}

function dimensionScore(
  dims: FypAiDimensionInput[],
  key: string,
  max: number,
): { score: number; rationale?: string } {
  const found = dims.find((d) => d.key === key);
  const score = Math.min(max, Math.max(0, round1(Number(found?.score ?? 0))));
  return { score, rationale: found?.rationale };
}

/**
 * Recomputes the FYP AI total + classification server-side from per-dimension scores — never
 * trusts the AI's (or a faculty edit request's) own reported total. Mirrors computeCiiV2Result.
 * Anti-inflation gates are ported 1:1 from the locked design mockup's saveFacultyEdits() gates.
 */
export function computeFypAiResult(input: FypAiComputeInput): FypAiResult {
  const dimensions: FypAiDimensionResult[] = FYP_AI_RUBRIC.map((d) => {
    const { score, rationale } = dimensionScore(input.dimensions, d.key, d.max);
    return { key: d.key, label: d.label, max: d.max, score, rationale };
  });

  const byKey = new Map(dimensions.map((d) => [d.key, d.score]));
  const originality = byKey.get('originality') ?? 0;
  const rigor = byKey.get('rigor') ?? 0;
  const analysis = byKey.get('analysis') ?? 0;
  const output = byKey.get('output') ?? 0;
  const evidence = byKey.get('evidence') ?? 0;

  const rawTotal = round1(dimensions.reduce((sum, d) => sum + d.score, 0));
  let final = Math.min(FYP_AI_MAX, Math.max(0, rawTotal));
  const gatesApplied: string[] = [];

  // Ported 1:1 from the locked mockup gates (CIEL_PK_FYP_Faculty_Review_Loop_FINAL_v4).
  if (
    final >= 90 &&
    !(originality >= 12 && rigor >= 17 && analysis >= 12 && output >= 13 && evidence >= 8)
  ) {
    final = Math.min(final, 89.9);
    gatesApplied.push(
      'Capped below Exceptional/Benchmark — Originality, Rigor, Analysis, Output and Evidence must all clear their quality-gate thresholds.',
    );
  }
  if (rigor < 10) {
    final = Math.min(final, 59);
    gatesApplied.push('Capped at 59 — Method/Process & Disciplinary Rigor scored below half.');
  }
  if (output < 8) {
    final = Math.min(final, 64);
    gatesApplied.push('Capped at 64 — Quality & Resolution of Final Output scored below half.');
  }
  if (originality < 7) {
    final = Math.min(final, 74);
    gatesApplied.push('Capped at 74 — Originality, Independence & Contribution scored below half.');
  }

  return {
    dimensions,
    rawTotal,
    final: round1(final),
    classification: fypAiClassification(final),
    gatesApplied,
  };
}

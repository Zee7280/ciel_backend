/**
 * Ranking Studio: deterministic, pure computation. Given the evaluated package pool of a ranking
 * run, it answers "rank these projects (or groups of them) by this angle, for this audience".
 * Nothing here calls AI or the database; the approved CII is read, never written, and the same
 * input always yields the same standings, which is what lets a published ranking be audited.
 *
 * Source of truth for the design: CIEL_PK_Super_Admin_Ranking_Studio.html.
 */
import { createHash } from 'crypto';
import { StudentReport } from '../reports/entities/student-report.entity';
import { communityAwardInputsFromReport } from '../reports/community-award.util';
import { resolveMediaVisibility } from '../reports/media-visibility.util';
import { trackingOrganizationName } from '../reports/tracking-org-name.util';
import {
  NPE_CRITERIA,
  NPE_EVIDENCE_FACTORS,
  NPE_RUBRIC_VERSION,
  type NpeCriterionKey,
  type NpeEvidenceConfidence,
} from './npe-ranking.constants';

// ---------------------------------------------------------------------------------------------
// Lenses (what to rank by) and group-by (what to compare)
// ---------------------------------------------------------------------------------------------

export type StudioLens =
  | 'excellence'
  | 'cii'
  | NpeCriterionKey
  | 'hours'
  | 'reach'
  | 'funds'
  | 'custom';

export type StudioGroupBy =
  | 'project'
  | 'university'
  | 'department'
  | 'instructor'
  | 'sdg'
  | 'skill'
  | 'partner'
  | 'city';

export const STUDIO_LENSES: Record<
  StudioLens,
  { title: string; description: string; kind: 'points' | 'rubric' | 'hours' | 'people' | 'currency'; needsEvaluation: boolean }
> = {
  excellence: {
    title: 'Overall Project Excellence',
    description: 'Independent evidence-based comparison (90%) plus approved CII (10%)',
    kind: 'points',
    needsEvaluation: true,
  },
  cii: {
    title: 'Approved CII Score',
    description: 'Exact locked CII score from Admin approval',
    kind: 'points',
    needsEvaluation: false,
  },
  impact: { title: 'Community Impact', description: 'Evidence-based assessment of changes in the community', kind: 'rubric', needsEvaluation: true },
  sdg: { title: 'SDG Contribution', description: 'Evidence-based contribution to declared SDG', kind: 'rubric', needsEvaluation: true },
  learning: { title: 'Student Skills & Learning', description: 'Documented competence and reflection', kind: 'rubric', needsEvaluation: true },
  sustain: { title: 'Sustainability', description: 'Ownership and sustained-benefit rubric', kind: 'rubric', needsEvaluation: true },
  partner: { title: 'Partner Collaboration', description: 'Quality of partner involvement', kind: 'rubric', needsEvaluation: true },
  need: { title: 'Community Need & Relevance', description: 'Response to a documented local need', kind: 'rubric', needsEvaluation: true },
  efficiency: { title: 'Resource Efficiency', description: 'Outcome quality relative to resources', kind: 'rubric', needsEvaluation: true },
  scale: { title: 'Transferability', description: 'Replicable learning and practice', kind: 'rubric', needsEvaluation: true },
  hours: { title: 'Verified Service Hours', description: 'Verified team service hours from the approved report', kind: 'hours', needsEvaluation: false },
  reach: { title: 'Beneficiaries Reached', description: 'Documented beneficiary reach, not proof of change', kind: 'people', needsEvaluation: false },
  funds: { title: 'Resources Mobilized (PKR)', description: 'Documented cash and in-kind value, not proof of impact', kind: 'currency', needsEvaluation: false },
  custom: { title: 'Custom Weighted Excellence', description: 'Your selected weighting of eligible evidence-based measures', kind: 'points', needsEvaluation: true },
};

export const STUDIO_GROUPS: Record<StudioGroupBy, string> = {
  project: 'Individual projects',
  university: 'Universities',
  department: 'Departments',
  instructor: 'Instructors',
  sdg: 'SDGs',
  skill: 'Skills',
  partner: 'Partners',
  city: 'Cities',
};

export function isStudioLens(v: unknown): v is StudioLens {
  return typeof v === 'string' && v in STUDIO_LENSES;
}
export function isStudioGroup(v: unknown): v is StudioGroupBy {
  return typeof v === 'string' && v in STUDIO_GROUPS;
}

/** Custom weighting: the four measures the Studio lets the admin blend (normalized to 100%). */
export type StudioCustomWeights = { impact: number; sustain: number; learning: number; cii: number };
export const DEFAULT_CUSTOM_WEIGHTS: StudioCustomWeights = { impact: 35, sustain: 20, learning: 25, cii: 20 };

export function normalizeCustomWeights(raw: unknown): StudioCustomWeights {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof StudioCustomWeights) => {
    const n = Number(src[k]);
    return Number.isFinite(n) && n >= 0 ? Math.min(100, n) : DEFAULT_CUSTOM_WEIGHTS[k];
  };
  const out = { impact: pick('impact'), sustain: pick('sustain'), learning: pick('learning'), cii: pick('cii') };
  if (out.impact + out.sustain + out.learning + out.cii <= 0) return { ...DEFAULT_CUSTOM_WEIGHTS };
  return out;
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

export type StudioFilters = {
  university?: string;
  department?: string;
  instructor?: string;
  sdg?: string;
  skills?: string;
  year?: string;
  month?: string;
  semester?: string;
  city?: string;
  partner?: string;
  activity?: string;
  theme?: string;
  ciiBadge?: string;
  privacy?: string;
  dateFrom?: string;
  dateTo?: string;
  minHours?: number;
  minCii?: number;
  teamSize?: string;
};

const FILTER_TEXT_KEYS = [
  'university', 'department', 'instructor', 'sdg', 'skills', 'year', 'month', 'semester',
  'city', 'partner', 'activity', 'theme', 'ciiBadge', 'privacy', 'teamSize',
] as const;

/** Whitelists and trims untrusted filter input; unknown keys and empty values are dropped. */
export function sanitizeStudioFilters(raw: unknown): StudioFilters {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of FILTER_TEXT_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 160);
  }
  for (const key of ['dateFrom', 'dateTo'] as const) {
    const v = src[key];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) out[key] = v.trim();
  }
  for (const key of ['minHours', 'minCii'] as const) {
    const v = src[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out as StudioFilters;
}

// ---------------------------------------------------------------------------------------------
// Facets of one approved package (everything the filters / groupings need)
// ---------------------------------------------------------------------------------------------

export type StudioFacets = {
  university: string;
  department: string;
  instructor: string;
  sdg: string;
  skills: string[];
  /** ISO date (YYYY-MM-DD) of the report submission, same date the Impact Wall flashcards use. */
  date: string;
  year: string;
  month: string;
  semester: string;
  city: string;
  partner: string;
  activity: string;
  theme: string;
  ciiBadge: string;
  privacy: string;
  teamSize: number;
  verifiedHours: number;
  reach: number;
  funds: number;
};

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Strips the leading emoji / pictograph the wizard prefixes to skill names ("💬 Communication"). */
export function cleanSkillName(value: unknown): string {
  return str(value).replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

export function buildStudioFacets(report: StudentReport): StudioFacets {
  const s1 = rec(report.section1);
  const lead = rec(s1.team_lead);
  const s3 = rec(report.section3);
  const s4 = rec(report.section4);
  const s6 = rec(report.section6);
  const s8 = rec(report.section8);
  const s9 = rec(report.section9);
  const opp = rec(report.opportunity);
  const loc = rec(opp.location);

  const stamp = report.reportSubmittedAt || report.submission_date || report.createdAt;
  const dt = stamp ? new Date(stamp) : null;
  const valid = dt && !Number.isNaN(dt.getTime());
  const date = valid ? dt!.toISOString().slice(0, 10) : '';
  const monthIdx = valid ? dt!.getUTCMonth() : -1;

  const sdgNum =
    rec(s3.primary_sdg).goal_number ?? report.primary_sdg_goal ?? null;
  const skillsRaw = Array.isArray(s9.skills_grown) ? s9.skills_grown : [];
  const skills = [...new Set(skillsRaw.map(cleanSkillName).filter((s) => s && !/^other$/i.test(s)))];

  const team = Array.isArray(s1.team_members) ? s1.team_members.length : 0;
  const metrics = rec(s1.metrics);
  const verified = num(communityAwardInputsFromReport(report).hours) || num(metrics.total_verified_hours);

  const summary = rec(s4.project_summary);
  const reach =
    num(summary.distinct_total_beneficiaries) ||
    num(s4.total_beneficiaries) ||
    num(rec(report.opportunity?.objectives).beneficiaries_count);

  const resources = Array.isArray(s6.resources) ? s6.resources : [];
  const funds =
    str(s6.use_resources).toLowerCase() === 'yes'
      ? resources.reduce((sum: number, r) => {
          const row = rec(r);
          return /pkr|rs\.?|rupee/i.test(str(row.unit)) ? sum + num(row.amount) : sum;
        }, 0)
      : 0;

  const visibility = resolveMediaVisibility(s8.media_visible ?? s8.media_usage);
  const privacy =
    visibility === 'public' ? 'Public' : visibility === 'restricted' ? 'Restricted' : 'Confidential';

  const types = Array.isArray(opp.types) ? (opp.types as unknown[]) : [];
  const activityRaw = str(types[0]).replace(/^Other:\s*/i, '');
  const lockedBadge = rec(rec(report.ciiV45Lock).finalBadge);
  const storedBadge = rec(rec(report.ciiV45).finalBadge);

  return {
    university:
      str(lead.university) || str(report.student?.university) || str(report.student?.institution) || '—',
    department: str(lead.degree) || str(report.student?.department) || '—',
    instructor:
      str(s1.faculty_supervisor_name) || str(report.faculty?.name) || '',
    sdg: sdgNum ? `SDG ${sdgNum}` : '',
    skills,
    date,
    year: valid ? String(dt!.getUTCFullYear()) : '',
    month: valid ? String(monthIdx + 1).padStart(2, '0') : '',
    semester: valid ? (monthIdx < 6 ? 'Spring' : 'Fall') : '',
    city: str(loc.city),
    partner: str(trackingOrganizationName(report.opportunity as never)) || '',
    activity: activityRaw,
    theme: str(report.problem_category) || str(rec(report.section2).problem_category),
    ciiBadge: str(lockedBadge.name) || str(storedBadge.name),
    privacy,
    teamSize: 1 + team,
    verifiedHours: Math.round(verified * 10) / 10,
    reach: Math.round(reach),
    funds: Math.round(funds),
  };
}

// ---------------------------------------------------------------------------------------------
// One candidate project, and the filter that selects among them
// ---------------------------------------------------------------------------------------------

export type StudioCandidate = {
  id: string;
  title: string;
  /** Eligibility gate result. Only 'Eligible' / 'Ranked' packages can take part in a ranking. */
  gateOk: boolean;
  /** Fully read by the AI evaluator with no open flags (required for evidence-based lenses). */
  evaluated: boolean;
  reason: string;
  cii: number | null;
  /** Per-criterion judgment from the stored evaluation (null until the package is read). */
  criteria: Record<string, { anchor: number; confidence: NpeEvidenceConfidence }> | null;
  /** Excellence score under the run's rubric (null until evaluated). */
  excellence: { total: number; criteria: Record<string, number> } | null;
  facets: StudioFacets;
};

export function matchesStudioFilters(c: StudioCandidate, f: StudioFilters): boolean {
  const x = c.facets;
  if (f.university && x.university !== f.university) return false;
  if (f.department && x.department !== f.department) return false;
  if (f.instructor && x.instructor !== f.instructor) return false;
  if (f.sdg && x.sdg !== f.sdg) return false;
  if (f.skills && !x.skills.includes(f.skills)) return false;
  if (f.year && x.year !== f.year) return false;
  if (f.month && x.month !== f.month) return false;
  if (f.semester && x.semester !== f.semester) return false;
  if (f.city && x.city !== f.city) return false;
  if (f.partner && x.partner !== f.partner) return false;
  if (f.activity && x.activity !== f.activity) return false;
  if (f.theme && x.theme !== f.theme) return false;
  if (f.ciiBadge && x.ciiBadge !== f.ciiBadge) return false;
  if (f.privacy && x.privacy !== f.privacy) return false;
  if (f.dateFrom && (!x.date || x.date < f.dateFrom)) return false;
  if (f.dateTo && (!x.date || x.date > f.dateTo)) return false;
  if (f.minHours != null && x.verifiedHours < f.minHours) return false;
  if (f.minCii != null && (c.cii == null || c.cii < f.minCii)) return false;
  if (f.teamSize) {
    const [min, max] = f.teamSize.split('-').map(Number);
    if (Number.isFinite(min) && x.teamSize < min) return false;
    if (Number.isFinite(max) && x.teamSize > max) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Metric of one project under a lens
// ---------------------------------------------------------------------------------------------

/** anchor 0–5 as 0–100, with the same per-criterion evidence factor the Excellence score uses
 * (an unsupported criterion earns nothing; it is never silently replaced by another number). */
function criterionPercent(c: StudioCandidate, key: string): number | null {
  const j = c.criteria?.[key];
  if (!j || !Number.isFinite(j.anchor)) return null;
  const factor = NPE_EVIDENCE_FACTORS[j.confidence] ?? 0;
  return (j.anchor / 5) * 100 * factor;
}

export function studioMetric(
  c: StudioCandidate,
  lens: StudioLens,
  weights: StudioCustomWeights,
): number | null {
  switch (lens) {
    case 'cii':
      return c.cii;
    case 'hours':
      return c.facets.verifiedHours;
    case 'reach':
      return c.facets.reach;
    case 'funds':
      return c.facets.funds;
    case 'excellence':
      return c.excellence ? c.excellence.total : null;
    case 'custom': {
      const impact = criterionPercent(c, 'impact');
      const sustain = criterionPercent(c, 'sustain');
      const learning = criterionPercent(c, 'learning');
      if (impact == null || sustain == null || learning == null || c.cii == null) return null;
      const total = weights.impact + weights.sustain + weights.learning + weights.cii || 1;
      const cii = Math.min(100, c.cii);
      return (
        (weights.impact * impact + weights.sustain * sustain + weights.learning * learning + weights.cii * cii) /
        total
      );
    }
    default:
      return criterionPercent(c, lens);
  }
}

// ---------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------

export type StudioRow = {
  rank: number;
  /** Project id (report id) for project rankings, otherwise the group key (e.g. a university). */
  id: string;
  label: string;
  projectCount: number;
  projectIds: string[];
  metric: number;
  /** Mean locked CII of the projects behind this row. */
  cii: number | null;
  previousRank?: number | null;
  movement?: 'up' | 'down' | 'same' | 'new' | 'cohort';
};

export type StudioRunInput = {
  lens: StudioLens;
  groupBy: StudioGroupBy;
  filters: StudioFilters;
  weights: StudioCustomWeights;
  candidates: StudioCandidate[];
  /** Minimum projects a group needs to be ranked (groups below it are listed as `thinGroups`). */
  minGroupSize?: number;
};

export type StudioResult = {
  lens: StudioLens;
  groupBy: StudioGroupBy;
  filters: StudioFilters;
  weights: StudioCustomWeights | null;
  rubricVersion: string;
  name: string;
  signature: string;
  rows: StudioRow[];
  /** Projects inside the filters that took part. */
  eligibleIds: string[];
  /** Projects inside the filters that did not (held for verification / not yet read). */
  heldIds: string[];
  /** Held only because the AI has not read them yet (gate passed): running the analyzer fixes this. */
  unreadIds: string[];
  heldReasons: Array<{ id: string; title: string; reason: string }>;
  thinGroups: Array<{ id: string; projectCount: number }>;
  populationCount: number;
};

const EPS = 1e-6;

function groupKeys(c: StudioCandidate, groupBy: StudioGroupBy): string[] {
  const x = c.facets;
  switch (groupBy) {
    case 'project':
      return [c.id];
    case 'skill':
      return x.skills;
    case 'university':
      return x.university && x.university !== '—' ? [x.university] : [];
    case 'department':
      return x.department && x.department !== '—' ? [x.department] : [];
    case 'instructor':
      return x.instructor ? [x.instructor] : [];
    case 'sdg':
      return x.sdg ? [x.sdg] : [];
    case 'partner':
      return x.partner ? [x.partner] : [];
    case 'city':
      return x.city ? [x.city] : [];
  }
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function prettyStudioFilter(key: string, value: string | number): string {
  if (key === 'month') return MONTH_NAMES[Number(value) - 1] || String(value);
  return String(value);
}

/** "Top Universities · Community Impact — SDG 4 · Lahore · 2026" (same wording as the design). */
export function studioRankingName(lens: StudioLens, groupBy: StudioGroupBy, f: StudioFilters): string {
  const lensTitle = STUDIO_LENSES[lens].title;
  const core =
    groupBy === 'project' ? lensTitle : `Top ${STUDIO_GROUPS[groupBy]} · ${lensTitle}`;
  const keys = ['sdg', 'skills', 'city', 'university', 'department', 'instructor', 'year', 'month'] as const;
  const facets = keys
    .filter((k) => f[k])
    .map((k) => prettyStudioFilter(k, f[k] as string));
  return `${core} — ${facets.length ? facets.join(' · ') : 'All eligible projects'}`;
}

/** Stable identity of "the same ranking" so repeat publications are recognised as updates. */
export function studioSignature(
  lens: StudioLens,
  groupBy: StudioGroupBy,
  filters: StudioFilters,
  weights: StudioCustomWeights | null,
  rubricVersion: string,
): string {
  const sortedFilters = Object.keys(filters)
    .sort()
    .map((k) => [k, (filters as Record<string, unknown>)[k]]);
  const payload = JSON.stringify({
    lens,
    groupBy,
    filters: sortedFilters,
    weights: lens === 'custom' ? weights : null,
    method: rubricVersion,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 40);
}

export function computeStudioRanking(
  input: StudioRunInput,
  rubricVersion: string = NPE_RUBRIC_VERSION,
): StudioResult {
  const { lens, groupBy, filters, weights, candidates } = input;
  const needsEvaluation = STUDIO_LENSES[lens].needsEvaluation;
  const population = candidates.filter((c) => matchesStudioFilters(c, filters));

  const eligible: Array<{ c: StudioCandidate; metric: number }> = [];
  const held: StudioCandidate[] = [];
  for (const c of population) {
    const metric = c.gateOk && (!needsEvaluation || c.evaluated) ? studioMetric(c, lens, weights) : null;
    if (metric == null || !Number.isFinite(metric)) held.push(c);
    else eligible.push({ c, metric });
  }

  const groups = new Map<string, Array<{ c: StudioCandidate; metric: number }>>();
  for (const row of eligible) {
    for (const key of groupKeys(row.c, groupBy)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
  }

  const minGroup = groupBy === 'project' ? 1 : Math.max(1, input.minGroupSize ?? 1);
  const thinGroups: StudioResult['thinGroups'] = [];
  const draft = [...groups.entries()]
    .filter(([id, list]) => {
      if (list.length >= minGroup) return true;
      thinGroups.push({ id, projectCount: list.length });
      return false;
    })
    .map(([id, list]) => {
      const metric = list.reduce((sum, r) => sum + r.metric, 0) / list.length;
      const ciis = list.map((r) => r.c.cii).filter((v): v is number => v != null);
      const first = list[0];
      return {
        id,
        label: groupBy === 'project' ? first.c.title : id,
        projectCount: list.length,
        projectIds: list.map((r) => r.c.id),
        metric,
        cii: ciis.length ? ciis.reduce((a, b) => a + b, 0) / ciis.length : null,
        tie: [
          first.c.excellence?.criteria?.impact ?? 0,
          first.c.excellence?.criteria?.sustain ?? 0,
          first.c.cii ?? 0,
        ],
      };
    });

  const tupleTies = groupBy === 'project' && (lens === 'excellence' || lens === 'custom');
  draft.sort((a, b) => {
    if (Math.abs(b.metric - a.metric) > EPS) return b.metric - a.metric;
    if (tupleTies) {
      for (let i = 0; i < 3; i++) {
        if (Math.round(b.tie[i] * 10000) !== Math.round(a.tie[i] * 10000)) {
          return Math.round(b.tie[i] * 10000) - Math.round(a.tie[i] * 10000);
        }
      }
    } else if (b.projectCount !== a.projectCount) {
      return b.projectCount - a.projectCount;
    }
    return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
  });

  // Competition ranking: equal results share a rank (1, 1, 3).
  let rank = 0;
  const rows: StudioRow[] = draft.map((row, i) => {
    const prev = draft[i - 1];
    const same =
      prev &&
      Math.abs(prev.metric - row.metric) <= EPS &&
      (!tupleTies || [0, 1, 2].every((k) => Math.round(prev.tie[k] * 10000) === Math.round(row.tie[k] * 10000)));
    if (!same) rank = i + 1;
    return {
      rank,
      id: row.id,
      label: row.label,
      projectCount: row.projectCount,
      projectIds: row.projectIds,
      metric: Math.round(row.metric * 100) / 100,
      cii: row.cii == null ? null : Math.round(row.cii * 10) / 10,
    };
  });

  const usesWeights = lens === 'custom';
  return {
    lens,
    groupBy,
    filters,
    weights: usesWeights ? weights : null,
    rubricVersion,
    name: studioRankingName(lens, groupBy, filters),
    signature: studioSignature(lens, groupBy, filters, usesWeights ? weights : null, rubricVersion),
    rows,
    eligibleIds: eligible.map((r) => r.c.id),
    heldIds: held.map((c) => c.id),
    unreadIds: held.filter((c) => c.gateOk && needsEvaluation && !c.evaluated).map((c) => c.id),
    heldReasons: held.map((c) => ({
      id: c.id,
      title: c.title,
      reason: !c.gateOk
        ? c.reason || 'Package held for verification.'
        : needsEvaluation && !c.evaluated
          ? 'Not yet read by the AI evaluator.'
          : 'Not enough documented data for this measure.',
    })),
    thinGroups,
    populationCount: population.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Publication: movement against the previous publication of the same ranking
// ---------------------------------------------------------------------------------------------

export function applyStudioMovement(
  rows: StudioRow[],
  eligibleIds: string[],
  prior: { rows: StudioRow[]; eligibleReportIds: string[] } | null,
): { rows: StudioRow[]; cohortComparable: boolean } {
  const sameCohort =
    !!prior &&
    JSON.stringify([...prior.eligibleReportIds].sort()) === JSON.stringify([...eligibleIds].sort());
  const old = new Map((sameCohort ? prior!.rows : []).map((r) => [r.id, r.rank]));
  return {
    cohortComparable: sameCohort,
    rows: rows.map((r) => {
      const previousRank = old.has(r.id) ? old.get(r.id)! : null;
      const movement: StudioRow['movement'] =
        previousRank === null
          ? prior
            ? 'cohort'
            : 'new'
          : previousRank > r.rank
            ? 'up'
            : previousRank < r.rank
              ? 'down'
              : 'same';
      return { ...r, previousRank, movement };
    }),
  };
}

export const STUDIO_CRITERIA = NPE_CRITERIA;
export type { NpeCriterionKey };

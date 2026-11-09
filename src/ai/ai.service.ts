import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { S3Service } from '../common/s3.service';
import {
  CII_V4_5_EVALUATOR_PROMPT,
  CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE,
} from './prompts/cii-v4-5-prompt.constant';
import { parseCiiV45Response } from './parse-cii-v4-5.util';
import { CiiV45EvaluatorPayload } from '../reports/cii-v4-5.constants';
import {
  buildFypAiEvaluatorPrompt,
  FYP_AI_JSON_ONLY_DEPLOYMENT_NOTE,
} from './prompts/fyp-ai-rubric.constant';
import { FypAiEvaluation, parseFypAiResponse } from './parse-fyp-ai.util';
import {
  NPE_RANKING_EVALUATOR_PROMPT,
  NPE_RANKING_JSON_ONLY_NOTE,
} from './prompts/npe-ranking-prompt.constant';
import {
  parseNpeRankingResponse,
  type NpeAiEvaluation,
} from '../ranking/parse-npe-ranking.util';
import { scrubPersonalText } from '../common/scrub-personal-text.util';
import { OPPORTUNITY_DRAFT_SYSTEM_PROMPT } from './prompts/opportunity-draft-prompt.constant';
import {
  buildOpportunityDraftPrompt,
  parseOpportunityDraftResponse,
  type OpportunityDraftFields,
  type OpportunityDraftInput,
} from './opportunity-draft.util';
import { ciiEvidenceInspectCache } from '../reports/build-ciel-pk-ai-evaluation-payload.util';

/** Shared rules for the executive flashcard section summaries (V12). Scoring prompts do not use this. */
const FLASHCARD_SUMMARY_RULES = `You write one section of the CIEL PK executive impact flashcard. This compresses recorded report fields for rapid academic review. It is not a score, and it does not replace the detailed report.

Rules:
- Use only the inputs below. Never invent hours, people, reach, money, partners, outcomes, or evidence.
- If a value is missing, write "not recorded" on that line. Do not hide a blank field.
- Do not claim SDG achievement, long-term causal impact, or that faculty has already verified the report.
- Plain text only. No markdown, bullets, or asterisks.
- Each labeled value is one short sentence, about 12–28 words.`;

type OpenAiCompletionOpts = {
  temperature?: number;
  /** When set, requests reproducible sampling (same inputs → same text for supported models). */
  seed?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  systemMessage?: string;
  /** Per-call OpenAI HTTP timeout. Defaults to OPENAI_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Per-call retries. CII skips HTTP retries so a slow run is not doubled. */
  maxAttempts?: number;
  /**
   * One extra attempt when HTTP 200 has no message text (typical when a reasoning
   * model spends max_completion_tokens on thinking and finish_reason is `length`).
   */
  retryEmptyOnce?: boolean;
  /** Overrides OPENAI_SUMMARY_MODEL for this call only (CII Analyzer uses its own model). */
  model?: string;
  /** GPT-5 reasoning effort. CII Analyzer uses `low` so JSON still has token budget. */
  reasoningEffort?: 'low' | 'medium' | 'high';
};

const DEFAULT_OPENAI_SUMMARY_MODEL = 'gpt-5.4';
const DEFAULT_OPENAI_CII_MODEL = 'gpt-5.6-sol';

function resolveOpenAiSummaryModel(): string {
  return (
    process.env.OPENAI_SUMMARY_MODEL?.trim() || DEFAULT_OPENAI_SUMMARY_MODEL
  );
}

function resolveCiiAnalyzerModel(): string {
  return process.env.OPENAI_CII_MODEL?.trim() || DEFAULT_OPENAI_CII_MODEL;
}

/** One part of a multimodal chat message (text, or an inline image the model can actually see). */
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
    };

/** What the evidence pass could and could not show the model — stored with the analysis. */
export interface EvidenceInspection {
  inspected: Array<{ id: string; name: string }>;
  notInspected: Array<{ id: string; name: string; reason: string }>;
}

const OPENAI_TIMEOUT_MS = 90_000;
const OPENAI_MAX_ATTEMPTS = 2;
/** High-reasoning + 8 photos made Analyze wait 2–3 minutes. Four low-detail images still verify claims. */
const EVIDENCE_MAX_IMAGES = 4;
const EVIDENCE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const EVIDENCE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);
/** PDF originals (receipts, registers, letters) are read as text, within a fixed budget. */
const EVIDENCE_MAX_PDFS = 3;
const EVIDENCE_MAX_PDF_BYTES = 8 * 1024 * 1024;
const EVIDENCE_PDF_MAX_PAGES = 12;
const EVIDENCE_PDF_CHARS_PER_FILE = 5_000;
const EVIDENCE_PDF_CHARS_TOTAL = 14_000;
const EVIDENCE_PDF_PARSE_TIMEOUT_MS = 15_000;

export interface AiSummarizeResult {
  summary: string;
  /** Student section summaries skip without a 500 when OpenAI is not configured. */
  skipped?: boolean;
  evidenceInspection?: EvidenceInspection;
  model?: string;
  auditMeta?: unknown;
  evaluationVersion?: string;
  ciiV45?: CiiV45EvaluatorPayload;
  fypAi?: FypAiEvaluation;
  npeRanking?: NpeAiEvaluation;
}

const ADMIN_EVAL_SECTIONS = new Set([
  'cii_v4_5_evaluation',
  'fyp_ai_evaluation',
  'npe_ranking_evaluation',
]);

function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m.includes('gpt-5.')
  );
}

function resolveOpenAiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return 'Failed to generate AI response';
}

type OpenAiChatResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
    };
  }>;
  error?: { message?: string };
};

/** Chat Completions may return a string, an array of parts, or blank content after reasoning. */
function extractOpenAiMessageText(responseJson: OpenAiChatResponse): string {
  const content = responseJson.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string')
          return part.text;
        return '';
      })
      .join('')
      .trim();
    if (joined) return joined;
  }
  return '';
}

function emptyOpenAiContentError(
  responseJson: OpenAiChatResponse,
): Error & { status: number } {
  const finish = responseJson.choices?.[0]?.finish_reason ?? '';
  const err = new Error(
    finish === 'length'
      ? 'The AI used its token budget on reasoning and returned no analysis. Please retry.'
      : 'OpenAI returned empty content',
  ) as Error & { status: number };
  err.status = 400;
  return err;
}

function textOnlyUserContent(content: string | OpenAiContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (part): part is { type: 'text'; text: string } => part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n\n');
}

/** Plain `String(value)` coercion of a dynamic (parsed-JSON) field, exactly as a template literal would. */
function promptText(value: unknown): string {
  return String(value);
}

/** `String(value ?? fallback)` for an unknown field (null/undefined → fallback, anything else stringified). */
function textOf(value: unknown, fallback: string): string {
  return value == null ? fallback : promptText(value);
}

/**
 * Section 2.3 (risk, safeguarding & consent) is for the admin evidence & ethics review and the
 * university safeguarding register. It must never influence the Section 2 CII score, so the
 * `section2_evaluation` prompt (which quotes the whole saved section) gets a copy without it.
 *
 * The student-facing Section 2 context summary (`section2`) does read the risk block — the
 * CIEL PK summary spec asks it to integrate risks, precautions, consent status and unresolved
 * items — but it never receives the named on-site safeguarding lead (a third party's personal
 * data); see `section2SummaryView`.
 */
const SAFEGUARDING_FIELD_KEYS = [
  'risk_factors',
  'risk_mitigation',
  'risk_consent',
  'risk_safeguarding_lead',
  'risk_unresolved',
] as const;

export function withoutSafeguardingFields<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const copy = { ...(data as Record<string, unknown>) };
  for (const key of SAFEGUARDING_FIELD_KEYS) delete copy[key];
  return copy as T;
}

/**
 * Section 2 payload as the context-summary prompt may see it: the safeguarding lead's name/role
 * is replaced by a yes/no flag, and the previously generated summary is dropped so the model
 * cannot echo its own earlier output instead of re-reading the answers.
 */
export function section2SummaryView<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const copy = { ...(data as Record<string, unknown>) };
  const lead = copy.risk_safeguarding_lead;
  copy.risk_safeguarding_lead_recorded =
    typeof lead === 'string' && lead.trim().length > 0;
  delete copy.risk_safeguarding_lead;
  delete copy.summary_text;
  return copy as T;
}

/** Human labels for the Section 2.3 chip ids (keep in sync with the student wizard). */
const SECTION2_RISK_FACTOR_LABELS: Record<string, string> = {
  children_present: 'children present',
  physical_work: 'physical work, tools or heights',
  beneficiary_photos: 'photographs of beneficiaries',
  personal_data: 'personal data collected',
  health_contact: 'health or medical contact',
  travel_to_site: 'travel to the site',
  handling_money: 'handling money',
  none: 'none identified',
};

const SECTION2_CONSENT_LABELS: Record<string, string> = {
  written: 'written consent obtained',
  verbal: 'verbal consent obtained',
  not_obtained: 'not obtained',
  not_applicable: 'not applicable',
};

const SECTION2_OTHER_SLOT_RE = /^__o_(\d+)$/;

function section2StringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
}

function section2Text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Prompt line: the answer, or an explicit blank marker (the model must not fill blanks). */
function section2Line(value: string): string {
  return value || '[not entered]';
}

/**
 * Baseline-evidence / needs-identification selections with the wizard's internal `__o_n`
 * "Other" slots resolved to the text the student typed.
 */
function section2EvidenceLabels(rec: Record<string, unknown>): string[] {
  const otherEntries = section2StringList(rec.baseline_other_entries);
  const legacyOther = section2Text(rec.baseline_evidence_other);
  return section2StringList(rec.baseline_evidence).map((token) => {
    if (token === 'Other') return legacyOther || 'Other (unspecified)';
    const match = SECTION2_OTHER_SLOT_RE.exec(token);
    if (!match) return token;
    const typed = Array.isArray(rec.baseline_other_entries)
      ? section2Text(rec.baseline_other_entries[Number(match[1])])
      : '';
    return typed || otherEntries[Number(match[1])] || 'Other (unspecified)';
  });
}

/** Selected needs / gaps with the "Other" chip resolved to the student's own words. */
function section2GapLabels(rec: Record<string, unknown>): string[] {
  const otherEntries = section2StringList(rec.system_gaps_other_entries);
  const legacyOther = section2Text(rec.system_gaps_other);
  return section2StringList(rec.system_gaps).flatMap((gap) => {
    if (gap !== 'Other') return [gap];
    if (otherEntries.length) return otherEntries;
    return [legacyOther || 'Other (unspecified)'];
  });
}

/** Readable field-by-field rendering of Section 2 for the context-summary prompt. */
function describeSection2ForSummary(data: unknown): string {
  const rec =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const discipline = section2Text(rec.discipline);
  const disciplineOther = section2Text(rec.discipline_other);
  // The wizard stores "Other…" in `discipline` and the typed field in `discipline_other`.
  const disciplineLabel =
    /^other/i.test(discipline) && disciplineOther
      ? disciplineOther
      : discipline;
  const riskIds = section2StringList(rec.risk_factors);
  const riskLabels = riskIds.map(
    (id) => SECTION2_RISK_FACTOR_LABELS[id] || id.replace(/_/g, ' '),
  );
  const consent = section2Text(rec.risk_consent);
  const consentLabel = consent
    ? SECTION2_CONSENT_LABELS[consent] || consent.replace(/_/g, ' ')
    : '';
  const leadRecorded =
    rec.risk_safeguarding_lead_recorded === true ||
    section2Text(rec.risk_safeguarding_lead).length > 0;
  const riskBlockAnswered =
    riskIds.length > 0 ||
    Boolean(section2Text(rec.risk_mitigation)) ||
    Boolean(consent) ||
    leadRecorded ||
    Boolean(section2Text(rec.risk_unresolved));

  return `2.1 QUICK QUESTIONS
- Problem identified (what existed before the project and why it needed intervention): ${section2Line(section2Text(rec.problem_statement))}
- Affected population: ${section2Line(section2Text(rec.affected_group))}
- Intended beneficiaries (number entered by the student): ${section2Line(section2Text(rec.affected_count))}
- Missing elements / selected needs: ${section2Line(section2GapLabels(rec).join('; '))}
- How the problem was identified (selected needs-identification methods): ${section2Line(section2EvidenceLabels(rec).join('; '))}
- Field of study: ${section2Line(disciplineLabel)}
- Academic contribution (how the student's academic knowledge helped understand or address the problem): ${section2Line(section2Text(rec.discipline_contribution))}

2.2 BASELINE STATEMENT
The student-facing baseline statement is composed from the 2.1 answers above and is shown separately on screen. Treat the 2.1 answers as the baseline source; mention a baseline measurement only if a figure or indicator is actually stated in them.

2.3 RISK, SAFEGUARDING & CONSENT${riskBlockAnswered ? '' : ' — not completed by the student'}
- Identified risks: ${section2Line(riskLabels.join('; '))}
- Precautions / safeguarding measures taken or planned: ${section2Line(section2Text(rec.risk_mitigation))}
- Consent status for photographs and personal data: ${section2Line(consentLabel)}
- Responsible safeguarding person on site: ${leadRecorded ? 'named by the student (identity withheld from this summary; do not invent a name or role)' : '[not entered]'}
- Unresolved risks or pending actions: ${section2Line(section2Text(rec.risk_unresolved))}`;
}

/**
 * Section 10 · 9.5 "Follow-up check" only records who will check the results later. It holds a
 * third party's name and email and must not influence scoring ("Not planned" is not a failure),
 * so the `section10_evaluation` prompt (which quotes the whole saved section) gets a copy
 * without it.
 *
 * The student-facing sustainability summary (`section10_summary`) does describe the follow-up
 * arrangement (planned / not planned, owner role, timing, what will be checked) because the
 * CIEL PK sustainability summary spec asks for it, but the owner's name and email never reach
 * the model; see `section10SummaryView`.
 */
const FOLLOWUP_FIELD_KEYS = [
  'followup_plan',
  'followup_no_reason',
  'followup_no_reason_other',
  'followup_decision_owner',
  'followup_owner_role',
  'followup_owner_name',
  'followup_owner_email',
  'followup_interval',
  'followup_custom_date',
  'followup_due_date',
  'followup_check',
  'followup_check_notes',
] as const;

export function withoutFollowUpFields<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const copy = { ...(data as Record<string, unknown>) };
  for (const key of FOLLOWUP_FIELD_KEYS) delete copy[key];
  return copy as T;
}

/**
 * Section 10 payload as the sustainability-summary prompt may see it: the follow-up owner's
 * name and email are replaced by a yes/no flag, and the previously generated summary is
 * dropped so the model re-reads the answers instead of echoing its own earlier output.
 */
export function section10SummaryView<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const copy = { ...(data as Record<string, unknown>) };
  const name = copy.followup_owner_name;
  const email = copy.followup_owner_email;
  copy.followup_owner_named =
    (typeof name === 'string' && name.trim().length > 0) ||
    (typeof email === 'string' && email.trim().length > 0);
  delete copy.followup_owner_name;
  delete copy.followup_owner_email;
  delete copy.summary_text;
  return copy as T;
}

const SECTION10_STATUS_LABELS: Record<string, string> = {
  yes: 'Yes — likely to continue independently',
  partially: 'Partial — some elements continue with support',
  partial: 'Partial — some elements continue with support',
  no: 'No — will not continue without further action',
};

const SECTION10_FOLLOWUP_PLAN_LABELS: Record<string, string> = {
  yes: 'Yes — a follow-up check is planned',
  no: 'No — no follow-up check is planned',
  later: 'Not decided yet',
};

const SECTION10_DECISION_OWNER_LABELS: Record<string, string> = {
  faculty: 'the assigned faculty supervisor',
  coordinator: 'the university community engagement coordinator',
  admin: 'CIEL PK Admin',
};

const SECTION10_INTERVAL_LABELS: Record<string, string> = {
  '1': '1 month after project end',
  '3': '3 months after project end',
  '6': '6 months after project end',
  '12': '12 months after project end',
  custom: 'a chosen date',
};

/** Strip the wizard's leading emoji / symbol from a chip label ("🛡️ Partner-led continuation"). */
function section10Choice(value: unknown): string {
  return (typeof value === 'string' ? value : '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

function section10IsOther(value: string): boolean {
  return /^other\b/i.test(value);
}

/** Readable field-by-field rendering of Section 10 (UI "Section 9") for the sustainability summary. */
function describeSection10ForSummary(data: unknown): string {
  const rec =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const line = (v: string) => v || '[not entered]';

  const statusRaw = text(rec.continuation_status || rec.status).toLowerCase();
  const status =
    SECTION10_STATUS_LABELS[statusRaw] ||
    text(rec.continuation_status || rec.status);

  const mechanismOther = text(rec.mechanism_other);
  const mechanisms = (Array.isArray(rec.mechanisms) ? rec.mechanisms : [])
    .map(section10Choice)
    .filter(Boolean)
    .map((m) =>
      section10IsOther(m) ? mechanismOther || 'Other (unspecified)' : m,
    );
  const noMechanism = mechanisms.some((m) =>
    /^no continuation mechanism/i.test(m),
  );

  const scaling = section10Choice(rec.scaling_potential || rec.scaling);
  const policy = section10Choice(rec.policy_influence || rec.policy);

  const plan = text(rec.followup_plan).toLowerCase();
  const planLabel = plan ? SECTION10_FOLLOWUP_PLAN_LABELS[plan] || plan : '';
  const noReasonRaw = text(rec.followup_no_reason);
  const noReason = section10IsOther(noReasonRaw)
    ? text(rec.followup_no_reason_other) || 'Other (unspecified)'
    : noReasonRaw;
  const decisionOwner = text(rec.followup_decision_owner);
  const ownerRole = text(rec.followup_owner_role);
  const ownerNamed =
    rec.followup_owner_named === true ||
    Boolean(text(rec.followup_owner_name)) ||
    Boolean(text(rec.followup_owner_email));
  const interval = text(rec.followup_interval);
  const intervalLabel = interval
    ? SECTION10_INTERVAL_LABELS[interval] || interval
    : '';
  const dueDate = text(rec.followup_due_date) || text(rec.followup_custom_date);
  const check = text(rec.followup_check);
  const checkNotes = text(rec.followup_check_notes);
  const followupAnswered =
    Boolean(plan) ||
    Boolean(ownerRole) ||
    ownerNamed ||
    Boolean(dueDate) ||
    Boolean(check);

  const followupLines: string[] = [];
  if (!followupAnswered) {
    followupLines.push('- Follow-up check: not completed by the student');
  } else {
    followupLines.push(`- Follow-up planned? ${line(planLabel)}`);
    if (plan === 'no') {
      followupLines.push(`- Reason no follow-up is planned: ${line(noReason)}`);
    } else if (plan === 'later') {
      followupLines.push(
        `- Who will decide later: ${line(SECTION10_DECISION_OWNER_LABELS[decisionOwner] || decisionOwner)}`,
      );
    } else {
      followupLines.push(`- Responsible person's role: ${line(ownerRole)}`);
      followupLines.push(
        `- Responsible person: ${ownerNamed ? 'named by the student (identity withheld from this summary; refer to them by role only, never invent a name)' : '[not entered]'}`,
      );
      followupLines.push(
        `- Timing: ${line(intervalLabel)}${dueDate ? ` (due ${dueDate})` : ''}`,
      );
      followupLines.push(
        `- What will be checked: ${line(check)}${checkNotes ? ` — notes: ${checkNotes}` : ''}`,
      );
      followupLines.push(
        '- Follow-up status: scheduled only — no follow-up visit has been recorded in this report',
      );
    }
  }

  return `9.1 WILL THE IMPACT CONTINUE AFTER YOU?
- Selected classification: ${line(status)}

9.2 WHAT CONTINUES, WHAT STOPS? (student's written explanation)
- Explanation: ${line(text(rec.continuation_details || rec.explanation))}
- What keeps it going (guided prompt): ${line(text(rec.continuation_keep_going))}
- Risks / what could stop it (guided prompt): ${line(text(rec.continuation_risk))}

9.3 WHAT KEEPS IT ALIVE? (selected continuation mechanisms)
- Selected: ${line(mechanisms.join('; '))}${noMechanism ? '\n- Note: the student selected "No continuation mechanism"' : ''}

9.4 SCALING & SYSTEM INFLUENCE
- Scaling potential (selected): ${line(scaling)}
- Long-term system influence (selected): ${line(policy)}

9.5 FOLLOW-UP CHECK
${followupLines.join('\n')}`;
}

/**
 * Loose view of the saved wizard section payloads that the flashcard prompts quote field by
 * field. The values are whatever the student wizard stored; the prompt stringifies them as-is.
 */
interface SectionPromptData {
  problem_statement?: unknown;
  affected_group?: unknown;
  system_gaps?: unknown;
  discipline?: unknown;
  discipline_other?: unknown;
  discipline_contribution?: unknown;
  baseline_evidence?: unknown;
  baseline_evidence_other?: unknown;
  primary_sdg?: {
    goal_number?: unknown;
    goal_title?: unknown;
    target_id?: unknown;
    indicator_id?: unknown;
  } | null;
  contribution_intent_statement?: unknown;
  student_contribution_intent_statement?: unknown;
  secondary_sdgs?: unknown;
  activity_blocks?: unknown;
  activities?: unknown;
  project_summary?: { distinct_total_beneficiaries?: unknown } | null;
  observed_change?: unknown;
  measurable_outcomes?: unknown;
  challenges?: unknown;
  use_resources?: unknown;
  resources?: unknown;
  has_partners?: unknown;
  partners?: unknown;
  has_evidence?: unknown;
  evidence_types?: unknown;
  description?: unknown;
  ethical_compliance?: unknown;
  ethics?: unknown;
  media_visible?: unknown;
  partner_verification?: unknown;
  academic_integration?: unknown;
  personal_learning?: unknown;
  academic_application?: unknown;
  skills_grown?: unknown;
  competency_scores?: unknown;
  competencies?: unknown;
  continuation_status?: unknown;
  status?: unknown;
  continuation_details?: unknown;
  explanation?: unknown;
  mechanisms?: unknown;
  scaling_potential?: unknown;
  scaling?: unknown;
  policy_influence?: unknown;
  policy?: unknown;
}

interface ActivityBlockReach {
  unique_beneficiaries?: unknown;
  beneficiaries_reached?: unknown;
}

/** Drop evidence originals/filenames and the bulky scoring table from the v5.0 report-quality prompt. */
function slimCiiPayloadForModel(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const rec = data as Record<string, unknown>;
  const {
    section8_evidence_verification: section8Raw,
    system_validation: sysRaw,
    ...rest
  } = rec;
  delete rest.uploaded_evidence_files;
  delete rest.evaluation_mode;
  delete rest.generated_at;
  delete rest.schema_version;
  const section8 =
    section8Raw &&
    typeof section8Raw === 'object' &&
    !Array.isArray(section8Raw)
      ? (section8Raw as Record<string, unknown>)
      : {};
  const sys =
    sysRaw && typeof sysRaw === 'object' && !Array.isArray(sysRaw)
      ? { ...(sysRaw as Record<string, unknown>) }
      : {};
  delete sys.scoring_rubric;
  return {
    ...rest,
    reportId: rec.reportId ?? rec.report_id,
    inputFingerprint: rec.inputFingerprint ?? rec.input_fingerprint,
    system_validation: sys,
    section8_evidence_verification: {
      has_evidence: section8.has_evidence,
      evidence_description: section8.evidence_description,
      ethical_compliance: section8.ethical_compliance,
      partner_verification: section8.partner_verification,
      media_visibility: section8.media_visibility,
      public_share_permission: section8.public_share_permission,
    },
  };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(@Optional() private readonly s3Service?: S3Service) {
    // Surfaces a missing key at boot, in the server log, instead of only as a 500 toast the
    // Admin sees hours later on "Run AI Analyser". The key lives in the HOST environment
    // (Vercel → Project → Settings → Environment Variables), never in the repo (.env is ignored).
    if (!process.env.OPENAI_API_KEY?.trim()) {
      this.logger.warn(
        'OPENAI_API_KEY is not set in this environment — Admin CII / FYP / NPE analysers will fail with "OpenAI API key is not configured" until it is added and the service is redeployed.',
      );
    }
  }

  /**
   * Loads the report's image evidence from our own bucket so the model SEES it instead of reasoning
   * from file names. Only objects under our bucket are fetched (never an arbitrary student-supplied
   * URL); PDFs / docs / video / oversized or unreadable files are reported back as "not inspected"
   * so the model cannot credit them as verified.
   */
  private async buildEvidenceParts(data: unknown): Promise<{
    parts: OpenAiContentPart[];
    inspection: EvidenceInspection;
  }> {
    const inspection: EvidenceInspection = { inspected: [], notInspected: [] };
    const parts: OpenAiContentPart[] = [];
    const files = Array.isArray(
      (data as { uploaded_evidence_files?: unknown })?.uploaded_evidence_files,
    )
      ? (data as { uploaded_evidence_files: Array<Record<string, unknown>> })
          .uploaded_evidence_files
      : [];
    const fileId = (f: Record<string, unknown>) => textOf(f?.file_id, '');
    const fileName = (f: Record<string, unknown>) =>
      textOf(f?.file_name ?? f?.url, 'file');
    const imageCandidates: Array<Record<string, unknown>> = [];
    const pdfCandidates: Array<Record<string, unknown>> = [];
    for (const f of files) {
      const url = typeof f?.url === 'string' ? f.url : '';
      const type = textOf(f?.file_type, '').toLowerCase();
      const looksImage =
        /^(jpe?g|png|webp|gif)$/.test(type) ||
        /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
      const looksPdf = type === 'pdf' || /\.pdf(\?|$)/i.test(url);
      if (looksImage) imageCandidates.push(f);
      else if (looksPdf) pdfCandidates.push(f);
      else {
        inspection.notInspected.push({
          id: fileId(f),
          name: fileName(f),
          reason:
            'file type cannot be read by the analyzer (video / office document / other)',
        });
      }
    }

    // Images: spread the (few) slots across the report's sections instead of taking the first
    // four in order, so every part of the package is represented before any part gets two.
    const bySource = new Map<string, Array<Record<string, unknown>>>();
    for (const f of imageCandidates) {
      const key = textOf(f?.source, 'other').split('.')[0];
      bySource.set(key, [...(bySource.get(key) ?? []), f]);
    }
    const toLoad: Array<Record<string, unknown>> = [];
    while (
      toLoad.length < EVIDENCE_MAX_IMAGES &&
      [...bySource.values()].some((g) => g.length)
    ) {
      for (const group of bySource.values()) {
        if (toLoad.length >= EVIDENCE_MAX_IMAGES) break;
        const next = group.shift();
        if (next) toLoad.push(next);
      }
    }
    const chosen = new Set(toLoad);
    for (const f of imageCandidates) {
      if (chosen.has(f)) continue;
      inspection.notInspected.push({
        id: fileId(f),
        name: fileName(f),
        reason: `only ${EVIDENCE_MAX_IMAGES} images per package are shown to the analyzer (spread across sections)`,
      });
    }

    const inspectCache = ciiEvidenceInspectCache(data);
    const loadOne = async (f: Record<string, unknown>) => {
      const url = typeof f?.url === 'string' ? f.url : '';
      const cached = url ? inspectCache?.get(url) : undefined;
      if (cached) return { f, loaded: cached };
      const loaded = this.s3Service
        ? await this.s3Service.getObjectBufferByPublicUrl(url)
        : null;
      return { f, loaded };
    };
    const loadedRows = await Promise.all(toLoad.map(loadOne));

    for (const { f, loaded } of loadedRows) {
      const id = fileId(f);
      const name = fileName(f);
      const contentType = String(loaded?.contentType ?? '')
        .toLowerCase()
        .split(';')[0];
      if (!loaded || !loaded.buffer?.length) {
        inspection.notInspected.push({
          id,
          name,
          reason: 'could not be loaded from storage',
        });
        continue;
      }
      if (
        loaded.buffer.length > EVIDENCE_MAX_IMAGE_BYTES ||
        !EVIDENCE_IMAGE_TYPES.has(contentType)
      ) {
        inspection.notInspected.push({
          id,
          name,
          reason: 'too large or unsupported image format',
        });
        continue;
      }
      inspection.inspected.push({ id, name });
      parts.push({
        type: 'text',
        text: `Evidence image ${id} — file "${name}" (claims it is linked to: ${JSON.stringify(f?.linked_claims ?? [])}):`,
      });
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${contentType};base64,${loaded.buffer.toString('base64')}`,
          detail: 'low',
        },
      });
    }

    // PDFs: extracted text, bounded per file and in total.
    const pdfsToRead = pdfCandidates.slice(0, EVIDENCE_MAX_PDFS);
    for (const f of pdfCandidates.slice(EVIDENCE_MAX_PDFS)) {
      inspection.notInspected.push({
        id: fileId(f),
        name: fileName(f),
        reason: `only ${EVIDENCE_MAX_PDFS} PDF documents per package are read by the analyzer`,
      });
    }
    let pdfCharsLeft = EVIDENCE_PDF_CHARS_TOTAL;
    const pdfRows = await Promise.all(pdfsToRead.map(loadOne));
    for (const { f, loaded } of pdfRows) {
      const id = fileId(f);
      const name = fileName(f);
      if (!loaded || !loaded.buffer?.length) {
        inspection.notInspected.push({
          id,
          name,
          reason: 'could not be loaded from storage',
        });
        continue;
      }
      if (loaded.buffer.length > EVIDENCE_MAX_PDF_BYTES) {
        inspection.notInspected.push({
          id,
          name,
          reason: 'too large to read (PDF over 8 MB)',
        });
        continue;
      }
      let extracted = '';
      try {
        extracted = await this.extractPdfText(loaded.buffer);
      } catch {
        extracted = '';
      }
      if (!extracted) {
        inspection.notInspected.push({
          id,
          name,
          reason:
            'PDF could not be read as text (scanned image, protected or unsupported structure); its content was not read',
        });
        continue;
      }
      const budget = Math.min(EVIDENCE_PDF_CHARS_PER_FILE, pdfCharsLeft);
      if (budget <= 0) {
        inspection.notInspected.push({
          id,
          name,
          reason:
            'PDF text budget for this package was used by earlier documents',
        });
        continue;
      }
      const clipped = scrubPersonalText(extracted.slice(0, budget));
      pdfCharsLeft -= clipped.length;
      inspection.inspected.push({ id, name });
      parts.push({
        type: 'text',
        text: `Evidence document ${id} — PDF "${name}" (extracted text${extracted.length > budget ? ', truncated' : ''}; claims it is linked to: ${JSON.stringify(f?.linked_claims ?? [])}):\n${clipped}`,
      });
    }

    // Tell the model exactly what it was and was not given, so it cannot credit a file it never saw.
    const shown =
      inspection.inspected.map((i) => `${i.id} "${i.name}"`).join('; ') ||
      'none';
    const notShown =
      inspection.notInspected
        .map((i) => `${i.id} "${i.name}" — ${i.reason}`)
        .join('\n') || 'none';
    parts.unshift({
      type: 'text',
      text: `EVIDENCE READ STATUS (authoritative — generated by the platform, not by the student)
Files attached for you to read (images and PDF text): ${shown}
Files NOT shown to you:
${notShown}
Rules: a file under "NOT shown to you" was not read — do not describe its content and do not credit any claim that rests only on it (give such a claim "low" or "unsupported" support). That alone is not a reason to set readComplete=false; use readComplete=false only for a file the platform says could not be loaded, or when material you ARE given is unreadable.`,
    });
    return { parts, inspection };
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    // The package's index.js runs a self-test on import; the lib entry point does not.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
      data: Buffer,
      opts?: { max?: number },
    ) => Promise<{ text?: string }>;
    const out = await Promise.race([
      pdfParse(buffer, { max: EVIDENCE_PDF_MAX_PAGES }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('PDF parse timeout')),
          EVIDENCE_PDF_PARSE_TIMEOUT_MS,
        ),
      ),
    ]);
    return String(out?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async generateSummaryWithOpenAI(
    userPrompt: string | OpenAiContentPart[],
    opts?: OpenAiCompletionOpts,
  ): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY missing');
    }

    const model = opts?.model?.trim() || resolveOpenAiSummaryModel();
    const reasoningModel = isOpenAiReasoningModel(model);

    const temperature = opts?.temperature ?? 0.4;
    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        {
          role: 'system',
          content:
            opts?.systemMessage ||
            'You are ChatGPT, acting as a precise institutional impact analyst. Follow instructions exactly. Output plain text only unless a specific format is requested.',
        },
        { role: 'user', content: userPrompt },
      ],
    };

    if (!reasoningModel) {
      requestBody.temperature = temperature;
      if (opts?.seed !== undefined) {
        requestBody.seed = opts.seed;
      }
    }

    if (opts?.maxTokens !== undefined) {
      if (reasoningModel) {
        requestBody.max_completion_tokens = opts.maxTokens;
      } else {
        requestBody.max_tokens = opts.maxTokens;
      }
    }
    if (opts?.responseFormat) {
      requestBody.response_format = opts.responseFormat;
    }
    if (opts?.reasoningEffort && reasoningModel) {
      requestBody.reasoning_effort = opts.reasoningEffort;
    }

    // Timeout + retry on transient failures (network, timeout, 429, 5xx). The body is read as
    // text first so an HTML error page from a proxy is reported clearly instead of crashing res.json().
    const timeoutMs = opts?.timeoutMs ?? OPENAI_TIMEOUT_MS;
    const maxAttempts = opts?.maxAttempts ?? OPENAI_MAX_ATTEMPTS;
    const extraEmptyAttempt = opts?.retryEmptyOnce ? 1 : 0;
    const startedAt = Date.now();
    let responseJson: OpenAiChatResponse = {};
    let lastError: (Error & { status?: number }) | null = null;
    let didEmptyRetry = false;
    for (
      let attempt = 1;
      attempt <= maxAttempts + extraEmptyAttempt;
      attempt++
    ) {
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await res.text();
        try {
          responseJson = JSON.parse(raw) as OpenAiChatResponse;
        } catch {
          responseJson = {
            error: {
              message: `OpenAI returned a non-JSON response (${res.status})`,
            },
          };
        }
        if (res.ok) {
          if (extractOpenAiMessageText(responseJson)) {
            lastError = null;
            break;
          }
          lastError = emptyOpenAiContentError(responseJson);
          this.logger.warn(
            `OpenAI empty content (model=${model} finish_reason=${responseJson.choices?.[0]?.finish_reason ?? 'unknown'})`,
          );
          if (
            opts?.retryEmptyOnce &&
            !didEmptyRetry &&
            Date.now() - startedAt < 80_000
          ) {
            didEmptyRetry = true;
            if (reasoningModel) {
              const currentMax =
                typeof requestBody.max_completion_tokens === 'number'
                  ? requestBody.max_completion_tokens
                  : 0;
              requestBody.max_completion_tokens = Math.max(currentMax, 24_000);
              requestBody.reasoning_effort = 'low';
            }
            const messages = requestBody.messages as Array<{
              role: string;
              content: unknown;
            }>;
            if (messages[1])
              messages[1].content = textOnlyUserContent(userPrompt);
            this.logger.warn(
              'Retrying OpenAI without images and with a larger token budget',
            );
            continue;
          }
          throw lastError;
        }
        const err = new Error(
          responseJson.error?.message || `OpenAI error (${res.status})`,
        ) as Error & { status?: number };
        err.status = res.status;
        lastError = err;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= maxAttempts) throw err;
      } catch (e) {
        const err = e as Error & { status?: number; name?: string };
        const timedOut =
          err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const retryable =
          timedOut ||
          err?.status === undefined ||
          err.status === 429 ||
          (err.status ?? 0) >= 500;
        if (timedOut) {
          const t = new Error(
            'The AI service took too long to respond. Please try again.',
          ) as Error & { status?: number };
          t.status = 504;
          lastError = t;
        } else {
          lastError = err;
        }
        if (!retryable || attempt >= maxAttempts) throw lastError;
      }
      this.logger.warn(
        `OpenAI attempt ${attempt} failed (${lastError?.message}); retrying`,
      );
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }

    const text = extractOpenAiMessageText(responseJson);
    if (!text) {
      throw lastError ?? new Error('OpenAI returned empty content');
    }

    return text;
  }

  private buildPrompt(section: string, data: SectionPromptData): string {
    switch (section) {
      // =====================================================
      // SECTION 1 EVALUATION
      // =====================================================
      case 'section1_evaluation':
        return `You are an AI Evaluation Assistant for the CIEL PK Community Engagement Reporting System.

Evaluate Section 1 — PARTICIPATION, IDENTITY & ATTENDANCE INTEGRITY and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 1 — PARTICIPATION, IDENTITY & ATTENDANCE INTEGRITY

Total Weight = 20 Marks

This section evaluates:
- Correct student identification details
- Accurate academic information
- Proper team/project linkage
- Attendance consistency
- Hour completion against project-defined required hours
- Participation authenticity
- Logical engagement in project activities
- Attendance log quality and realism

IMPORTANT EVALUATION PRINCIPLE:
"Verify reasonably, penalize carefully."

Your purpose is NOT to aggressively reject participation or penalize collaborative work unnecessarily. Community engagement is often team-based, and students may participate together in groups.

Students may work:
- Individually
- In teams/groups

Teams may consist of:
- Minimum 2 students
- Maximum 20 students

It is completely normal for:
- Multiple students to attend together
- Teams to log similar timings
- Students to upload similar evidence
- Entire groups to participate simultaneously
- Similar activities to be reported by team members

DO NOT automatically treat group participation as suspicious.

Large group attendance is common and operationally normal in community engagement activities.

------------------------------------------------
PROJECT HOURS RULE
------------------------------------------------

Each project defines its own required minimum hours.

16 hours may commonly be used but it is NOT universal.

You MUST evaluate attendance according to:
- Project-defined required hours per student
- Nature of activity
- Team structure
- Timeline
- Scope of work
- Approved project objectives

Never penalize students simply because:
- Many students attended together
- Hours overlap across teams
- Participation is collaborative
- Evidence/photos are shared
- Activity descriptions are similar

------------------------------------------------
SECTION 1 SCORING FORMULA
------------------------------------------------

Section 1 CII Score:

S1 = S1_base + B

Where:

S1_base = base participation score out of 15

B = bonus for extra hours out of 5

Final score must not exceed 20.

S1 = min(20, S1_base + B)

------------------------------------------------
BASE FORMULA
------------------------------------------------

S1_base = 15 × (0.10*I + 0.10*A + 0.35*H + 0.20*F + 0.15*C + 0.10*L)

Where:

I = Identity Completeness Score
A = Academic / Team Setup Completeness Score
H = Individual Hours Compliance Score
F = Visit Frequency Score
C = Continuity / Spread Score
L = Attendance Log Quality Score

All component scores must be between 0 and 1.

------------------------------------------------
1) IDENTITY COMPLETENESS SCORE (I)
------------------------------------------------

Check whether the student's identity and verification fields are complete enough for auditability.

Evaluate:
- Full name
- Student ID / registration number
- Email
- Contact information, if required
- University / institution link
- Consistency between student identity and participation records

Scoring rule:

1.00 = all required identity fields complete and verified
0.75 = fields complete but one minor verification item missing
0.50 = partial identity information but still identifiable
0.25 = major identity gaps or unclear student identity
0.00 = unusable / unverifiable identity

Important:
Minor spelling mistakes, formatting issues, or small clerical errors should not be harshly penalized unless they create serious identity inconsistency.

------------------------------------------------
2) ACADEMIC / TEAM SETUP COMPLETENESS SCORE (A)
------------------------------------------------

Check whether the student is properly linked to the academic and team structure of the project.

Evaluate:
- Degree/program
- Department
- Course, if applicable
- Faculty supervisor, if applicable
- Team name / team members, if applicable
- Project name
- Role in team/project
- Correct linkage to approved opportunity

Scoring rule:

1.00 = all core academic and team fields complete
0.75 = minor missing information
0.50 = several missing fields but project linkage is still understandable
0.25 = weak/incomplete academic or team linkage
0.00 = no meaningful academic/team setup

Important:
Do not penalize students simply because they are part of a large team. Teams of up to 20 students are allowed where project design supports it.

------------------------------------------------
3) INDIVIDUAL HOURS COMPLIANCE SCORE (H)
------------------------------------------------

Evaluate whether the individual student completed the required minimum hours defined by the project.

Formula:

H = min(IH_i / RHS, 1)

Where:

IH_i = individual student hours completed
RHS = required hours per student defined by the project

Important:
- Use the project-defined required hours.
- Do NOT assume 16 hours unless the project states 16 hours.
- Each individual student must meet their own required hours.
- Group hours do not replace individual hours.
- If a team has 10 students and the project requires 16 hours per student, each student must complete 16 hours individually.

Scoring logic:

1.00 = student meets or exceeds required hours
0.75 = student completes around 75% of required hours
0.50 = student completes around 50% of required hours
0.25 = student completes around 25% of required hours
0.00 = no meaningful hours logged

------------------------------------------------
4) VISIT FREQUENCY SCORE (F)
------------------------------------------------

Evaluate whether the number of visits/sessions is reasonable according to the required hours.

Formula:

V_exp = max(2, ceiling(RHS / 8))

F = min(V_i / V_exp, 1)

Where:

V_i = actual number of visits or attendance entries
V_exp = expected number of visits

Interpretation:
- A student completing 16 hours would normally be expected to have at least 2 visits.
- A student completing longer projects may reasonably need more visits.
- However, some projects may involve long single-day or event-based engagement. In such cases, evaluate contextually.

Important:
Do not penalize repeated visits if they are logical.
Do not penalize shared visit dates/times in team-based work.

------------------------------------------------
5) CONTINUITY / SPREAD SCORE (C)
------------------------------------------------

Evaluate whether the attendance is reasonably spread across the project timeline.

Formula:

D_span = days between first and last attendance + 1

D_exp = max(2, ceiling(V_exp * 1.5))

C = min(D_span / D_exp, 1)

Interpretation:
- A better spread usually indicates more consistent engagement.
- However, some projects are designed as short events, drives, workshops, or 1–2 day field activities.
- If the project timeline itself is short, do not unfairly penalize the student for limited spread.

Important:
Evaluate continuity according to the approved project duration and nature of activity.

------------------------------------------------
6) ATTENDANCE LOG QUALITY SCORE (L)
------------------------------------------------

Evaluate the quality, specificity, and realism of attendance logs.

Formula:

L = 0.20*Q_d + 0.20*Q_t + 0.20*Q_p + 0.20*Q_a + 0.20*Q_r

Each sub-component is scored from 0 to 1.

Q_d = Date Quality
1 = date is properly recorded
0.5 = date is partially unclear
0 = date is missing or unusable

Q_t = Time / Duration Quality
1 = duration or start-end time is properly recorded
0.5 = partial time/duration information
0 = no usable time/duration

Q_p = Partner / Location Clarity
1 = partner/location is clearly identified
0.5 = partner/location partially clear
0 = partner/location missing or unclear

Q_a = Activity Description Quality
1 = work description is specific and meaningful
0.5 = description is general but understandable
0 = description is vague, e.g., "worked," "present," "did activity"

Q_r = Realism / Authenticity of Logs
1 = logs appear realistic and coherent
0.5 = minor repetition or limited detail but still plausible
0 = logs appear fake, copied without logic, contradictory, or impossible

Important:
Do NOT automatically penalize:
- Similar descriptions in group work
- Shared timings
- Shared photos/evidence
- Similar activities among team members

Only reduce Q_r where there is strong evidence of fabrication, contradiction, or unrealistic reporting.

------------------------------------------------
7) BONUS FOR EXTRA HOURS (B)
------------------------------------------------

Award bonus only if the student exceeds the project-defined required hours.

Formula:

If IH_i > RHS:

B = min(5, 5 × (IH_i - RHS) / RHS)

If IH_i <= RHS:

B = 0

Important:
- Bonus rewards extra verified/logical hours.
- Extra hours must still appear realistic and aligned with project activities.
- Do not award bonus for exaggerated, unsupported, or impossible hours.
- Final Section 1 score must not exceed 20.

------------------------------------------------
RED FLAGS
------------------------------------------------

Only raise red flags where there is strong evidence of inconsistency, fabrication, or serious weakness.

Possible red flags include:

1. Identity or academic inconsistency:
- Mismatched student details
- Contradictory academic records
- Missing essential identification information
- Identity details inconsistent with participation records

2. Unrealistic hour claims:
- Impossible schedules
- Excessive unsupported hours
- Contradictory timings
- Same student appearing in conflicting places/times

3. Completely vague attendance:
Examples:
- "Worked"
- "Present"
- "Did activity"

without meaningful explanation.

4. Suspicious or fabricated reporting:
- Contradictory entries
- Impossible participation patterns
- Repeated false logs
- Clearly manipulated attendance

5. Misalignment:
- Activities unrelated to approved project objectives
- Reported participation does not match project scope

Do NOT raise red flags merely because:
- Many students attended together
- A team logged the same date/time
- Evidence is shared
- Descriptions are similar but still logical
- The project involved a large group

------------------------------------------------
QUALITY LEVEL
------------------------------------------------

Assign a quality level based on the final Section 1 CII score:

18–20 = Exceptional
15–17.99 = Strong
12–14.99 = Good
8–11.99 = Basic
0–7.99 = Poor

------------------------------------------------
RECOMMENDED ACTION OPTIONS
------------------------------------------------

Use ONLY one of the following:

- Fully Accepted
- Accepted with Observation
- Revision Requested
- Partial Deduction Recommended
- Major Deduction Recommended
- Escalate for Manual Review

Guidance:

Fully Accepted:
Use when participation is complete, logical, and well supported.

Accepted with Observation:
Use when minor gaps exist but participation appears valid.

Revision Requested:
Use when clarification or missing information is needed before final approval.

Partial Deduction Recommended:
Use when there are moderate issues but participation is still partly valid.

Major Deduction Recommended:
Use when serious gaps, weak justification, or major inconsistencies exist.

Escalate for Manual Review:
Use only when there is strong suspicion of fabrication, identity mismatch, impossible attendance, or serious contradiction.

------------------------------------------------
OUTPUT FORMAT
------------------------------------------------

For EACH student, return:

Student Name: ___
Project Name: ___
Team Size: ___
Required Hours Per Student (RHS): ___
Total Logged Individual Hours (IH_i): ___

Identity Completeness (I): ___
Academic / Team Setup (A): ___
Individual Hours Compliance (H): ___
Visit Frequency (F): ___
Continuity / Spread (C): ___
Attendance Log Quality (L): ___
Bonus (B): ___

Section 1 CII Score: ___ / 20
Quality Level: Poor / Basic / Good / Strong / Exceptional

Evaluation Summary:
Write 80–120 words explaining why the score was assigned. Mention identity accuracy, attendance logic, hour completion, participation justification, team context, and any concerns.

Strengths:
- ___
- ___
- ___

Weaknesses:
- ___
- ___

Red Flags:
- ___
If there are no red flags, write: No major red flags identified.

Recommended Action:
Choose only one:
Fully Accepted / Accepted with Observation / Revision Requested / Partial Deduction Recommended / Major Deduction Recommended / Escalate for Manual Review

------------------------------------------------
FINAL REVIEW PRINCIPLES
------------------------------------------------

1. Community engagement is collaborative by nature.
2. Large team participation is normal.
3. Shared evidence is acceptable in team-based activities.
4. Similar timings are normal when students work together.
5. Logical participation matters more than excessive evidence.
6. Penalize only where there is genuine inconsistency, weak justification, or fabrication.
7. Use project-defined hours, not a fixed 16-hour assumption.
8. Read all attendance entries carefully before evaluating.
9. Be fair, contextual, and intelligent.
10. Support authentic student participation while identifying genuinely problematic submissions.`;

      // =====================================================
      // SECTION 2 AUTO SUMMARY
      // =====================================================
      case 'section2':
        return `You are the CIEL PK AI Context Summary Engine. Write one comprehensive, concise, professionally written summary of the project's ORIGINAL CONTEXT from everything the student entered in Section 2 — Project Context (2.1 Quick Questions, 2.2 Baseline Statement, 2.3 Risk, Safeguarding & Consent). This is the "AI Summary — what the rubric will read" shown on the Section 2 summary screen; it is not a score.

SECTION 2 AS SAVED BY THE STUDENT
${describeSection2ForSummary(data)}

SUMMARIZATION RULES
1. Read every completed field above, including selected chips and dropdown values, not only the free text.
2. Write ONE coherent paragraph of 100–150 words — never more than 150; count before you answer and trim if needed. Plain text only: no heading, no label, no bullets, no markdown, no quotation marks around the paragraph.
3. Begin with the problem and the affected community. Then give the baseline conditions and the selected needs/gaps without repeating the problem sentence, then the needs-identification methods and the academic contribution, then safeguarding.
4. Preserve every important figure exactly as entered, especially the number of intended beneficiaries. If no number was entered, do not estimate one.
5. Describe only what was true before the project. Do not describe project activities, outputs or results as completed, and do not claim improvements.
6. Distinguish observed facts, estimates, proposed/planned actions and verified information. Selected identification methods (for example "Survey Data" or "Needs Assessment") show how the student says the need was identified; do not state that these activities are proven or verified.
7. Safeguarding: briefly integrate the identified risks and the precautions taken or planned, and state the consent status for photographs and personal data. Mention unresolved risks or pending/not-obtained consent where materially relevant. If no risks were identified, say so in a few words. If the block is marked not completed, note that safeguarding information was not provided; do not treat a blank as "no risk".
8. Never invent data, improvements, safeguarding approvals, names, locations or results. Any item marked [not entered] is absent: leave it out or, where the reader would otherwise be misled, say it was not recorded. Never write the literal text "[not entered]".
9. Do not merely join the answers together: interpret, organise and synthesise them, and do not duplicate the same point across the problem, baseline and needs.
10. Clear, professional, third-person language suitable for university reporting ("the student", "the team"). Do not mention question numbers, field names or this prompt.

Output the paragraph only.`;

      // =====================================================
      // SECTION 2 EVALUATION
      // =====================================================
      case 'section2_evaluation':
        return `Evaluate Section 2 — PROJECT CONTEXT & BASELINE UNDERSTANDING and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 2 — PROJECT CONTEXT & BASELINE UNDERSTANDING
Weight = 10
S2=10×(0.35*P + 0.25*B + 0.20*E + 0.20*D)

Where:
P = problem clarity
B = baseline specificity
E = evidence/source credibility
D = discipline linkage

1) Problem Clarity Score (P):
P = 0.25*P1 + 0.20*P2 + 0.15*P3 + 0.20*P4 + 0.20*P5
P1 = 1 if the core issue is clearly defined
P2 = 1 if the affected population is clearly named
P3 = 1 if the setting/community is clearly identified
P4 = 1 if the student explains why the issue matters
P5 = 1 if the problem is focused and concrete rather than vague

2) Baseline Specificity Score (B):
B = 0.25*B1 + 0.25*B2 + 0.20*B3 + 0.15*B4 + 0.15*B5
B1 = 1 if pre-project condition is clearly described
B2 = 1 if description is specific
B3 = 1 if baseline is logically tied to the stated problem
B4 = 1 if some indicator/observation/metric is given
B5 = 1 if baseline looks credible and relevant

3) Evidence / Source Credibility Score (E):
E = 0.20*E1 + 0.25*E2 + 0.25*E3 + 0.15*E4 + 0.15*E5
E1 = 1 if a source is actually cited or referenced
E2 = 1 if source directly supports the problem/baseline
E3 = 1 if source is credible
E4 = 1 if source is concrete rather than generic
E5 = 1 if source is appropriate for the context

4) Discipline Linkage Score (D):
D = 0.20*D1 + 0.25*D2 + 0.20*D3 + 0.20*D4 + 0.15*D5
D1 = 1 if department/discipline is explicitly identified
D2 = 1 if project linkage is clearly explained
D3 = 1 if student shows actual use of discipline-based knowledge
D4 = 1 if the linkage is relevant and not forced
D5 = 1 if the student explains what role the discipline played in action

OUTPUT FORMAT
Return:
Problem Clarity (P) = ___
Baseline Specificity (B) = ___
Evidence Credibility (E) = ___
Discipline Linkage (D) = ___

Section 2 CII Score = ___ / 10
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 3 AUTO SUMMARY
      // =====================================================
      case 'section3':
        return `${FLASHCARD_SUMMARY_RULES}

Lens: SDG Contribution. Link the recorded work to the named targets. Do not treat an SDG icon as proof of impact.

Inputs (the student report section, as saved):
Primary SDG number: ${String(data.primary_sdg?.goal_number)}
Primary SDG title: ${String(data.primary_sdg?.goal_title)}
Target: ${String(data.primary_sdg?.target_id)}
Indicator: ${String(data.primary_sdg?.indicator_id)}
Contribution logic: ${String(data.contribution_intent_statement || data.student_contribution_intent_statement)}
Secondary SDGs: ${JSON.stringify(data.secondary_sdgs || [])}
Full section: ${JSON.stringify(data)}

Output exactly these lines:
SDG: which recorded goals this work supports, and the concrete link
Logic: how the physical or service change maps to the named target, not to the icon alone
Facts: count of registered SDGs, targets, and indicators only when present in the input
Missing: optional or required SDG fields that are blank, or "none"`;

      // =====================================================
      // SECTION 3 EVALUATION
      // =====================================================
      case 'section3_evaluation':
        return `Evaluate Section 3 — SDG CONTRIBUTION MAPPING and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 3 — SDG CONTRIBUTION MAPPING
Weight = 10
Final Section 3 Formula
S3=S3_base+S3_bonus

Base score
S3_base=9×(0.40*M + 0.25*T + 0.20*I + 0.15*J)

Bonus for optional secondary SDGs
S3_bonus=min(1, B_1 + B_2)

For each optional secondary SDG:
B_k=0.5×(0.50*R_k + 0.50*J_k)

M = SDG match accuracy
M = 0.25*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.15*M5
(M1: problem-to-SDG fit, M2: activity-to-SDG fit, M3: outcome-to-SDG fit, M4: primacy of SDG, M5: absence of contradiction)

T = target alignment quality
T = 0.20*T1 + 0.25*T2 + 0.20*T3 + 0.20*T4 + 0.15*T5
(T1: belongs to SDG, T2: matches purpose, T3: matches activities, T4: matches outcomes, T5: specificity)

I = indicator relevance
I = 0.20*I1 + 0.25*I2 + 0.25*I3 + 0.15*I4 + 0.15*I5

J = justification strength
J = 0.20*J1 + 0.20*J2 + 0.20*J3 + 0.20*J4 + 0.20*J5

R_k = relevance of secondary SDG
R_k = 0.30*R1_k + 0.25*R2_k + 0.25*R3_k + 0.20*R4_k

J_k = justification quality of secondary SDG
J_k = 0.30*K1_k + 0.25*K2_k + 0.25*K3_k + 0.20*K4_k

Calculate everything with values from 0 to 1 for subparts.
OUTPUT FORMAT
Return:
SDG Match (M) = ___
Target Alignment (T) = ___
Indicator Relevance (I) = ___
Justification (J) = ___
Secondary Bonus (S3_bonus) = ___

Section 3 CII Score = ___ / 10
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 4 AUTO SUMMARY
      // =====================================================
      case 'section4':
        return `${FLASHCARD_SUMMARY_RULES}

Lens: Activities & Outputs. Count what was delivered. Do not interpret outcomes or claim that people were improved or empowered.

Inputs (the student report section, as saved):
- Activity blocks: ${JSON.stringify(data.activity_blocks || data.activities || [])}
- Project summary: ${JSON.stringify(data.project_summary || {})}
- Distinct beneficiaries: ${String(data.project_summary?.distinct_total_beneficiaries || (Array.isArray(data.activity_blocks) ? data.activity_blocks.reduce((sum: number, block: ActivityBlockReach | null | undefined) => sum + (Number(promptText(block?.unique_beneficiaries || block?.beneficiaries_reached || '').replace(/,/g, '')) || 0), 0) : 0))}
- Full section: ${JSON.stringify(data)}

Output exactly these lines:
Activities: the recorded activities, in a few words
Outputs: countable things delivered, with numbers only when recorded
Reach: unique people served, marked estimated only if the input says so
Facts: activity count, output count, and unique reach — omit a chip you cannot support
Missing: required activity or output fields that are blank, or "none"`;

      // =====================================================
      // SECTION 4 EVALUATION
      // =====================================================
      case 'section4_evaluation':
        return `Evaluate Section 4 — ACTIVITIES, OUTPUTS & SCALE and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 4 — ACTIVITIES, OUTPUTS & SCALE
Weight = 15
Core Formula
S4=15×(0.25*A + 0.25*O + 0.20*B + 0.15*M + 0.15*S)

Where:
A = Activity Block Quality
O = Output Quality & Measurability
B = Beneficiary Reach & Counting Clarity
M = Delivery & Implementation Model Clarity
S = Scale Credibility & Implementation Magnitude

Each variable is scored from 0 to 1 using numeric benchmarks:
1.00 = Excellent, 0.80 = Good, 0.60 = Moderate, 0.40 = Weak, 0.20 = Very Weak, 0.00 = Absent

A = 0.20*A1 + 0.20*A2 + 0.25*A3 + 0.15*A4 + 0.20*A5
O = 0.20*O1 + 0.25*O2 + 0.20*O3 + 0.20*O4 + 0.15*O5
B = 0.20*B1 + 0.20*B2 + 0.20*B3 + 0.20*B4 + 0.20*B5
M = 0.20*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.20*M5
S = 0.20*S1 + 0.20*S2 + 0.20*S3 + 0.15*S4 + 0.25*S5

OUTPUT FORMAT
Return:
Activity Quality (A) = ___
Output Quality (O) = ___
Beneficiary Clarity (B) = ___
Delivery Clarity (M) = ___
Scale Credibility (S) = ___

Section 4 CII Score = ___ / 15
Classify quality: 13-15=Excellent, 10.5-12.9=Good, 8-10.4=Moderate, 5-7.9=Weak, 0-4.9=Very Weak

SECTION 4 AUDIT GUARDRAIL (MANDATORY):
Do not score activities, outputs, beneficiaries, or scale only from entered numbers. Validate realism against verified hours, sessions, evidence, and team size.
Specifically check:
- Are activities clearly described?
- Are outputs measurable (not generic claims)?
- Are beneficiary numbers realistic and counted with method?
- Do outputs and scale align with evidence and attendance?
- Are there inflation signals?

Section 4 cap rules (apply if triggered):
- Activities done but outputs vague: max 10/15
- Beneficiary numbers inflated: max 8/15
- Evidence does not support outputs: max 7/15
- Major contradiction in scale: max 5/15

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 5 AUTO SUMMARY
      // =====================================================
      case 'section5_summary':
        return `${FLASHCARD_SUMMARY_RULES}

Lens: Outcomes & Measured Change. Report before → after only when both numbers are recorded. A short follow-up is a limit, not a hidden success.

Inputs (the student report section, as saved):
Observed change: ${String(data.observed_change)}
Measurable outcomes: ${JSON.stringify(data.measurable_outcomes || [])}
Challenges: ${String(data.challenges)}
Full section: ${JSON.stringify(data)}

Output exactly these lines:
Change: the recorded baseline → endline, and whether it was directly measured
Limit: the stated limitation, including a short follow-up window when that is what the input says
Facts: outcome count and how many were directly measured
Missing: a measurable outcome or its evidence reference when absent, or "none"`;

      // =====================================================
      // SECTION 5 EVALUATION
      // =====================================================
      case 'section5_evaluation':
        return `Evaluate Section 5 — OUTCOMES & RESULTS and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 5 — OUTCOMES & RESULTS
Weight = 20
Core Formula
S5=20×(0.25*N + 0.30*M + 0.20*C + 0.15*L + 0.10*R)

Where:
N = quality of change narrative
M = measurable outcome strength
C = confidence / credibility of measurement
L = linkage with outputs and baseline
R = realism of claims

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) N = QUALITY OF CHANGE NARRATIVE
N = 0.25*N1 + 0.20*N2 + 0.20*N3 + 0.15*N4 + 0.20*N5
(N1: change stated, N2: affected group identified, N3: type of change described, N4: before/after logic present, N5: narrative specificity/coherence)

2) M = MEASURABLE OUTCOME STRENGTH
M = 0.20*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.20*M5
(M1: outcome is measurable, M2: relevant metric/unit, M3: value/magnitude provided, M4: reflects change not activity, M5: strength/significance)

3) C = CONFIDENCE / CREDIBILITY OF MEASUREMENT
C = 0.20*C1 + 0.20*C2 + 0.20*C3 + 0.20*C4 + 0.20*C5
(C1: source identified, C2: method explained, C3: evidence exists, C4: consistency with implementation, C5: credibility of inference)

4) L = LINKAGE WITH OUTPUTS AND BASELINE
L = 0.20*L1 + 0.20*L2 + 0.20*L3 + 0.20*L4 + 0.20*L5
(L1: baseline-to-outcome, L2: activity-to-outcome, L3: output-to-outcome, L4: internal consistency, L5: attributable to intervention)

5) R = REALISM OF CLAIMS
R = 0.25*R1 + 0.25*R2 + 0.20*R3 + 0.15*R4 + 0.15*R5
(R1: proportionality, R2: plausibility of magnitude, R3: evidence sufficiency, R4: absence of exaggeration, R5: acknowledgment of limits)

OUTPUT FORMAT
Return:
Narrative Quality (N) = ___
Measurable Score (M) = ___
Confidence (C) = ___
Linkage (L) = ___
Realism (R) = ___

Section 5 CII Score = ___ / 20

SECTION 5 REALISM GUARDRAIL (MANDATORY):
Apply strict realism. Do not reward outcomes unless linked to baseline, activities, outputs, measurement method, and evidence.
Check:
- Is the outcome measurable (not only narrative)?
- Is there before/after or equivalent comparison logic?
- Is a method of measurement stated?
- Is the claim evidence-backed and proportionate to intervention?
- Are limitations acknowledged?
- Is there overclaiming?

Section 5 cap rules (apply if triggered):
- Outcomes described but not measured: max 13/20
- Outcomes vague/generic: max 10/20
- Outcomes inflated or unsupported: max 8/20
- Outcomes contradict evidence: max 5/20

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 6 AUTO SUMMARY
      // =====================================================
      case 'section6_summary':
        return `${FLASHCARD_SUMMARY_RULES}

Lens: Resources & Stewardship. Trace what was used and where it came from. Zero budget is a valid recorded fact.

Inputs (the student report section, as saved):
Uses extra resources: ${String(data.use_resources)}
Resource entries: ${JSON.stringify(data.resources || [])}
Full section: ${JSON.stringify(data)}

Output exactly these lines:
Resources: cash, in-kind, or volunteer time actually recorded
Sources: who provided them
Use: what those resources paid for or enabled
Facts: amount traced and entry count, only from the input
Missing: source or use when a resource is listed without them, or "none"`;

      // =====================================================
      // SECTION 6 EVALUATION
      // =====================================================
      case 'section6_evaluation':
        return `Evaluate Section 6 — RESOURCES & IMPLEMENTATION SUPPORT and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 6 — RESOURCES & IMPLEMENTATION SUPPORT
Weight = 5
Core Formula
S6=5×(0.30*R + 0.25*S + 0.25*P + 0.20*V)

Where:
R = resource relevance
S = source clarity
P = purpose justification
V = verification of support

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) R = RESOURCE RELEVANCE
R = 0.25*R1 + 0.25*R2 + 0.20*R3 + 0.15*R4 + 0.15*R5
(R1: relevance to activities, R2: relevance to implementation needs, R3: relevance to outputs, R4: proportionality, R5: absence of decorative entries)

2) S = SOURCE CLARITY
S = 0.25*S1 + 0.20*S2 + 0.20*S3 + 0.15*S4 + 0.20*S5
(S1: source identified, S2: source specificity, S3: source traceability, S4: distinction between sources, S5: overall clarity)

3) P = PURPOSE JUSTIFICATION
P = 0.20*P1 + 0.20*P2 + 0.20*P3 + 0.20*P4 + 0.20*P5
(P1: purpose stated, P2: linked to activity, P3: linked to implementation, P4: explanation of use, P5: specificity/coherence)

4) V = VERIFICATION OF SUPPORT
V = 0.20*V1 + 0.20*V2 + 0.20*V3 + 0.20*V4 + 0.20*V5
(V1: presence of supporting basis, V2: relevance of proof, V3: external confirmation, V4: consistency with records, V5: overall credibility)

OUTPUT FORMAT
Return:
Resource Relevance (R) = ___
Source Clarity (S) = ___
Purpose Justification (P) = ___
Verification (V) = ___

Section 6 CII Score = ___ / 5
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 7 SUMMARY
      // =====================================================
      case 'section7_summary':
        return `${FLASHCARD_SUMMARY_RULES}

Lens: Partnership & Collaboration. A named role beats a paragraph of praise. Do not list an organization that is not in the input.

Inputs (the student report section, as saved):
Has partners: ${String(data.has_partners)}
Partner entries: ${JSON.stringify(data.partners || [])}
Full section: ${JSON.stringify(data)}

Output exactly these lines:
Partner: the recorded host or collaborating organization
Role: what they actually did, such as site, access, or verification
Contribution: the support recorded, not a compliment
Facts: partner count and role count
Missing: a partner role or optional profile link when blank, or "none"`;

      // =====================================================
      // SECTION 7 EVALUATION
      // =====================================================
      case 'section7_evaluation':
        return `Evaluate Section 7 — PARTNERSHIPS & COLLABORATION and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 7 — PARTNERSHIPS & COLLABORATION
Weight = 5
Core Formula
S7=5×(0.25*Re + 0.25*Ro + 0.25*Co + 0.25*Ve)

Where:
Re = partner relevance
Ro = role clarity
Co = contribution depth
Ve = verification strength

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) Re = PARTNER RELEVANCE
Re = 0.25*Re1 + 0.20*Re2 + 0.20*Re3 + 0.20*Re4 + 0.15*Re5
(Re1: relevance to problem, Re2: relevance to activities, Re3: relevance to beneficiaries, Re4: relevance to outcomes, Re5: non-decorative fit)

2) Ro = ROLE CLARITY
Ro = 0.20*Ro1 + 0.20*Ro2 + 0.20*Ro3 + 0.20*Ro4 + 0.20*Ro5
(Ro1: role explicitly stated, Ro2: role is specific, Ro3: role linked to function, Ro4: role distinction from others, Ro5: overall clarity)

3) Co = CONTRIBUTION DEPTH
Co = 0.20*Co1 + 0.20*Co2 + 0.20*Co3 + 0.20*Co4 + 0.20*Co5
(Co1: type significance, Co2: usefulness to project, Co3: depth/intensity, Co4: effect on delivery, Co5: continuity/value)

4) Ve = VERIFICATION STRENGTH
Ve = 0.20*Ve1 + 0.20*Ve2 + 0.20*Ve3 + 0.20*Ve4 + 0.20*Ve5
(Ve1: evidence exists, Ve2: evidence is relevant, Ve3: external confirmation strength, Ve4: consistency with records, Ve5: overall credibility)

OUTPUT FORMAT
Return:
Partner Relevance (Re) = ___
Role Clarity (Ro) = ___
Contribution Depth (Co) = ___
Verification Strength (Ve) = ___

Section 7 CII Score = ___ / 5
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 8 SUMMARY
      // =====================================================
      case 'section8_summary':
        return `${FLASHCARD_SUMMARY_RULES}

Lens: Evidence, Ethics & Verification. Visibility does not change verification weight. Private evidence counts the same as public evidence.

Inputs (the student report section, as saved):
Has evidence: ${String(data.has_evidence)}
Evidence types: ${JSON.stringify(data.evidence_types || [])}
Description: ${String(data.description)}
Ethical compliance: ${JSON.stringify(data.ethical_compliance || data.ethics || {})}
Visibility: ${String(data.media_visible)}
Partner verification: ${String(data.partner_verification)}
Full section: ${JSON.stringify(data)}

Output exactly these lines:
Evidence: how many items, and which kinds were recorded
Ethics: whether consent and dignity were confirmed
Visibility: the recorded visibility setting, without treating public as stronger
Facts: evidence count and consent status
Missing: ethics confirmation or a claim with no evidence link, or "none"`;

      // =====================================================
      // SECTION 8 EVALUATION
      // =====================================================
      case 'section8_evaluation':
        return `Evaluate Section 8 — EVIDENCE RELIABILITY, ETHICS & VERIFICATION and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 8 — EVIDENCE RELIABILITY, ETHICS & VERIFICATION
Weight = 5
Core Formula
S8=5×(0.30*C + 0.25*V + 0.20*R + 0.15*E + 0.10*X)

Where:
C = cross-section consistency
V = external verification strength
R = relevance of uploaded proof
E = ethics compliance
X = absence of contradiction / suspicion

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully reliable
0.75 = Good / mostly reliable
0.50 = Moderate / partially reliable
0.25 = Weak / doubtful
0.00 = Very weak / absent / strongly suspicious

1) C = CROSS-SECTION CONSISTENCY
C = 0.25*C1 + 0.25*C2 + 0.20*C3 + 0.15*C4 + 0.15*C5
(C1: consistency with attendance, C2: consistency with activities, C3: consistency with outputs, C4: consistency with partners, C5: consistency with timeline)

2) V = EXTERNAL VERIFICATION STRENGTH
V = 0.20*V1 + 0.20*V2 + 0.20*V3 + 0.20*V4 + 0.20*V5
(V1: existence of external verification, V2: relevance, V3: specificity, V4: credibility of source, V5: strength of linkage to claims)

3) R = RELEVANCE OF UPLOADED PROOF
R = 0.25*R1 + 0.20*R2 + 0.20*R3 + 0.20*R4 + 0.15*R5
(R1: relevance to activity, R2: relevance to output, R3: relevance to context, R4: interpretability of proof, R5: file-type appropriateness)

4) E = ETHICS COMPLIANCE
E = 0.25*E1 + 0.20*E2 + 0.20*E3 + 0.20*E4 + 0.15*E5
(E1: no harmful sensitive exposure, E2: dignity maintained, E3: contextually appropriate use, E4: consent/permission logic, E5: no exploitative style)

5) X = ABSENCE OF CONTRADICTION / SUSPICION
X = 0.20*X1 + 0.20*X2 + 0.20*X3 + 0.20*X4 + 0.20*X5
(X1: absence of duplication, X2: timeline alignment, X3: numerical consistency, X4: no inflation signals, X5: overall suspicion-free profile)

OUTPUT FORMAT
Return:
Cross-Section Consistency (C) = ___
External Verification (V) = ___
Relevance of Proof (R) = ___
Ethics Compliance (E) = ___
Absence of Contradiction (X) = ___

Section 8 CII Score = ___ / 5

SECTION 8 EVIDENCE AUDIT GUARDRAIL (MANDATORY):
Evidence must only strengthen score if it is relevant, attributable, time-aligned, ethical, and internally consistent.
Check for duplicate/unrelated files, weak linkage, date mismatch, unsupported partner claims, inflated numbers not visible in proof, suspicious staging, and contradictions with attendance/activities/outcomes/resources.

Section 8 cap rules (apply if triggered):
- Some evidence but weak linkage: max 3.5/5
- Evidence vague or insufficient: max 2.5/5
- Evidence contradicts claims: max 1.5/5
- Evidence appears fake/unethical: max 0.5/5

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 9 SUMMARY
      // =====================================================
      case 'section9_summary':
        return `${FLASHCARD_SUMMARY_RULES}

Lens: Reflection & Academic Growth. Prefer one real decision or shift in thinking over generic leadership language. Do not treat a row of perfect self-ratings as proof.

Inputs (the student report section, as saved):
Academic integration: ${String(data.academic_integration)}
Personal learning: ${String(data.personal_learning)}
Academic application: ${String(data.academic_application)}
Skills grown: ${JSON.stringify(data.skills_grown || [])}
Competency scores: ${JSON.stringify(data.competency_scores || data.competencies || {})}
Full section: ${JSON.stringify(data)}

Output exactly these lines:
Learning: the recorded change in approach or understanding
Academic use: how the student's field was applied
Skills: only skills named in the input
Facts: skill count and competency coverage when the ratings are present
Missing: reflection or academic application when blank, or "none"`;

      // =====================================================
      // SECTION 9 EVALUATION
      // =====================================================
      case 'section9_evaluation':
        return `Evaluate Section 9 — REFLECTION, LEARNING & COMPETENCY DEVELOPMENT and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 9 — REFLECTION, LEARNING & COMPETENCY DEVELOPMENT
Weight = 5
Core Formula
S9=5×(0.30*L + 0.25*A + 0.25*C + 0.20*T)

Where:
L = learning depth
A = academic application
C = competency insight
T = transformative understanding

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) L = LEARNING DEPTH
L = 0.20*L1 + 0.20*L2 + 0.20*L3 + 0.20*L4 + 0.20*L5
(L1: lesson identified clearly, L2: lesson specific to project, L3: reflection beyond description, L4: connected to real experience, L5: depth and maturity)

2) A = ACADEMIC APPLICATION
A = 0.20*A1 + 0.20*A2 + 0.20*A3 + 0.20*A4 + 0.20*A5
(A1: academic field identified, A2: concept/tool referenced, A3: applied meaningfully, A4: relevant to project, A5: explanation clear and specific)

3) C = COMPETENCY INSIGHT
C = 0.20*C1 + 0.20*C2 + 0.20*C3 + 0.20*C4 + 0.20*C5
(C1: competency identified, C2: relevant to project, C3: development explained, C4: supported by examples, C5: self-awareness shown)

4) T = TRANSFORMATIVE UNDERSTANDING
T = 0.20*T1 + 0.20*T2 + 0.20*T3 + 0.20*T4 + 0.20*T5
(T1: perspective shift identified, T2: social/ethical understanding deepened, T3: personal/professional growth insight, T4: connected to community realities, T5: durable meaning)

OUTPUT FORMAT
Return:
Learning Depth (L) = ___
Academic Application (A) = ___
Competency Insight (C) = ___
Transformative Understanding (T) = ___

Section 9 CII Score = ___ / 5

WRITING QUALITY GUARDRAIL:
Do not heavily penalize minor language mistakes when meaning is clear. But if writing is vague, repetitive, generic, unclear, or appears template/AI-like without personal insight, reduce this section score appropriately.

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 10 SUMMARY
      // =====================================================
      case 'section10_summary':
        return `You are the CIEL PK AI Sustainability Analysis and Summarization Engine. Read everything the student entered in Section 9 — Sustainability (9.1 Will the impact continue, 9.2 What continues / what stops, 9.3 What keeps it alive, 9.4 Scaling & system influence, 9.5 Follow-up check) and write ONE professional, evidence-based sustainability summary: what is likely to remain after the project, what may stop, who will sustain the benefits, what support is still required, whether the initiative can expand, and how continued impact will be verified. This is the "AI Summary — Project Sustainability" shown on the report; it is not a score.

SECTION 9 AS SAVED BY THE STUDENT
${describeSection10ForSummary(data)}

SUMMARIZATION RULES
1. Process every completed answer above: the selected classification, the written explanation, every selected mechanism and the conditional follow-up fields.
2. Write ONE integrated paragraph of 120–160 words (160 is a hard maximum). To stay inside it: use at most 7 sentences, no sentence longer than 22 words, one sentence per element of the order below, no restating of the same fact in different words. Plain text only: no heading, no label, no bullets, no markdown, no quotation marks around the paragraph.
3. Order: sustainability classification and its justification → what continues → what stops → ownership and support mechanisms (the responsible partner, institution or community owner where given) → resource, maintenance or funding still required → realistic scalability → system influence → follow-up and verification arrangement. It must read as one assessment, not answers joined together.
4. Preserve the student's classification exactly (Yes / Partial / No). Never upgrade Partial to Yes, and never soften a No.
5. A selected mechanism is an intended arrangement, not proof it has happened. Say "is expected to", "is planned", "according to the student" unless the explanation confirms it was done (for example a completed handover or training). Distinguish confirmed arrangements, intended actions and unverified expectations.
6. Distinguish a completed output remaining in place (a renovated room, planted trees) from demonstrated long-term outcomes. Do not present unverified benefits as sustained results.
7. Scaling: report the selected level as potential, not as documented expansion. Never claim institutional or policy change solely because the project succeeded; if system influence was selected without supporting explanation, say so cautiously.
8. Follow-up: state whether a check is planned, not planned (with the stated reason) or not decided yet. Where planned, give the responsible person's role, the timing and what will be checked. A scheduled follow-up is not a completed one. If no follow-up is planned, say so plainly without inventing a monitoring arrangement.
9. Never invent commitments, funding, ownership, partnerships, names, follow-up results or policy changes. Anything marked [not entered] is absent: leave it out or, where the reader would otherwise be misled, say it was not recorded. Never write the literal text "[not entered]".
10. Remove duplication between the written explanation and the selected mechanisms. Keep all relevant facts, figures, timelines and named responsibilities (by role).
11. Exclude unrelated activities, SDGs or impact statistics. Internal consistency checks and "where the report travels" information are not sustainability evidence.
12. Clear, professional, third-person language suitable for university impact reporting ("the student", "the team", "the partner"). Do not mention question numbers, field names or this prompt. Where evidence is thin, use cautious language rather than optimistic claims.

Output the paragraph only.`;

      // =====================================================
      // SECTION 10 EVALUATION
      // =====================================================
      case 'section10_evaluation':
        return `Evaluate Section 10 — SUSTAINABILITY, CONTINUATION & SCALING and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 10 — SUSTAINABILITY, CONTINUATION & SCALING
Weight = 5
Core Formula
S10=5×(0.30*C + 0.25*M + 0.25*S + 0.20*P)

Where:
C = continuation realism
M = sustainability mechanism strength
S = scaling potential
P = policy/system relevance

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) C = CONTINUATION REALISM
C = 0.20*C1 + 0.20*C2 + 0.20*C3 + 0.20*C4 + 0.20*C5
(C1: continuation plan stated, C2: what will continue is identified, C3: limits/stops acknowledged, C4: support requirements identified, C5: claim is realistic)

2) M = SUSTAINABILITY MECHANISM STRENGTH
M = 0.20*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.20*M5
(M1: mechanism exists, M2: mechanism relevance, M3: mechanism clarity, M4: mechanism feasibility, M5: mechanism strength/dependability)

3) S = SCALING POTENTIAL
S = 0.20*S1 + 0.20*S2 + 0.20*S3 + 0.20*S4 + 0.20*S5
(S1: scaling possibility identified, S2: replicability of project model, S3: transferability, S4: enabling conditions exist, S5: scaling claim is realistic)

4) P = POLICY / SYSTEM RELEVANCE
P = 0.20*P1 + 0.20*P2 + 0.20*P3 + 0.20*P4 + 0.20*P5
(P1: system/policy relevance identified, P2: connection to issue, P3: practical value beyond immediate project, P4: broader usefulness, P5: realism of claim)

OUTPUT FORMAT
Return:
Continuation Realism (C) = ___
Sustainability Mechanism Strength (M) = ___
Scaling Potential (S) = ___
Policy/System Relevance (P) = ___

Section 10 CII Score = ___ / 5

WRITING QUALITY GUARDRAIL:
Do not heavily penalize minor language mistakes when meaning is clear. But if writing is vague, repetitive, generic, unclear, or appears template/AI-like without personal insight, reduce this section score appropriately.

Provide a brief explanation of the score.`;

      // =====================================================
      // CII INDEX OVERALL REVIEW
      // =====================================================
      case 'cii_index':
        return `You are ChatGPT acting as a CIEL Composite Impact Index (CII) auditor.

Review the submitted report data and the calculated CII index values. Do not invent missing evidence.

INPUTS:
Data: ${JSON.stringify(data)}

TASK:
1. Explain the overall CII index score in professional institutional language.
2. Identify the strongest scoring areas.
3. Identify weak or risky areas that may reduce the CII index.
4. Cross-check whether the numeric score is consistent with the report evidence.
5. Provide short improvement guidance without changing the score.

OUTPUT FORMAT:
CII Index Score: ___ / 100
CII Level: ___
Score Interpretation: ___
Strong Areas: ___
Weak Areas / Risks: ___
Audit Remark: ___

Keep the full response under 180 words.`;

      // =====================================================
      // CII ANALYZER (CII Rubric v4.5)
      // =====================================================
      case 'cii_v4_5_evaluation':
        return `Evaluate this Community Service report against the CII Rubric v5.0 Hybrid (85-point report-quality layer) embedded in your system instructions. Return only the nine AI dimensions, anchors and narrative text — never Dimension 7, a numeric score or a badge.

REPORT DATA:
${JSON.stringify(data)}`;

      // =====================================================
      // FYP AI EVALUATION (FYP-MM 1.0 Faculty Review Loop)
      // =====================================================
      case 'fyp_ai_evaluation':
        return `Evaluate this Final Year Project / Thesis submission against the FYP-MM 1.0 rubric embedded in your system instructions.

SUBMISSION DATA:
${JSON.stringify(data)}`;

      case 'npe_ranking_evaluation':
        return `Evaluate this approved Community Service package against the National Project Excellence rubric (${NPE_RANKING_JSON_ONLY_NOTE}).

PACKAGE DATA:
${JSON.stringify(data)}`;

      default:
        return `Summarize project data professionally: ${JSON.stringify(data)}`;
    }
  }

  /** True when this environment can call OpenAI at all (drives the public AI-draft flag). */
  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  }

  /**
   * Student "Generate & Auto-Fill": drafts the editable text fields of an opportunity from rough
   * notes. Returns validated fields only (see opportunity-draft.util.ts); the student reviews all.
   */
  /**
   * Section 9.5 follow-up (spec "Developer handoff"): optional server-side extraction of the
   * verification questions from the approved report. The caller validates and falls back to the
   * rule-based generator; this method only talks to the model and parses its JSON.
   */
  async generateFollowUpQuestionDraft(input: {
    projectRef: Record<string, unknown>;
    activities: unknown[];
    outcomes: unknown[];
    sustainability: Record<string, unknown>;
    maxQuestions: number;
  }): Promise<
    Array<{
      activityId: string | null;
      activityTitle: string;
      questionText: string;
      countLabel: string | null;
      sourceFieldIds: string[];
      reason: string;
    }>
  > {
    if (!this.isConfigured()) {
      throw new Error('OPENAI_API_KEY missing');
    }
    const system = `You are CIEL PK's Sustainability Follow-up Question Extractor.
INPUT: One approved project with its official project id / report id, opportunity objective, Section 4 activities and verified outputs, Section 5 measured or estimated outcomes, and Section 9 sustainability mechanisms and the student's intended follow-up check.
TASK: Identify each materially distinct long-term benefit or maintained output that a partner could credibly observe after the project end date. Create one short, neutral, verifiable question per distinct benefit, normally 2–5 per project. Do not combine unrelated interventions into a single vague question.
RULES:
1. Use ONLY the supplied report fields. Cite the source field ids per question.
2. Prioritise ongoing use, condition, adoption and measurable persistence over vague satisfaction.
3. Distinguish completed versus planned/unverified activities; skip cancelled or undelivered ones. Never assert that a planned activity happened.
4. For one-time relief with no expected lasting outcome, do NOT force sustainability verification.
5. If a number is meaningful, provide an optional count label with its unit. Never invent counts.
6. Merge questions only when they assess the exact same continuing benefit.
7. The partner must be able to answer Yes / Partially / No / Unable to verify, optionally with a number or comment.
8. Do not ask partners to certify causal learning gains or anything they cannot observe.
9. Plain professional English, no field names inside the question text.
OUTPUT: JSON only: {"questions":[{"activity_id":string|null,"activity_title":string,"question":string,"optional_numeric":{"label":string}|null,"source_field_ids":string[],"rationale":string}]}`;
    const prompt = `MAX_QUESTIONS: ${Math.max(1, Math.min(10, input.maxQuestions))}
PROJECT: ${JSON.stringify(input.projectRef)}
SECTION_4_ACTIVITIES: ${JSON.stringify(input.activities).slice(0, 12_000)}
SECTION_5_OUTCOMES: ${JSON.stringify(input.outcomes).slice(0, 6_000)}
SECTION_9_SUSTAINABILITY_AND_FOLLOWUP_FOCUS: ${JSON.stringify(input.sustainability).slice(0, 4_000)}`;
    const text = await this.generateSummaryWithOpenAI(prompt, {
      systemMessage: system,
      responseFormat: { type: 'json_object' },
      temperature: 0.2,
      maxTokens: 4000,
      reasoningEffort: 'low',
      timeoutMs: 60_000,
      retryEmptyOnce: true,
    });
    const parsed = JSON.parse(text) as { questions?: unknown };
    const rows = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return rows
      .map((row) => {
        const r = (row && typeof row === 'object' ? row : {}) as Record<
          string,
          unknown
        >;
        const numeric = (
          r.optional_numeric && typeof r.optional_numeric === 'object'
            ? r.optional_numeric
            : {}
        ) as Record<string, unknown>;
        return {
          activityId: s(r.activity_id) || null,
          activityTitle: s(r.activity_title) || 'Project activity',
          questionText: s(r.question),
          countLabel: s(numeric.label) || null,
          sourceFieldIds: Array.isArray(r.source_field_ids)
            ? r.source_field_ids.map(s).filter(Boolean)
            : [],
          reason: s(r.rationale),
        };
      })
      .filter((q) => q.questionText.length >= 10)
      .slice(0, Math.max(1, Math.min(10, input.maxQuestions)));
  }

  async generateOpportunityDraft(
    input: OpportunityDraftInput,
  ): Promise<{ fields: OpportunityDraftFields; model: string }> {
    if (!this.isConfigured()) {
      throw new HttpException(
        { error: 'AI drafting is not available right now.' },
        503,
      );
    }
    let text: string;
    try {
      text = await this.generateSummaryWithOpenAI(
        buildOpportunityDraftPrompt(input),
        {
          systemMessage: OPPORTUNITY_DRAFT_SYSTEM_PROMPT,
          responseFormat: { type: 'json_object' },
          temperature: 0.5,
          maxTokens: 6000,
          reasoningEffort: 'low',
          timeoutMs: 60_000,
          retryEmptyOnce: true,
        },
      );
    } catch (error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: unknown }).status
          : undefined;
      if (status === 429) {
        throw new HttpException(
          { error: 'AI limit reached. Please wait a minute and try again.' },
          429,
        );
      }
      if (status === 504) {
        throw new HttpException(
          { error: 'The AI took too long. Please try again.' },
          504,
        );
      }
      this.logger.warn(
        `Opportunity draft failed: ${resolveOpenAiErrorMessage(error)}`,
      );
      throw new HttpException(
        {
          error:
            'AI drafting failed. Please try again or fill the form yourself.',
        },
        503,
      );
    }
    const fields = parseOpportunityDraftResponse(text);
    if (!fields) {
      throw new HttpException(
        { error: 'AI returned an unreadable draft. Please try again.' },
        502,
      );
    }
    return { fields, model: resolveOpenAiSummaryModel() };
  }

  async summarize(
    section: string,
    data: any,
    opts?: { skipEvidenceImages?: boolean },
  ): Promise<AiSummarizeResult> {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      // Student Next-step summaries are optional. Do not 500 (or toast the key) when
      // OpenAI is unset — Admin CII / FYP / NPE still need a hard failure.
      if (!ADMIN_EVAL_SECTIONS.has(section)) {
        return { summary: '', skipped: true };
      }
      throw new HttpException(
        {
          error:
            'OpenAI API key is not configured on the backend server. Set OPENAI_API_KEY in the backend hosting environment (e.g. Vercel → Settings → Environment Variables) and redeploy, then run the analyser again.',
          code: 'OPENAI_API_KEY_MISSING',
        },
        500,
      );
    }

    const isCiiV45Evaluation = section === 'cii_v4_5_evaluation';
    const isFypAiEvaluationSection = section === 'fyp_ai_evaluation';
    const isNpeRanking = section === 'npe_ranking_evaluation';
    const isSection2Summary = section === 'section2';
    const isSection2Evaluation = section === 'section2_evaluation';
    const isSection10Summary = section === 'section10_summary';
    const isSection10Evaluation = section === 'section10_evaluation';
    const prompt = this.buildPrompt(
      section,
      (isCiiV45Evaluation
        ? slimCiiPayloadForModel(data)
        : isSection2Summary
          ? section2SummaryView(data)
          : isSection2Evaluation
            ? withoutSafeguardingFields(data)
            : isSection10Summary
              ? section10SummaryView(data)
              : isSection10Evaluation
                ? withoutFollowUpFields(data)
                : data) as SectionPromptData,
    );

    const openAiOpts: OpenAiCompletionOpts | undefined = isCiiV45Evaluation
      ? {
          model: resolveCiiAnalyzerModel(),
          reasoningEffort: 'low',
          temperature: 0.15,
          seed: 4220,
          maxTokens: 16_000,
          responseFormat: { type: 'json_object' },
          systemMessage: `${CII_V4_5_EVALUATOR_PROMPT}\n\n${CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE}`,
          // gpt-5.6-sol regularly needs >90s. 180s + empty retry only if the first
          // call finished quickly stays under the FE/BFF 300s analyser timeout.
          timeoutMs: 180_000,
          maxAttempts: 1,
          retryEmptyOnce: true,
        }
      : isFypAiEvaluationSection
        ? {
            temperature: 0.15,
            seed: 4230,
            maxTokens: 16000,
            responseFormat: { type: 'json_object' },
            systemMessage: `${buildFypAiEvaluatorPrompt()}\n\n${FYP_AI_JSON_ONLY_DEPLOYMENT_NOTE}`,
          }
        : isNpeRanking
          ? {
              model: resolveCiiAnalyzerModel(),
              reasoningEffort: 'low',
              temperature: 0.15,
              seed: 4240,
              maxTokens: 12_000,
              responseFormat: { type: 'json_object' },
              systemMessage: `${NPE_RANKING_EVALUATOR_PROMPT}\n\n${NPE_RANKING_JSON_ONLY_NOTE}`,
              timeoutMs: 120_000,
              maxAttempts: 1,
              retryEmptyOnce: true,
            }
          : undefined;

    // CII v5.0 Hybrid: report-quality only. Evidence originals stay with Admin Dimension 7.
    // NPE ranking reads originals when they can be loaded; unread files are flagged, not guessed.
    let userContent: string | OpenAiContentPart[] = prompt;
    let evidenceInspection: EvidenceInspection | undefined;
    if (isCiiV45Evaluation) {
      evidenceInspection = { inspected: [], notInspected: [] };
      userContent = `${prompt}

EVIDENCE FIREWALL
No evidence originals, filenames, captions or file metadata are attached to this request. Score report quality only. Always set evidenceIds to []. Do not return Dimension 7. Do not mark claims as photograph-verified.`;
    } else if (isNpeRanking && !opts?.skipEvidenceImages) {
      const built = await this.buildEvidenceParts(data);
      evidenceInspection = built.inspection;
      if (built.parts.length) {
        userContent = [{ type: 'text', text: prompt }, ...built.parts];
      }
    }

    let text: string;
    try {
      text = await this.generateSummaryWithOpenAI(userContent, openAiOpts);
    } catch (error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: unknown }).status
          : undefined;
      if (status === 429) {
        throw new HttpException(
          { error: 'AI limit reached. Please wait.' },
          429,
        );
      }
      if (status === 503) {
        throw new HttpException(
          { error: 'AI servers overloaded. Try again shortly.' },
          503,
        );
      }
      throw new HttpException({ error: resolveOpenAiErrorMessage(error) }, 500);
    }

    const summary = text.trim();

    if (isCiiV45Evaluation) {
      const ciiV45 = parseCiiV45Response(summary);
      if (!ciiV45) {
        throw new HttpException(
          {
            error:
              'AI returned an unreadable CII v5.0 evaluation. Please retry.',
          },
          502,
        );
      }
      return {
        summary,
        ciiV45,
        evidenceInspection,
        model: resolveCiiAnalyzerModel(),
      };
    }

    if (isFypAiEvaluationSection) {
      const fypAi = parseFypAiResponse(summary);
      if (!fypAi) {
        throw new HttpException(
          { error: 'AI returned an unreadable FYP evaluation. Please retry.' },
          502,
        );
      }
      return { summary, fypAi };
    }

    if (isNpeRanking) {
      const npeRanking = parseNpeRankingResponse(summary);
      if (!npeRanking) {
        throw new HttpException(
          {
            error:
              'AI returned an unreadable national ranking evaluation. Please retry.',
          },
          502,
        );
      }
      return {
        summary,
        npeRanking,
        evidenceInspection,
        model: resolveCiiAnalyzerModel(),
      };
    }

    return { summary };
  }
}

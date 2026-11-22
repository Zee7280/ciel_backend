import {
  hasPublicSharePermission,
  resolveMediaVisibility,
} from './media-visibility.util';

export type ReportSubmitValidationIssue = {
  section: number;
  field: string;
  message: string;
};

function pickUseResources(
  section6: Record<string, unknown> | null | undefined,
): string {
  const raw = section6?.use_resources ?? section6?.used_resources;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Section 5 (Resources) 6.2 — "What did it make possible?" must be a line, not a word. */
export const RESOURCE_PURPOSE_MIN_WORDS = 3;

/** Section 5 (Resources) accountability — same rule as the student form (resourceContributors.ts). */
const INTERNAL_RESOURCE_SOURCES = new Set(['Student Team', 'Self-funded']);

export function isExternalResourceSource(sources: unknown): boolean {
  return (Array.isArray(sources) ? sources : []).some(
    (s) =>
      typeof s === 'string' &&
      s.trim() &&
      !INTERNAL_RESOURCE_SOURCES.has(s.trim()),
  );
}

function contributorPhoneLooksValid(code: unknown, number: unknown): boolean {
  const digits = stringField(number).replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return false;
  // The country code is mandatory ("mobile number with country code").
  const cc = stringField(code).replace(/\D/g, '');
  if (!cc) return false;
  return /^\+\d{8,15}$/.test(`+${cc}${digits}`);
}

function contributorEmailLooksValid(email: unknown): boolean {
  const e = stringField(email).trim();
  return !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** `String()` over a loosely-typed form value (same coercion; typed so the linter knows it is not a bare object). */
function stringifyLoose(value: unknown): string {
  return String(value as { toString(): string });
}

function isOtherChoice(value: unknown): boolean {
  const text = stringField(value).trim();
  if (!text) return false;
  if (/^other$/i.test(text)) return true;
  return /other\s*\/\s*custom/i.test(text);
}

function isOtherMechanism(value: unknown): boolean {
  const text = stringField(value)
    .replace(/^✏️\s*/, '')
    .trim();
  return /^other$/i.test(text);
}

function isOtherSkill(value: unknown): boolean {
  const text = stringField(value)
    .replace(/^✏️\s*/, '')
    .trim();
  return /^other$/i.test(text);
}

function listHasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Mirrors ciel_frontend report/utils/validation.ts FIELD_WORD_POLICY/countWords — the frontend
 * wizard enforces these ranges live, but a direct API submit skipped them entirely. Keep both
 * copies in sync if the frontend policy changes. */
const DEFAULT_WORD_MIN = 10;
const DEFAULT_WORD_MAX = 200;
const FIELD_WORD_POLICY: Record<string, { min: number; max: number }> = {
  problem_statement: { min: 10, max: 60 },
  discipline_contribution: { min: 15, max: 50 },
  contribution_intent_statement: { min: 30, max: 80 },
  student_contribution_intent_statement: { min: 10, max: 60 },
  justification_text: { min: 10, max: 60 },
  // V19: "describe only what you observed; if nothing could be measured, say so" — short is fine.
  observed_change: { min: 8, max: 100 },
  challenges: { min: 15, max: 60 },
  continuation_details: { min: 60, max: 120 },
  description: { min: 15, max: 60 },
  measurement_explanation: { min: 10, max: 80 },
  overlap_note: { min: 10, max: 80 },
  evidence_caption: { min: 10, max: 45 },
};

function countWords(value: unknown): number {
  return stringField(value)
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/** Only checks the range when text is present — the plain presence/required checks above already
 * raise a separate issue for empty fields, so this never double-reports "field is required". */
function checkWordRange(
  issues: ReportSubmitValidationIssue[],
  section: number,
  field: string,
  value: unknown,
  label: string,
  policyKey?: string,
): void {
  const text = stringField(value);
  if (!text.trim()) return;
  const { min, max } = FIELD_WORD_POLICY[policyKey ?? field] ?? {
    min: DEFAULT_WORD_MIN,
    max: DEFAULT_WORD_MAX,
  };
  const n = countWords(text);
  if (n < min || n > max) {
    issues.push({
      section,
      field,
      message: `${label} must be ${min}–${max} words (${n} current)`,
    });
  }
}

/** Same 12 keys the live Reflection tab (validateSection9) requires. */
const COMPETENCY_SCORE_KEYS = [
  'cognitive_systemic',
  'cognitive_critical',
  'cognitive_evaluate',
  'practical_design',
  'practical_evidence',
  'practical_engagement',
  'social_empathy',
  'social_diversity',
  'social_collaboration',
  'transformative_longterm',
  'transformative_benefits',
  'transformative_sustainability',
] as const;

function competencyScoresComplete(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const scores = value as Record<string, unknown>;
  return COMPETENCY_SCORE_KEYS.every((key) => Number(scores[key]) >= 1);
}

/**
 * Mirrors frontend validateSection4: a titled quantity, a legacy output string, beneficiary reach,
 * or (V19) the explicit "no countable output is applicable" declaration with its reason.
 */
function activityHasOutputOrReach(block: Record<string, unknown>): boolean {
  if (block.no_output === true) {
    return stringField(block.no_output_reason).trim().length > 0;
  }
  const outputs = Array.isArray(block.outputs) ? block.outputs : [];
  const hasOutput = outputs.some((entry) => {
    if (typeof entry === 'string') return entry.trim().length > 0;
    const out = (entry || {}) as Record<string, unknown>;
    return (
      stringField(out.title).trim().length > 0 &&
      stringifyLoose(out.quantity ?? '').trim().length > 0
    );
  });
  const gross = stringifyLoose(block.beneficiaries_reached ?? '').trim();
  const unique = stringifyLoose(
    block.unique_beneficiaries ?? block.beneficiaries_reached ?? '',
  ).trim();
  return hasOutput || (gross.length > 0 && unique.length > 0);
}

/**
 * Safety net that mirrors the live wizard (ciel_frontend report/utils/validation.ts), including
 * its FIELD_WORD_POLICY word-count ranges (see checkWordRange above) — a direct API submit can no
 * longer skip either the required fields or the word-count minimums the wizard UI already enforces.
 */
/** All four wizard flags (authentic, informed consent, no harm, privacy) — one confirmation statement in the UI. */
export function evidenceEthicsConfirmed(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const flags = value as Record<string, unknown>;
  return [
    'authentic',
    'informed_consent',
    'no_harm',
    'privacy_respected',
  ].every((key) => flags[key] === true);
}

function hasChosenValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return (
    stringField(value).trim().length > 0 ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** "None identified" chip id — keep in sync with the frontend utils/riskSafeguarding.ts. */
const RISK_NONE_ID = 'none';

/**
 * Section 2.3 (risk, safeguarding & consent). Backward compatible on purpose: a report with no
 * risk chips (saved before 2.3 existed, or "None identified") is never blocked; once a real
 * risk is selected the mitigation, consent status and on-site lead become required.
 */
type AttendanceLogLike = {
  date?: unknown;
  approval_status?: unknown;
  approvalStatus?: unknown;
  entryStatus?: unknown;
  entry_status?: unknown;
  evidence_file?: unknown;
  evidence_url?: unknown;
  evidenceUrl?: unknown;
  evidence_urls?: unknown;
  evidenceUploaded?: unknown;
  evidence_uploaded?: unknown;
};

/** Mirrors the wizard's `logHasEvidence`: any URL, uploaded flag or attached file counts. */
export function attendanceLogHasEvidence(log: AttendanceLogLike): boolean {
  if (log.evidence_file) return true;
  if (log.evidenceUploaded === true || log.evidence_uploaded === true)
    return true;
  for (const v of [log.evidence_url, log.evidenceUrl]) {
    if (typeof v === 'string' && v.trim()) return true;
  }
  return Array.isArray(log.evidence_urls) && log.evidence_urls.length > 0;
}

/**
 * Counted sessions (not rejected) that are neither approved / verified by a reviewer nor backed by
 * evidence. Faculty-approved sessions are left alone: the reviewer already accepted them as logged.
 */
export function attendanceSessionsWithoutEvidence(
  logs: unknown,
): AttendanceLogLike[] {
  if (!Array.isArray(logs)) return [];
  return logs.filter((raw): raw is AttendanceLogLike => {
    if (!raw || typeof raw !== 'object') return false;
    const log = raw as AttendanceLogLike;
    const approval = stringField(log.approval_status ?? log.approvalStatus)
      .trim()
      .toLowerCase();
    const entry = stringField(log.entryStatus ?? log.entry_status)
      .trim()
      .toLowerCase();
    if (approval === 'rejected') return false;
    if (approval === 'approved' || entry === 'verified') return false;
    return !attendanceLogHasEvidence(log);
  });
}

export function validateRiskSafeguarding(
  section2: Record<string, unknown>,
): ReportSubmitValidationIssue[] {
  const factors = Array.isArray(section2.risk_factors)
    ? section2.risk_factors.filter(
        (f) => typeof f === 'string' && f.trim() && f !== RISK_NONE_ID,
      )
    : [];
  if (factors.length === 0) return [];
  const issues: ReportSubmitValidationIssue[] = [];
  if (!stringField(section2.risk_mitigation).trim()) {
    issues.push({
      section: 2,
      field: 'risk_mitigation',
      message: 'Say what you did to manage the risks you selected',
    });
  }
  if (!stringField(section2.risk_consent).trim()) {
    issues.push({
      section: 2,
      field: 'risk_consent',
      message: 'Choose the consent status for photos and data',
    });
  }
  if (!stringField(section2.risk_safeguarding_lead).trim()) {
    issues.push({
      section: 2,
      field: 'risk_safeguarding_lead',
      message: 'Name the person responsible for safeguarding on site',
    });
  }
  return issues;
}

const FOLLOWUP_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOLLOWUP_OTHER = 'Other';

function isIsoDate(value: unknown): boolean {
  const raw = stringField(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Section 10 · 9.5 "Follow-up check". Backward compatible on purpose: a report with no
 * followup_plan (saved before 9.5 existed, or still unanswered) and "Not decided yet" are never
 * blocked. "No" needs a reason; "Yes" needs the responsible role, name, a valid email and a due
 * date. Mirrors the frontend utils/sustainabilityFollowup.ts.
 */
export function validateFollowUp(
  section10: Record<string, unknown>,
): ReportSubmitValidationIssue[] {
  const plan = stringField(section10.followup_plan).trim();
  const issues: ReportSubmitValidationIssue[] = [];
  const add = (field: string, message: string) =>
    issues.push({ section: 10, field, message });
  if (plan === 'no') {
    const reason = stringField(section10.followup_no_reason).trim();
    if (!reason) {
      add('followup_no_reason', 'Select a brief reason for no follow-up');
    } else if (
      reason === FOLLOWUP_OTHER &&
      !stringField(section10.followup_no_reason_other).trim()
    ) {
      add('followup_no_reason_other', 'Add a short explanation');
    }
  } else if (plan === 'yes') {
    if (!stringField(section10.followup_owner_role).trim()) {
      add('followup_owner_role', 'Choose who will check the results');
    }
    if (!stringField(section10.followup_owner_name).trim()) {
      add('followup_owner_name', "Enter the responsible person's name");
    }
    const email = stringField(section10.followup_owner_email).trim();
    if (!email) {
      add(
        'followup_owner_email',
        'Enter an email for the follow-up invitation',
      );
    } else if (!FOLLOWUP_EMAIL_RE.test(email)) {
      add('followup_owner_email', 'Enter a valid email address');
    }
    if (!isIsoDate(section10.followup_due_date)) {
      add('followup_due_date', 'Choose when the results should be checked');
    }
    // Optional reviewed question set: every kept question needs real text (an empty set simply
    // means "use the suggested questions").
    const questions = Array.isArray(section10.followup_questions)
      ? (section10.followup_questions as unknown[])
      : [];
    questions.forEach((item, index) => {
      const q = (item && typeof item === 'object' ? item : {}) as Record<
        string,
        unknown
      >;
      if (q.include === false) return;
      if (stringField(q.questionText).trim().length < 5) {
        add(
          `followup_questions.${index}.questionText`,
          'Write the follow-up question in a few words, or untick it',
        );
      }
    });
  }
  return issues;
}

function validateCoreSectionsPresence(report: {
  section1?: Record<string, unknown> | null;
  section2?: Record<string, unknown> | null;
  section3?: Record<string, unknown> | null;
  section4?: Record<string, unknown> | null;
  section5?: Record<string, unknown> | null;
  section7?: Record<string, unknown> | null;
  section9?: Record<string, unknown> | null;
  section11?: Record<string, unknown> | null;
}): ReportSubmitValidationIssue[] {
  const issues: ReportSubmitValidationIssue[] = [];

  const section1 = report.section1 || {};
  const reviewChecked = Array.isArray(section1.review_checked)
    ? section1.review_checked
    : [];
  // Mirrors report/utils/validation.ts validateSection1: all three declaration
  // boxes, not privacy_consent alone.
  const declarationComplete =
    reviewChecked.length >= 3 && reviewChecked.slice(0, 3).every(Boolean);
  const hasPrivacyConsent = Boolean(
    section1.privacy_consent || reviewChecked[2],
  );
  if (!declarationComplete) {
    issues.push({
      section: 1,
      field: 'review_checked',
      message: 'All three declaration checkboxes must be confirmed',
    });
  }
  if (!hasPrivacyConsent) {
    issues.push({
      section: 1,
      field: 'privacy_consent',
      message: 'Privacy consent is required',
    });
  }
  // V19 item 08 — every counted attendance session needs a photo / document. Sessions the
  // faculty already approved or verified are trusted as they are; rejected ones do not count.
  const sessionsWithoutEvidence = attendanceSessionsWithoutEvidence(
    section1.attendance_logs,
  );
  if (sessionsWithoutEvidence.length) {
    const dates = sessionsWithoutEvidence
      .map((log) => stringField(log.date).slice(0, 10))
      .filter(Boolean)
      .slice(0, 5)
      .join(', ');
    issues.push({
      section: 1,
      field: 'attendance_logs',
      message: `${sessionsWithoutEvidence.length} attendance session${
        sessionsWithoutEvidence.length === 1 ? ' has' : 's have'
      } no supporting evidence${dates ? ` (${dates})` : ''}. Add a photo or document to each session in Section 1, or remove it.`,
    });
  }
  const section2 = report.section2 || {};
  if (!stringField(section2.problem_statement).trim()) {
    issues.push({
      section: 2,
      field: 'problem_statement',
      message: 'Problem statement is required',
    });
  } else {
    checkWordRange(
      issues,
      2,
      'problem_statement',
      section2.problem_statement,
      'Problem statement',
    );
  }
  if (!stringField(section2.affected_group).trim()) {
    issues.push({
      section: 2,
      field: 'affected_group',
      message: 'Who was affected is required',
    });
  }
  const affectedCount = Number(
    stringifyLoose(section2.affected_count ?? '').replace(/,/g, ''),
  );
  if (
    !stringField(section2.affected_count).trim() ||
    !Number.isFinite(affectedCount) ||
    affectedCount <= 0
  ) {
    issues.push({
      section: 2,
      field: 'affected_count',
      message: 'Enter the approximate number affected',
    });
  }
  if (!listHasItems(section2.system_gaps)) {
    issues.push({
      section: 2,
      field: 'system_gaps',
      message: 'Choose at least one thing that was missing',
    });
  } else if (
    (section2.system_gaps as unknown[]).some(
      (gap) => String(gap) === 'Other',
    ) &&
    !stringField(section2.system_gaps_other).trim() &&
    !listHasItems(section2.system_gaps_other_entries)
  ) {
    issues.push({
      section: 2,
      field: 'system_gaps_other',
      message: 'Please specify the "Other" system gap',
    });
  }
  if (!section2.discipline) {
    issues.push({
      section: 2,
      field: 'discipline',
      message: 'Academic discipline is required',
    });
  } else if (
    section2.discipline === 'Other…' &&
    !stringField(section2.discipline_other).trim()
  ) {
    issues.push({
      section: 2,
      field: 'discipline_other',
      message: 'Please name your discipline',
    });
  }
  if (!stringField(section2.discipline_contribution).trim()) {
    issues.push({
      section: 2,
      field: 'discipline_contribution',
      message: 'Discipline contribution explanation is required',
    });
  } else {
    checkWordRange(
      issues,
      2,
      'discipline_contribution',
      section2.discipline_contribution,
      'Discipline contribution explanation',
    );
  }
  issues.push(...validateRiskSafeguarding(section2));

  const section3 = report.section3 || {};
  if (!stringField(section3.contribution_intent_statement).trim()) {
    issues.push({
      section: 3,
      field: 'contribution_intent_statement',
      message: 'Contribution logic is required',
    });
  } else {
    checkWordRange(
      issues,
      3,
      'contribution_intent_statement',
      section3.contribution_intent_statement,
      'Contribution logic',
    );
  }
  // Mirrors frontend validateSection3's hasStudentMappingSelection: only required once the
  // student has actually picked their own SDG mapping (primary_sdg), not for every report.
  const studentPrimarySdg = (section3.primary_sdg || {}) as Record<
    string,
    unknown
  >;
  const hasStudentMappingSelection = Boolean(
    studentPrimarySdg.goal_number ||
    studentPrimarySdg.target_id ||
    studentPrimarySdg.target_code ||
    studentPrimarySdg.indicator_id ||
    studentPrimarySdg.indicator_code,
  );
  if (hasStudentMappingSelection) {
    if (!stringField(section3.student_contribution_intent_statement).trim()) {
      issues.push({
        section: 3,
        field: 'student_contribution_intent_statement',
        message: 'Student contribution logic is required',
      });
    } else {
      checkWordRange(
        issues,
        3,
        'student_contribution_intent_statement',
        section3.student_contribution_intent_statement,
        'Student contribution logic',
      );
    }
  }
  const secondarySdgs = Array.isArray(section3.secondary_sdgs)
    ? section3.secondary_sdgs
    : [];
  secondarySdgs.forEach((entry, index) => {
    const sdg = (entry || {}) as Record<string, unknown>;
    // V19 3.2 — a student-discovered SDG is only credible with its Target and Indicator.
    if (!stringField(sdg.target_id).trim()) {
      issues.push({
        section: 3,
        field: `secondary_sdgs.${index}.target_id`,
        message: `Additional SDG ${index + 1}: choose the closest genuine target`,
      });
    }
    if (!stringField(sdg.indicator_id).trim()) {
      issues.push({
        section: 3,
        field: `secondary_sdgs.${index}.indicator_id`,
        message: `Additional SDG ${index + 1}: the indicator is mandatory`,
      });
    }
    if (!stringField(sdg.justification_text).trim()) {
      issues.push({
        section: 3,
        field: `secondary_sdgs.${index}.justification_text`,
        message: `Secondary SDG ${index + 1}: justification is required`,
      });
    } else {
      checkWordRange(
        issues,
        3,
        `secondary_sdgs.${index}.justification_text`,
        sdg.justification_text,
        `Secondary SDG ${index + 1} justification`,
        'justification_text',
      );
    }
  });
  // V19 item 17 — one contribution statement per SDG registered on the opportunity. The wizard
  // seeds a key per registered secondary SDG; a key left blank means the student skipped it.
  // Older reports without the map are untouched (nothing to check).
  const registeredContributions =
    section3.registered_secondary_contributions &&
    typeof section3.registered_secondary_contributions === 'object' &&
    !Array.isArray(section3.registered_secondary_contributions)
      ? (section3.registered_secondary_contributions as Record<string, unknown>)
      : {};
  Object.keys(registeredContributions)
    .sort((a, b) => Number(a) - Number(b))
    .forEach((goal) => {
      const field = `registered_secondary_contributions.${goal}`;
      const value = registeredContributions[goal];
      if (!stringField(value).trim()) {
        issues.push({
          section: 3,
          field,
          message: `Registered SDG ${goal}: contribution statement is required`,
        });
      } else {
        checkWordRange(
          issues,
          3,
          field,
          value,
          `Registered SDG ${goal} contribution`,
          'justification_text',
        );
      }
    });
  if (
    !Array.isArray(section2.baseline_evidence) ||
    !section2.baseline_evidence.length
  ) {
    issues.push({
      section: 2,
      field: 'baseline_evidence',
      message: 'At least one baseline evidence type is required',
    });
  }

  const section4 = report.section4 || {};
  const activityBlocks = Array.isArray(section4.activity_blocks)
    ? section4.activity_blocks
    : [];
  if (!activityBlocks.length) {
    issues.push({
      section: 4,
      field: 'activity_blocks',
      message: 'At least one activity block is required',
    });
  } else {
    activityBlocks.forEach((entry, index) => {
      const block = (entry || {}) as Record<string, unknown>;
      if (!stringField(block.title).trim()) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.title`,
          message: `Activity ${index + 1}: title is required`,
        });
      }
      if (!block.primary_category) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.primary_category`,
          message: `Activity ${index + 1}: activity family is required`,
        });
      }
      if (
        isOtherChoice(block.primary_category) &&
        !stringField(block.other_category_text).trim()
      ) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.other_category_text`,
          message: `Activity ${index + 1}: custom activity family is required`,
        });
      }
      if (
        block.primary_category &&
        !isOtherChoice(block.primary_category) &&
        !block.sub_category
      ) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.sub_category`,
          message: `Activity ${index + 1}: sub-category is required`,
        });
      }
      if (
        isOtherChoice(block.sub_category) &&
        !stringField(block.other_sub_category_text).trim()
      ) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.other_sub_category_text`,
          message: `Activity ${index + 1}: custom sub-category is required`,
        });
      }
      if (!block.status) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.status`,
          message: `Activity ${index + 1}: status is required`,
        });
      }
      if (!stringField(block.description).trim()) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.description`,
          message: `Activity ${index + 1}: what was done is required`,
        });
      } else {
        checkWordRange(
          issues,
          4,
          `activity_blocks.${index}.description`,
          block.description,
          `Activity ${index + 1} description`,
          'description',
        );
      }
      if (!activityHasOutputOrReach(block)) {
        issues.push({
          section: 4,
          field: `activity_blocks.${index}.outputs`,
          message: `Activity ${index + 1}: add a countable output or a beneficiary reach`,
        });
      }
      // Mirrors frontend step3Ok/stepNeedText: the overlap note is only required once the
      // activity serves beneficiaries and the student didn't say reach was "mostly unique".
      const mostlyUnique = /mostly unique/i.test(
        stringField(block.overlap_status),
      );
      if (
        block.serves_beneficiaries !== false &&
        stringField(block.overlap_status).trim() &&
        !mostlyUnique
      ) {
        if (!stringField(block.overlap_note).trim()) {
          issues.push({
            section: 4,
            field: `activity_blocks.${index}.overlap_note`,
            message: `Activity ${index + 1}: overlap note is required`,
          });
        } else {
          checkWordRange(
            issues,
            4,
            `activity_blocks.${index}.overlap_note`,
            block.overlap_note,
            `Activity ${index + 1} overlap note`,
            'overlap_note',
          );
        }
      }
    });
  }

  const section5 = report.section5 || {};
  if (!stringField(section5.observed_change).trim()) {
    issues.push({
      section: 5,
      field: 'observed_change',
      message: 'Observed change narrative is required',
    });
  } else {
    checkWordRange(
      issues,
      5,
      'observed_change',
      section5.observed_change,
      'Observed change narrative',
    );
  }
  // V19 4.3 — the results story has three blanks: before (carried from Section 2), what changed,
  // and how you know. The last one is the evidence basis for the claim and cannot be blank.
  if (
    !stringField(section5.story_because).trim() &&
    !listHasItems(section5.evidence_basis_tags)
  ) {
    issues.push({
      section: 5,
      field: 'story_because',
      message:
        'How do you know? — name the evidence behind the change (or say that no change could be measured yet)',
    });
  }
  // V19: the single before / after result is optional; when started it must be complete. Older
  // detailed outcomes (no `simple` flag) keep their original rules.
  const allOutcomes = Array.isArray(section5.measurable_outcomes)
    ? section5.measurable_outcomes
    : [];
  allOutcomes.forEach((entry, index) => {
    const outcome = (entry || {}) as Record<string, unknown>;
    if (outcome.simple !== true) return;
    const filled = [
      stringField(outcome.metric),
      stringField(outcome.unit),
      stringifyLoose(outcome.baseline ?? ''),
      stringifyLoose(outcome.endline ?? ''),
      stringField(outcome.measurement_explanation),
    ].filter((v) => v.trim().length > 0).length;
    if (!filled) return;
    const need = (key: string, message: string) =>
      issues.push({
        section: 5,
        field: `measurable_outcomes.${index}.${key}`,
        message,
      });
    if (!stringField(outcome.metric).trim())
      need('metric', 'Name what was measured, or clear the optional result');
    if (!stringField(outcome.unit).trim())
      need('unit', 'Choose the unit of the measured result');
    if (
      !Number.isFinite(Number(stringifyLoose(outcome.baseline ?? '').trim())) ||
      stringifyLoose(outcome.baseline ?? '').trim() === ''
    )
      need('baseline', 'Enter the before value (a number)');
    if (
      !Number.isFinite(Number(stringifyLoose(outcome.endline ?? '').trim())) ||
      stringifyLoose(outcome.endline ?? '').trim() === ''
    )
      need('endline', 'Enter the after value (same unit)');
    if (!stringField(outcome.measurement_explanation).trim())
      need('measurement_explanation', 'Say where these figures come from');
  });
  const outcomes = allOutcomes.filter(
    (entry) => ((entry || {}) as Record<string, unknown>).simple !== true,
  );
  {
    outcomes.forEach((entry, index) => {
      const outcome = (entry || {}) as Record<string, unknown>;
      if (!outcome.outcome_area) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.outcome_area`,
          message: 'Outcome category is required',
        });
      }
      if (
        outcome.outcome_area &&
        outcome.outcome_area !== 'Other' &&
        !outcome.outcome_sub_category
      ) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.outcome_sub_category`,
          message: 'Outcome sub-category is required',
        });
      }
      if (!outcome.metric_category) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.metric_category`,
          message: 'Metric category is required',
        });
      }
      if (!outcome.metric) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.metric`,
          message: 'Primary metric unit is required',
        });
      } else if (
        /^other$/i.test(stringField(outcome.metric).trim()) &&
        !stringField(outcome.metric_other).trim()
      ) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.metric_other`,
          message: 'Please specify the custom metric unit',
        });
      }
      if (
        outcome.baseline === '' ||
        outcome.baseline === undefined ||
        outcome.baseline === null
      ) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.baseline`,
          message: 'Baseline value is required',
        });
      }
      if (
        outcome.endline === '' ||
        outcome.endline === undefined ||
        outcome.endline === null
      ) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.endline`,
          message: 'Endline value is required',
        });
      }
      if (!outcome.unit) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.unit`,
          message: 'Unit of measurement is required',
        });
      }
      if (!hasChosenValue(outcome.confidence_level)) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.confidence_level`,
          message: 'At least one confidence level is required',
        });
      }
      if (!stringField(outcome.measurement_explanation).trim()) {
        issues.push({
          section: 5,
          field: `measurable_outcomes.${index}.measurement_explanation`,
          message: 'Measurement explanation is required',
        });
      } else {
        checkWordRange(
          issues,
          5,
          `measurable_outcomes.${index}.measurement_explanation`,
          outcome.measurement_explanation,
          'Measurement explanation',
          'measurement_explanation',
        );
      }
    });
  }
  if (!stringField(section5.challenges).trim()) {
    issues.push({
      section: 5,
      field: 'challenges',
      message: 'Challenges description is required',
    });
  } else {
    checkWordRange(
      issues,
      5,
      'challenges',
      section5.challenges,
      'Challenges description',
    );
  }

  const section7 = report.section7 || {};
  if (!section7.has_partners) {
    issues.push({
      section: 7,
      field: 'has_partners',
      message: 'Please confirm whether this project had active partners',
    });
  } else if (section7.has_partners === 'yes') {
    const partners = Array.isArray(section7.partners) ? section7.partners : [];
    if (!partners.length) {
      issues.push({
        section: 7,
        field: 'partners',
        message: 'Please list your external partners',
      });
    } else {
      partners.forEach((entry, index) => {
        const partner = (entry || {}) as Record<string, unknown>;
        if (!stringField(partner.name).trim()) {
          issues.push({
            section: 7,
            field: `partners.${index}.name`,
            message: `Partner ${index + 1}: organization name is required`,
          });
        }
        if (!partner.type) {
          issues.push({
            section: 7,
            field: `partners.${index}.type`,
            message: `Partner ${index + 1}: partner type is required`,
          });
        }
        if (
          (partner.type === 'Others (please specify)' ||
            partner.type === '✏️ Other') &&
          !stringField(partner.type_other).trim()
        ) {
          issues.push({
            section: 7,
            field: `partners.${index}.type_other`,
            message: `Partner ${index + 1}: specify the partner type`,
          });
        }
        if (!hasChosenValue(partner.role)) {
          issues.push({
            section: 7,
            field: `partners.${index}.role`,
            message: `Partner ${index + 1}: at least one role is required`,
          });
        }
        if (!hasChosenValue(partner.contribution)) {
          issues.push({
            section: 7,
            field: `partners.${index}.contribution`,
            message: `Partner ${index + 1}: at least one contribution is required`,
          });
        }
      });
    }
  }

  const section9 = report.section9 || {};
  if (!stringField(section9.academic_integration).trim()) {
    issues.push({
      section: 9,
      field: 'academic_integration',
      message:
        'Tap an Academic integration option (Voluntary, course, credit, capstone, or research)',
    });
  }
  if (!listHasItems(section9.skills_grown)) {
    issues.push({
      section: 9,
      field: 'skills_grown',
      message: 'Tap at least one skill you grew',
    });
  } else if (
    (section9.skills_grown as unknown[]).some((skill) => isOtherSkill(skill)) &&
    !stringField(section9.skills_grown_other).trim()
  ) {
    issues.push({
      section: 9,
      field: 'skills_grown_other',
      message: 'Name the other skill you grew',
    });
  }
  if (!stringField(section9.reflection_biggest_learning).trim()) {
    issues.push({
      section: 9,
      field: 'reflection_biggest_learning',
      message: 'Say the biggest thing you learned',
    });
  }
  if (!stringField(section9.reflection_moment).trim()) {
    issues.push({
      section: 9,
      field: 'reflection_moment',
      message: 'Name a moment that changed how you see things',
    });
  }
  if (!stringField(section9.reflection_discipline_help).trim()) {
    issues.push({
      section: 9,
      field: 'reflection_discipline_help',
      message: 'Name an academic skill you actually applied',
    });
  }
  if (!stringField(section9.personal_learning).trim()) {
    issues.push({
      section: 9,
      field: 'personal_learning',
      message: 'Personal growth statement is required',
    });
  } else {
    checkWordRange(
      issues,
      9,
      'personal_learning',
      section9.personal_learning,
      'Personal growth statement',
    );
  }
  if (!stringField(section9.academic_application).trim()) {
    issues.push({
      section: 9,
      field: 'academic_application',
      message: 'Academic application explanation is required',
    });
  } else {
    checkWordRange(
      issues,
      9,
      'academic_application',
      section9.academic_application,
      'Academic application explanation',
    );
  }
  if (!competencyScoresComplete(section9.competency_scores)) {
    issues.push({
      section: 9,
      field: 'competency_scores',
      message: 'Rate all 12 competencies',
    });
  }

  const section11 = report.section11 || {};
  const finalDeclaration = Array.isArray(section11.final_declaration)
    ? section11.final_declaration
    : [];
  const finalDeclarationComplete =
    finalDeclaration.length >= 5 && finalDeclaration.slice(0, 5).every(Boolean);
  if (!finalDeclarationComplete) {
    issues.push({
      section: 11,
      field: 'final_declaration',
      message: 'All five final declaration checkboxes must be confirmed',
    });
  }
  if (!stringField(section11.signature_name).trim()) {
    issues.push({
      section: 11,
      field: 'signature_name',
      message: 'An electronic signature (your full name) is required',
    });
  }

  return issues;
}

export function validateReportSectionsForSubmit(report: {
  section1?: Record<string, unknown> | null;
  section2?: Record<string, unknown> | null;
  section3?: Record<string, unknown> | null;
  section4?: Record<string, unknown> | null;
  section5?: Record<string, unknown> | null;
  section6?: Record<string, unknown> | null;
  section7?: Record<string, unknown> | null;
  section8?: Record<string, unknown> | null;
  section9?: Record<string, unknown> | null;
  section10?: Record<string, unknown> | null;
  section11?: Record<string, unknown> | null;
  evidence_urls?: string[] | null;
}): ReportSubmitValidationIssue[] {
  const issues: ReportSubmitValidationIssue[] =
    validateCoreSectionsPresence(report);
  const section6 = report.section6 || {};
  const section8 = report.section8 || {};
  const section10 = report.section10 || {};

  const useResources = pickUseResources(section6);
  if (useResources !== 'yes' && useResources !== 'no') {
    issues.push({
      section: 6,
      field: 'use_resources',
      message: 'Tell us whether the project used extra resources',
    });
  }
  if (useResources === 'yes') {
    const resources = Array.isArray(section6.resources)
      ? section6.resources
      : [];
    if (!resources.length) {
      issues.push({
        section: 6,
        field: 'resources',
        message: 'Please list the resources used',
      });
    } else {
      resources.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const res = entry as Record<string, unknown>;
        // V19 6.2 — a resource entry is complete only with type, quantity/value, unit, source(s)
        // and verification method(s); the UI marks all five as required.
        if (!stringField(res.type).trim()) {
          issues.push({
            section: 6,
            field: `resources.${index}.type`,
            message: 'Choose the resource type',
          });
        }
        // The form stores the amount as typed (a string); older / imported rows may hold a
        // number. Both are an amount — only a blank is not.
        const amountText =
          typeof res.amount === 'number' && Number.isFinite(res.amount)
            ? String(res.amount)
            : stringField(res.amount);
        if (!amountText.trim()) {
          issues.push({
            section: 6,
            field: `resources.${index}.amount`,
            message: 'Enter the amount or quantity',
          });
        }
        if (!stringField(res.unit).trim()) {
          issues.push({
            section: 6,
            field: `resources.${index}.unit`,
            message: 'Choose the unit',
          });
        }
        if (!listHasItems(res.sources)) {
          issues.push({
            section: 6,
            field: `resources.${index}.sources`,
            message: 'Choose at least one source for this resource',
          });
        }
        if (!listHasItems(res.verification)) {
          issues.push({
            section: 6,
            field: `resources.${index}.verification`,
            message: 'Choose at least one verification method',
          });
        }
        // "What did it make possible?" is one clear line linking the resource to delivery: a
        // single word ("Paint") says nothing a reviewer can check. Mirrors the wizard rule.
        if (!stringField(res.purpose).trim()) {
          issues.push({
            section: 6,
            field: `resources.${index}.purpose`,
            message: 'Say what this resource made possible',
          });
        } else if (countWords(res.purpose) < RESOURCE_PURPOSE_MIN_WORDS) {
          issues.push({
            section: 6,
            field: `resources.${index}.purpose`,
            message: `What did it make possible? — write one clear line (at least ${RESOURCE_PURPOSE_MIN_WORDS} words)`,
          });
        }
        if (
          (res.type === 'Other (Specify)' || res.type === 'Other / Custom') &&
          !stringField(res.type_other).trim()
        ) {
          issues.push({
            section: 6,
            field: `resources.${index}.type_other`,
            message: 'Please specify the resource type',
          });
        }
        if (
          (res.unit === 'Other (Specify)' || res.unit === 'Other…') &&
          !stringField(res.unit_other).trim()
        ) {
          issues.push({
            section: 6,
            field: `resources.${index}.unit_other`,
            message: 'Please specify the unit',
          });
        }
        const sources = Array.isArray(res.sources) ? res.sources : [];
        if (
          sources.some(
            (item) =>
              item === 'Other (Specify)' || item === 'Other / Custom Source',
          ) &&
          !stringField(res.source_other).trim()
        ) {
          issues.push({
            section: 6,
            field: `resources.${index}.source_other`,
            message: 'Please specify the source',
          });
        }

        // Accountability: a contribution from outside the team names its contributor and
        // carries an evidence trail (mirrors the student form).
        const external = isExternalResourceSource(sources);
        if (!contributorEmailLooksValid(res.contributor_email)) {
          issues.push({
            section: 6,
            field: `resources.${index}.contributor_email`,
            message: 'Enter a valid email address',
          });
        }
        const phoneGiven = stringField(res.contributor_phone).trim() !== '';
        if (
          phoneGiven &&
          !contributorPhoneLooksValid(
            res.contributor_phone_code,
            res.contributor_phone,
          )
        ) {
          issues.push({
            section: 6,
            field: `resources.${index}.contributor_phone`,
            message: 'Mobile number needs a country code, e.g. +92 300 1234567',
          });
        }
        if (external) {
          if (!stringField(res.contributor_name).trim()) {
            issues.push({
              section: 6,
              field: `resources.${index}.contributor_name`,
              message: 'Name the contributor of this resource',
            });
          }
          if (!stringField(res.contributor_email).trim()) {
            issues.push({
              section: 6,
              field: `resources.${index}.contributor_email`,
              message: "Add the contributor's email",
            });
          }
          if (!phoneGiven) {
            issues.push({
              section: 6,
              field: `resources.${index}.contributor_phone`,
              message: "Add the contributor's mobile number with country code",
            });
          }
          if (!stringField(res.evidence_trail).trim()) {
            issues.push({
              section: 6,
              field: `resources.${index}.evidence_trail`,
              message:
                'Describe the evidence trail: where it came from, how it was used, who received it',
            });
          }
        }
      });
    }
  }

  const hasEvidence = stringField(section8.has_evidence).trim().toLowerCase();
  if (hasEvidence !== 'yes' && hasEvidence !== 'no') {
    issues.push({
      section: 8,
      field: 'has_evidence',
      message: 'Tell us whether you have more evidence to add',
    });
  }

  if (hasEvidence === 'yes') {
    const evidenceFiles = Array.isArray(section8.evidence_files)
      ? section8.evidence_files
      : [];
    const evidenceUrls = Array.isArray(report.evidence_urls)
      ? report.evidence_urls
      : [];
    if (!evidenceFiles.length && !evidenceUrls.length) {
      issues.push({
        section: 8,
        field: 'evidence_files',
        message: 'Add at least one evidence file',
      });
    }
    const evidenceTypes = Array.isArray(section8.evidence_types)
      ? section8.evidence_types
      : [];
    if (!evidenceTypes.length) {
      issues.push({
        section: 8,
        field: 'evidence_types',
        message: 'Choose at least one evidence type',
      });
    }
    if (
      evidenceTypes.some((type) =>
        /other supporting document/i.test(stringField(type)),
      ) &&
      !stringField(section8.evidence_type_other).trim()
    ) {
      issues.push({
        section: 8,
        field: 'evidence_type_other',
        message: 'Say what kind of document this is',
      });
    }
    // The caption is optional (V19 8.2 "What does my/our evidence show? (Optional)"); only a
    // caption that is given has to respect the 10–45 word meter — same as the wizard.
    if (stringField(section8.description).trim()) {
      checkWordRange(
        issues,
        8,
        'description',
        section8.description,
        'What does your evidence show?',
        'evidence_caption',
      );
    }
  }
  // V19 8.2 — the consolidated authenticity / consent / privacy confirmation is mandatory for
  // every report, whether or not extra evidence was added (the wizard stores it as four flags).
  if (!evidenceEthicsConfirmed(section8.ethical_compliance)) {
    issues.push({
      section: 8,
      field: 'ethical_compliance',
      message:
        'Confirm that the evidence is authentic, relates to this project, and that consent and privacy details are reported accurately',
    });
  }

  if (
    resolveMediaVisibility(section8.media_visible ?? section8.media_usage) ===
      'public' &&
    !hasPublicSharePermission(section8)
  ) {
    issues.push({
      section: 8,
      field: 'public_share_permission',
      message: 'I have permission to publicly share this evidence.',
    });
  }

  const continuationStatus = stringField(
    section10.continuation_status ?? section10.sustainability_status,
  )
    .trim()
    .toLowerCase();

  if (!continuationStatus) {
    issues.push({
      section: 10,
      field: 'continuation_status',
      message:
        'Choose whether the impact will continue after you (Yes / Partial / No)',
    });
  }

  const continuationDetails = stringField(
    section10.continuation_details ?? section10.sustainability_plan,
  );
  if (!continuationDetails.trim()) {
    issues.push({
      section: 10,
      field: 'continuation_details',
      message: 'What continues, what stops? is required',
    });
  } else {
    checkWordRange(
      issues,
      10,
      'continuation_details',
      continuationDetails,
      'What continues, what stops?',
    );
  }
  const mechanisms = Array.isArray(section10.mechanisms)
    ? section10.mechanisms
    : [];
  if (!mechanisms.length) {
    issues.push({
      section: 10,
      field: 'mechanisms',
      message: 'Tap at least one option under What keeps it alive?',
    });
  } else if (
    mechanisms.some((entry) => isOtherMechanism(entry)) &&
    !stringField(section10.mechanism_other).trim()
  ) {
    issues.push({
      section: 10,
      field: 'mechanism_other',
      message: 'Say what else keeps it going',
    });
  }
  if (!stringField(section10.scaling_potential).trim()) {
    issues.push({
      section: 10,
      field: 'scaling_potential',
      message: 'Select a Scaling potential option',
    });
  }
  if (!stringField(section10.policy_influence).trim()) {
    issues.push({
      section: 10,
      field: 'policy_influence',
      message: 'Select whether this project influenced a long-term system',
    });
  }
  issues.push(...validateFollowUp(section10));

  return issues;
}

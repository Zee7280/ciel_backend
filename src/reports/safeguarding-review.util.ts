/**
 * V19 item 13 — reviewer attention notes for the report's Section 2.3 (risk, safeguarding &
 * consent). Mirror of ciel_frontend/src/app/dashboard/student/report/utils/riskSafeguarding.ts
 * `safeguardingReviewNotes`; used to brief the CIEL PK AI evaluator and any server-side review
 * surface. Pure and tolerant of older reports (a blank block yields one "not completed" note).
 */
export type SafeguardingReviewNote = {
  level: 'attention' | 'info';
  code:
    | 'block_blank'
    | 'fields_missing'
    | 'consent_not_obtained_sensitive'
    | 'consent_not_applicable_sensitive'
    | 'consent_missing_sensitive'
    | 'none_but_details'
    | 'unresolved_risks'
    | 'consent_student_reported';
  message: string;
};

const RISK_NONE_ID = 'none';
const SENSITIVE_RISK_IDS = new Set([
  'children_present',
  'beneficiary_photos',
  'personal_data',
  'health_contact',
]);
const RISK_LABELS: Record<string, string> = {
  children_present: 'children present',
  physical_work: 'physical work / tools / heights',
  beneficiary_photos: 'photos of beneficiaries',
  personal_data: 'personal data collected',
  health_contact: 'health or medical contact',
  travel_to_site: 'travel to site',
  handling_money: 'handling money',
  [RISK_NONE_ID]: 'none identified',
};
const CONSENT_LABELS: Record<string, string> = {
  written: 'Written consent obtained',
  verbal: 'Verbal consent obtained',
  not_obtained: 'Not obtained',
  not_applicable: 'Not applicable',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function riskIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
}

export function safeguardingReviewNotes(
  block: Record<string, unknown> | null | undefined,
): SafeguardingReviewNote[] {
  const notes: SafeguardingReviewNote[] = [];
  const b = block && typeof block === 'object' ? block : {};
  const ids = riskIds(b.risk_factors);
  const mitigation = text(b.risk_mitigation);
  const consent = text(b.risk_consent);
  const lead = text(b.risk_safeguarding_lead);
  const unresolved = text(b.risk_unresolved);
  const hasContent =
    ids.length > 0 || Boolean(mitigation || consent || lead || unresolved);
  if (!hasContent) {
    notes.push({
      level: 'attention',
      code: 'block_blank',
      message:
        'Risk, safeguarding & consent (2.3) was not completed by the student — a blank block is not evidence of "no risk".',
    });
    return notes;
  }
  const real = ids.filter((id) => id !== RISK_NONE_ID);
  const sensitive = real.filter((id) => SENSITIVE_RISK_IDS.has(id));
  const sensitiveLabels = sensitive
    .map((id) => RISK_LABELS[id] || id)
    .join(', ');

  if (real.length) {
    const missing: string[] = [];
    if (!mitigation)
      missing.push('say what you did to manage the risks you selected');
    if (!consent) missing.push('choose the consent status for photos and data');
    if (!lead)
      missing.push('name the person responsible for safeguarding on site');
    if (missing.length) {
      notes.push({
        level: 'attention',
        code: 'fields_missing',
        message: `Risks were selected but the block is incomplete: ${missing.join('; ')}.`,
      });
    }
  }
  if (sensitive.length && consent === 'not_obtained') {
    notes.push({
      level: 'attention',
      code: 'consent_not_obtained_sensitive',
      message: `Consent reported as not obtained although the work involved ${sensitiveLabels}. Check how photos / data were handled before accepting.`,
    });
  } else if (sensitive.length && consent === 'not_applicable') {
    notes.push({
      level: 'attention',
      code: 'consent_not_applicable_sensitive',
      message: `Consent marked "not applicable" but the student also reported ${sensitiveLabels} — these answers conflict.`,
    });
  } else if (sensitive.length && !consent) {
    notes.push({
      level: 'attention',
      code: 'consent_missing_sensitive',
      message: `No consent status recorded although the work involved ${sensitiveLabels}.`,
    });
  }
  if (ids.includes(RISK_NONE_ID) && (mitigation || unresolved)) {
    notes.push({
      level: 'attention',
      code: 'none_but_details',
      message:
        '"None identified" is selected, yet mitigation or unresolved-risk text was entered — ask which answer is right.',
    });
  }
  if (unresolved) {
    notes.push({
      level: 'attention',
      code: 'unresolved_risks',
      message: `Unresolved risks reported by the student: ${
        unresolved.length > 180
          ? `${unresolved.slice(0, 180).trim()}…`
          : unresolved
      }`,
    });
  }
  if (consent === 'written' || consent === 'verbal') {
    notes.push({
      level: 'info',
      code: 'consent_student_reported',
      message: `${CONSENT_LABELS[consent]} is the student's own declaration (student-reported, not independently verified); no consent form has been checked by the platform.`,
    });
  }
  return notes;
}

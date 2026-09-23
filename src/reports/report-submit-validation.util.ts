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

function isOtherChoice(value: unknown): boolean {
  const text = stringField(value).trim();
  if (!text) return false;
  if (/^other$/i.test(text)) return true;
  return /other\s*\/\s*custom/i.test(text);
}

function isOtherMechanism(value: unknown): boolean {
  const text = stringField(value).replace(/^✏️\s*/, '').trim();
  return /^other$/i.test(text);
}

/** Mirrors frontend validateSection4: a titled quantity, a legacy output string, or beneficiary reach. */
function activityHasOutputOrReach(block: Record<string, unknown>): boolean {
  const outputs = Array.isArray(block.outputs) ? block.outputs : [];
  const hasOutput = outputs.some((entry) => {
    if (typeof entry === 'string') return entry.trim().length > 0;
    const out = (entry || {}) as Record<string, unknown>;
    return stringField(out.title).trim().length > 0 && String(out.quantity ?? '').trim().length > 0;
  });
  const gross = String(block.beneficiaries_reached ?? '').trim();
  const unique = String(block.unique_beneficiaries ?? block.beneficiaries_reached ?? '').trim();
  return hasOutput || (gross.length > 0 && unique.length > 0);
}

/**
 * Presence-only safety net for sections 1, 2, 4, 5, 7, 9 and 11 — mirrors which fields the
 * frontend wizard (report/utils/validation.ts, context/ReportContext.tsx) treats as *required to
 * have a value*, without duplicating its word-count/phrasing rules (those stay owned by the
 * frontend). This exists so a submission made by calling the API directly (bypassing the
 * wizard's canSubmitReport gate) can't produce a report that is essentially empty in these
 * sections, or that skips the final declaration and electronic sign-off.
 */
function hasChosenValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return stringField(value).trim().length > 0 || (typeof value === 'number' && Number.isFinite(value));
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
  const reviewChecked = Array.isArray(section1.review_checked) ? section1.review_checked : [];
  // The 3-item declaration (mirrors report/utils/validation.ts validateSection1) replaced the old
  // mid-flow attendance-verification request — all three boxes must be ticked, not just consent.
  const declarationComplete = reviewChecked.length >= 3 && reviewChecked.slice(0, 3).every(Boolean);
  const hasPrivacyConsent = Boolean(section1.privacy_consent || declarationComplete);
  if (!hasPrivacyConsent) {
    issues.push({
      section: 1,
      field: 'privacy_consent',
      message: 'Privacy consent is required',
    });
  } else if (reviewChecked.length > 0 && !declarationComplete) {
    issues.push({
      section: 1,
      field: 'review_checked',
      message: 'All three declaration checkboxes must be confirmed',
    });
  }
  const section2 = report.section2 || {};
  if (!stringField(section2.problem_statement).trim()) {
    issues.push({ section: 2, field: 'problem_statement', message: 'Problem statement is required' });
  }
  if (!section2.discipline) {
    issues.push({ section: 2, field: 'discipline', message: 'Academic discipline is required' });
  } else if (section2.discipline === 'Other…' && !stringField(section2.discipline_other).trim()) {
    issues.push({ section: 2, field: 'discipline_other', message: 'Please name your discipline' });
  }

  const section3 = report.section3 || {};
  if (!stringField(section3.contribution_intent_statement).trim()) {
    issues.push({ section: 3, field: 'contribution_intent_statement', message: 'Contribution logic is required' });
  }
  if (!Array.isArray(section2.baseline_evidence) || !section2.baseline_evidence.length) {
    issues.push({ section: 2, field: 'baseline_evidence', message: 'At least one baseline evidence type is required' });
  }

  const section4 = report.section4 || {};
  const activityBlocks = Array.isArray(section4.activity_blocks) ? section4.activity_blocks : [];
  if (!activityBlocks.length) {
    issues.push({ section: 4, field: 'activity_blocks', message: 'At least one activity block is required' });
  } else {
    activityBlocks.forEach((entry, index) => {
      const block = (entry || {}) as Record<string, unknown>;
      if (!stringField(block.title).trim()) {
        issues.push({ section: 4, field: `activity_blocks.${index}.title`, message: `Activity ${index + 1}: title is required` });
      }
      if (!block.primary_category) {
        issues.push({ section: 4, field: `activity_blocks.${index}.primary_category`, message: `Activity ${index + 1}: activity family is required` });
      }
      if (isOtherChoice(block.primary_category) && !stringField(block.other_category_text).trim()) {
        issues.push({ section: 4, field: `activity_blocks.${index}.other_category_text`, message: `Activity ${index + 1}: custom activity family is required` });
      }
      if (block.primary_category && !isOtherChoice(block.primary_category) && !block.sub_category) {
        issues.push({ section: 4, field: `activity_blocks.${index}.sub_category`, message: `Activity ${index + 1}: sub-category is required` });
      }
      if (isOtherChoice(block.sub_category) && !stringField(block.other_sub_category_text).trim()) {
        issues.push({ section: 4, field: `activity_blocks.${index}.other_sub_category_text`, message: `Activity ${index + 1}: custom sub-category is required` });
      }
      if (!block.status) {
        issues.push({ section: 4, field: `activity_blocks.${index}.status`, message: `Activity ${index + 1}: status is required` });
      }
      if (!stringField(block.description).trim()) {
        issues.push({ section: 4, field: `activity_blocks.${index}.description`, message: `Activity ${index + 1}: what was done is required` });
      }
      if (!activityHasOutputOrReach(block)) {
        issues.push({ section: 4, field: `activity_blocks.${index}.outputs`, message: `Activity ${index + 1}: add a countable output or a beneficiary reach` });
      }
    });
  }

  const section5 = report.section5 || {};
  if (!stringField(section5.observed_change).trim()) {
    issues.push({ section: 5, field: 'observed_change', message: 'Observed change narrative is required' });
  }
  const outcomes = Array.isArray(section5.measurable_outcomes) ? section5.measurable_outcomes : [];
  if (!outcomes.length) {
    issues.push({ section: 5, field: 'measurable_outcomes', message: 'At least one measurable outcome is required' });
  } else {
    outcomes.forEach((entry, index) => {
      const outcome = (entry || {}) as Record<string, unknown>;
      if (!outcome.outcome_area) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.outcome_area`, message: 'Outcome category is required' });
      }
      if (outcome.outcome_area && outcome.outcome_area !== 'Other' && !outcome.outcome_sub_category) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.outcome_sub_category`, message: 'Outcome sub-category is required' });
      }
      if (!outcome.metric_category) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.metric_category`, message: 'Metric category is required' });
      }
      if (!outcome.metric) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.metric`, message: 'Primary metric unit is required' });
      }
      if (outcome.baseline === '' || outcome.baseline === undefined || outcome.baseline === null) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.baseline`, message: 'Baseline value is required' });
      }
      if (outcome.endline === '' || outcome.endline === undefined || outcome.endline === null) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.endline`, message: 'Endline value is required' });
      }
      if (!outcome.unit) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.unit`, message: 'Unit of measurement is required' });
      }
      if (!hasChosenValue(outcome.confidence_level)) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.confidence_level`, message: 'At least one confidence level is required' });
      }
      if (!stringField(outcome.measurement_explanation).trim()) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.measurement_explanation`, message: 'Measurement explanation is required' });
      }
    });
  }
  if (!stringField(section5.challenges).trim()) {
    issues.push({ section: 5, field: 'challenges', message: 'Challenges description is required' });
  }

  const section7 = report.section7 || {};
  if (!section7.has_partners) {
    issues.push({ section: 7, field: 'has_partners', message: 'Please confirm whether this project had active partners' });
  } else if (section7.has_partners === 'yes') {
    const partners = Array.isArray(section7.partners) ? section7.partners : [];
    if (!partners.length) {
      issues.push({ section: 7, field: 'partners', message: 'Please list your external partners' });
    } else {
      partners.forEach((entry, index) => {
        const partner = (entry || {}) as Record<string, unknown>;
        if (!stringField(partner.name).trim()) {
          issues.push({ section: 7, field: `partners.${index}.name`, message: `Partner ${index + 1}: organization name is required` });
        }
        if (!partner.type) {
          issues.push({ section: 7, field: `partners.${index}.type`, message: `Partner ${index + 1}: partner type is required` });
        }
        if ((partner.type === 'Others (please specify)' || partner.type === '✏️ Other') && !stringField(partner.type_other).trim()) {
          issues.push({ section: 7, field: `partners.${index}.type_other`, message: `Partner ${index + 1}: specify the partner type` });
        }
        if (!hasChosenValue(partner.role)) {
          issues.push({ section: 7, field: `partners.${index}.role`, message: `Partner ${index + 1}: at least one role is required` });
        }
        if (!hasChosenValue(partner.contribution)) {
          issues.push({ section: 7, field: `partners.${index}.contribution`, message: `Partner ${index + 1}: at least one contribution is required` });
        }
      });
    }
  }

  const section9 = report.section9 || {};
  if (!section9.academic_integration) {
    issues.push({ section: 9, field: 'academic_integration', message: 'Please select an academic integration level' });
  }
  if (!stringField(section9.personal_learning).trim()) {
    issues.push({ section: 9, field: 'personal_learning', message: 'Personal growth statement is required' });
  }
  if (!stringField(section9.academic_application).trim()) {
    issues.push({ section: 9, field: 'academic_application', message: 'Academic application explanation is required' });
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
  const issues: ReportSubmitValidationIssue[] = validateCoreSectionsPresence(report);
  const section6 = report.section6 || {};
  const section8 = report.section8 || {};
  const section10 = report.section10 || {};

  const useResources = pickUseResources(section6);
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
        if (!stringField(res.purpose).trim()) {
          issues.push({
            section: 6,
            field: `resources.${index}.purpose`,
            message: 'Say what this resource made possible',
          });
        }
        if ((res.type === 'Other (Specify)' || res.type === 'Other / Custom') && !stringField(res.type_other).trim()) {
          issues.push({ section: 6, field: `resources.${index}.type_other`, message: 'Please specify the resource type' });
        }
        if ((res.unit === 'Other (Specify)' || res.unit === 'Other…') && !stringField(res.unit_other).trim()) {
          issues.push({ section: 6, field: `resources.${index}.unit_other`, message: 'Please specify the unit' });
        }
        const sources = Array.isArray(res.sources) ? res.sources : [];
        if (sources.some((item) => item === 'Other (Specify)' || item === 'Other / Custom Source') && !stringField(res.source_other).trim()) {
          issues.push({ section: 6, field: `resources.${index}.source_other`, message: 'Please specify the source' });
        }
      });
    }
  }

  const hasEvidence =
    stringField(section8.has_evidence).trim().toLowerCase() === 'yes';
  if (hasEvidence) {
    const evidenceFiles = Array.isArray(section8.evidence_files)
      ? section8.evidence_files
      : [];
    if (!evidenceFiles.length) {
      issues.push({
        section: 8,
        field: 'evidence_files',
        message: 'At least one evidence file is mandatory',
      });
    }
    const evidenceTypes = Array.isArray(section8.evidence_types)
      ? section8.evidence_types
      : [];
    if (!evidenceTypes.length) {
      issues.push({
        section: 8,
        field: 'evidence_types',
        message: 'At least one evidence type is mandatory',
      });
    }
    if (!stringField(section8.description).trim()) {
      issues.push({
        section: 8,
        field: 'description',
        message: 'Say what your evidence shows',
      });
    }
    const mediaVisible = section8.media_visible ?? section8.media_usage;
    if (!mediaVisible) {
      issues.push({
        section: 8,
        field: 'media_visible',
        message: 'Media visibility preference is required',
      });
    }
    const ethics =
      section8.ethical_compliance &&
      typeof section8.ethical_compliance === 'object'
        ? (section8.ethical_compliance as Record<string, unknown>)
        : {};
    const authentic =
      ethics.authentic === true || section8.consent_authentic === true;
    const informed =
      ethics.informed_consent === true || section8.consent_informed === true;
    const noHarm = ethics.no_harm === true || section8.consent_no_harm === true;
    const privacy = ethics.privacy_respected === true;
    if (!authentic || !informed || !noHarm || !privacy) {
      issues.push({
        section: 8,
        field: 'ethical_compliance',
        message: 'All ethical compliance checks must be accepted',
      });
    }
    if (
      hasEvidence &&
      (!report.evidence_urls || !report.evidence_urls.length) &&
      !evidenceFiles.length
    ) {
      issues.push({
        section: 8,
        field: 'evidence_urls',
        message: 'Section 8 claims evidence but no files are attached',
      });
    }
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
      message: 'Sustainability continuation status is required',
    });
    return issues;
  }

  const continuationDetails = stringField(
    section10.continuation_details ?? section10.sustainability_plan,
  );
  if (!continuationDetails.trim()) {
    issues.push({
      section: 10,
      field: 'continuation_details',
      message: 'Say what will keep going, or what will happen next',
    });
  }
  const mechanisms = Array.isArray(section10.mechanisms)
    ? section10.mechanisms
    : [];
  // The live report form can submit "no" with no mechanisms, and can omit scaling
  // and policy influence. The new form still requires those before it calls submit.
  if (continuationStatus !== 'no' && !mechanisms.length) {
    issues.push({
      section: 10,
      field: 'mechanisms',
      message: 'Identify at least one sustainability mechanism',
    });
  } else if (mechanisms.some((entry) => isOtherMechanism(entry)) && !stringField(section10.mechanism_other).trim()) {
    issues.push({
      section: 10,
      field: 'mechanism_other',
      message: 'Say what else keeps it going',
    });
  }

  return issues;
}

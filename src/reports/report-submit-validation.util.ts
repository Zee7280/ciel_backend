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

/**
 * Presence-only safety net for sections 1, 2, 4, 5, 7 and 9 — mirrors which fields the frontend
 * wizard (report/utils/validation.ts) treats as *required to have a value*, without duplicating
 * its word-count/phrasing rules (those stay owned by the frontend). This exists so a submission
 * made by calling the API directly (bypassing the wizard's canSubmitReport gate) can't produce a
 * report that is essentially empty in these sections.
 */
function validateCoreSectionsPresence(report: {
  section1?: Record<string, unknown> | null;
  section2?: Record<string, unknown> | null;
  section4?: Record<string, unknown> | null;
  section5?: Record<string, unknown> | null;
  section7?: Record<string, unknown> | null;
  section9?: Record<string, unknown> | null;
}): ReportSubmitValidationIssue[] {
  const issues: ReportSubmitValidationIssue[] = [];

  const section1 = report.section1 || {};
  const hasPrivacyConsent = Boolean(
    section1.privacy_consent ||
      (Array.isArray(section1.review_checked) && section1.review_checked[2]),
  );
  if (!hasPrivacyConsent) {
    issues.push({
      section: 1,
      field: 'privacy_consent',
      message: 'Privacy consent is required',
    });
  }
  if ((section1.metrics as Record<string, unknown> | undefined)?.hec_compliance === 'below') {
    issues.push({
      section: 1,
      field: 'metrics.hec_compliance',
      message: 'Required engagement hours must be met to submit this report',
    });
  }

  const section2 = report.section2 || {};
  if (!stringField(section2.problem_statement).trim()) {
    issues.push({ section: 2, field: 'problem_statement', message: 'Problem statement is required' });
  }
  if (!section2.discipline) {
    issues.push({ section: 2, field: 'discipline', message: 'Academic discipline is required' });
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
        issues.push({ section: 4, field: `activity_blocks.${index}.primary_category`, message: `Activity ${index + 1}: primary category is required` });
      }
      if (!block.delivery_mode) {
        issues.push({ section: 4, field: `activity_blocks.${index}.delivery_mode`, message: `Activity ${index + 1}: delivery mode is required` });
      }
      if (!Array.isArray(block.outputs) || !block.outputs.length) {
        issues.push({ section: 4, field: `activity_blocks.${index}.outputs`, message: `Activity ${index + 1}: at least one output is required` });
      }
    });
  }
  const projectSummary = (section4.project_summary as Record<string, unknown> | undefined) || {};
  if (!projectSummary.distinct_total_beneficiaries) {
    issues.push({ section: 4, field: 'project_summary.distinct_total_beneficiaries', message: 'Distinct total beneficiaries is required' });
  }
  if (!projectSummary.counting_method) {
    issues.push({ section: 4, field: 'project_summary.counting_method', message: 'Beneficiary counting method is required' });
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
      if (!outcome.metric) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.metric`, message: 'Primary metric unit is required' });
      }
      if (outcome.baseline === '' || outcome.baseline === undefined || outcome.baseline === null) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.baseline`, message: 'Baseline value is required' });
      }
      if (outcome.endline === '' || outcome.endline === undefined || outcome.endline === null) {
        issues.push({ section: 5, field: `measurable_outcomes.${index}.endline`, message: 'Endline value is required' });
      }
    });
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
      });
    }
  }

  const section9 = report.section9 || {};
  if (!section9.academic_integration) {
    issues.push({ section: 9, field: 'academic_integration', message: 'Please select an academic integration level' });
  }

  return issues;
}

export function validateReportSectionsForSubmit(report: {
  section1?: Record<string, unknown> | null;
  section2?: Record<string, unknown> | null;
  section4?: Record<string, unknown> | null;
  section5?: Record<string, unknown> | null;
  section6?: Record<string, unknown> | null;
  section7?: Record<string, unknown> | null;
  section8?: Record<string, unknown> | null;
  section9?: Record<string, unknown> | null;
  section10?: Record<string, unknown> | null;
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
  if (continuationStatus !== 'no' && !mechanisms.length) {
    issues.push({
      section: 10,
      field: 'mechanisms',
      message: 'Identify at least one sustainability mechanism',
    });
  }

  return issues;
}

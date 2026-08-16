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

export function validateReportSectionsForSubmit(report: {
  section6?: Record<string, unknown> | null;
  section8?: Record<string, unknown> | null;
  section10?: Record<string, unknown> | null;
  evidence_urls?: string[] | null;
}): ReportSubmitValidationIssue[] {
  const issues: ReportSubmitValidationIssue[] = [];
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

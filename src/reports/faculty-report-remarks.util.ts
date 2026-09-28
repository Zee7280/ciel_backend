/** Additive Faculty revision notes. Existing callers that only send `remarks` stay unchanged. */
export function composeFacultyReportRemarks(input: {
  remarks?: string | null;
  revision_section?: string | null;
  required_correction?: string | null;
}): string {
  const reason = String(input.remarks || '').trim();
  const section = String(input.revision_section || '').trim();
  const required = String(input.required_correction || '').trim();
  if (!section && !required) return reason;
  return [
    section ? `Section(s): ${section}` : '',
    reason ? `Reason: ${reason}` : '',
    required ? `Required Correction: ${required}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

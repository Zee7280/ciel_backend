import { validateReportSectionsForSubmit } from './report-submit-validation.util';

describe('validateReportSectionsForSubmit', () => {
  it('requires resources when use_resources is yes', () => {
    const issues = validateReportSectionsForSubmit({
      section6: { use_resources: 'yes', resources: [] },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'no',
        continuation_details: 'word '.repeat(100).trim(),
      },
    });
    expect(issues.some((i) => i.section === 6 && i.field === 'resources')).toBe(
      true,
    );
  });

  it('skips section8 validation when has_evidence is not yes', () => {
    const issues = validateReportSectionsForSubmit({
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'yes',
        continuation_details: 'word '.repeat(100).trim(),
        mechanisms: ['community ownership'],
      },
    });
    expect(issues.some((i) => i.section === 8)).toBe(false);
  });

  it('validates section10 continuation details word count', () => {
    const issues = validateReportSectionsForSubmit({
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'yes',
        continuation_details: 'too short',
      },
    });
    expect(issues.some((i) => i.section === 10)).toBe(true);
  });

  it('requires continuation_status before other section10 checks', () => {
    const issues = validateReportSectionsForSubmit({
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {},
    });
    expect(issues).toEqual([
      expect.objectContaining({ section: 10, field: 'continuation_status' }),
    ]);
  });
});

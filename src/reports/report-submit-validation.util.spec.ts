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

  it('rejects an empty or whitespace-only section10 continuation_details', () => {
    const issues = validateReportSectionsForSubmit({
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'yes',
        continuation_details: '   ',
        mechanisms: ['community ownership'],
      },
    });
    expect(
      issues.some(
        (i) => i.section === 10 && i.field === 'continuation_details',
      ),
    ).toBe(true);
  });

  it('accepts a short (no minimum word count) section10 continuation_details', () => {
    const issues = validateReportSectionsForSubmit({
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'yes',
        continuation_details: 'too short',
        mechanisms: ['community ownership'],
      },
    });
    expect(
      issues.some(
        (i) => i.section === 10 && i.field === 'continuation_details',
      ),
    ).toBe(false);
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

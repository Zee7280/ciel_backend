import { validateReportSectionsForSubmit } from './report-submit-validation.util';

/** Minimal core-section payload that satisfies validateCoreSectionsPresence (sections 1,2,4,5,7,9). */
const VALID_CORE_SECTIONS = {
  section1: { privacy_consent: true },
  section2: {
    problem_statement: 'Community lacks access to clean drinking water.',
    discipline: 'Environmental Engineering',
    baseline_evidence: ['Survey'],
  },
  section4: {
    activity_blocks: [
      {
        title: 'Water filter installation',
        primary_category: 'Infrastructure',
        delivery_mode: 'In person',
        outputs: ['5 filters installed'],
      },
    ],
    project_summary: { distinct_total_beneficiaries: 50, counting_method: 'Headcount' },
  },
  section5: {
    observed_change: 'Households report improved water quality.',
    measurable_outcomes: [
      { outcome_area: 'Health', metric: 'Households served', baseline: 0, endline: 50 },
    ],
  },
  section7: { has_partners: 'no' },
  section9: { academic_integration: 'Directly related to coursework' },
};

describe('validateReportSectionsForSubmit', () => {
  it('requires resources when use_resources is yes', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
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
      ...VALID_CORE_SECTIONS,
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
      ...VALID_CORE_SECTIONS,
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
      ...VALID_CORE_SECTIONS,
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
      ...VALID_CORE_SECTIONS,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {},
    });
    expect(issues).toEqual([
      expect.objectContaining({ section: 10, field: 'continuation_status' }),
    ]);
  });

  it('accepts a fully valid report with no issues', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'no',
        continuation_details: 'Funding is exhausted; no further sessions planned.',
      },
    });
    expect(issues).toEqual([]);
  });

  it('rejects a near-empty report with presence issues across sections 1, 2, 4, 5, 7 and 9', () => {
    const issues = validateReportSectionsForSubmit({
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'no',
        continuation_details: 'Funding is exhausted; no further sessions planned.',
      },
    });
    const sections = new Set(issues.map((i) => i.section));
    expect(sections.has(1)).toBe(true);
    expect(sections.has(2)).toBe(true);
    expect(sections.has(4)).toBe(true);
    expect(sections.has(5)).toBe(true);
    expect(sections.has(7)).toBe(true);
    expect(sections.has(9)).toBe(true);
  });

  it('requires each listed partner to have a name and type when has_partners is yes', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section7: { has_partners: 'yes', partners: [{}] },
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: { continuation_status: 'no', continuation_details: 'Wraps up with the semester.' },
    });
    expect(issues.some((i) => i.section === 7 && i.field === 'partners.0.name')).toBe(true);
    expect(issues.some((i) => i.section === 7 && i.field === 'partners.0.type')).toBe(true);
  });
});

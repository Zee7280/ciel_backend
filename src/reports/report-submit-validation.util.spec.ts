import { validateReportSectionsForSubmit } from './report-submit-validation.util';

/** Minimal core-section payload that satisfies validateCoreSectionsPresence (sections 1,2,4,5,7,9). */
const VALID_CORE_SECTIONS = {
  section1: { privacy_consent: true },
  section2: {
    problem_statement: 'Community lacks access to clean drinking water.',
    discipline: 'Environmental Engineering',
    baseline_evidence: ['Survey'],
  },
  section3: {
    contribution_intent_statement: 'Students will support safer water handling in the host community.',
  },
  section4: {
    activity_blocks: [
      {
        title: 'Water filter installation',
        primary_category: 'Infrastructure',
        sub_category: 'Water / Sanitation Infrastructure',
        status: 'Completed',
        description: 'Installed filters and showed households how to use them.',
        outputs: [{ title: 'Filters installed', quantity: '5' }],
      },
    ],
    project_summary: { distinct_total_beneficiaries: 50, counting_method: 'Headcount' },
  },
  section5: {
    observed_change: 'Households report improved water quality.',
    challenges: 'Parts were hard to find in the first week.',
    measurable_outcomes: [
      {
        outcome_area: 'Health',
        outcome_sub_category: 'Water quality',
        metric_category: 'Health outcome',
        metric: 'Households served',
        baseline: 0,
        endline: 50,
        unit: 'households',
        confidence_level: ['Directly Measured'],
        measurement_explanation: 'Counted from the partner register.',
      },
    ],
  },
  section7: { has_partners: 'no' },
  section9: {
    academic_integration: 'Directly related to coursework',
    personal_learning: 'I learned how to document community work.',
    academic_application: 'The project used fieldwork methods from my course.',
  },
  section11: {
    final_declaration: [true, true, true, true, true],
    signature_name: 'Jane Student',
  },
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

  it('accepts a live-form sustainability answer that says no and leaves scaling blank', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'no',
        continuation_details: 'Funding is exhausted; no further sessions planned.',
      },
    });
    expect(issues.filter((i) => i.section === 10)).toEqual([]);
  });

  it('accepts a fully valid report with no issues', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: {
        continuation_status: 'no',
        continuation_details: 'Funding is exhausted; no further sessions planned.',
        mechanisms: ['No continuation mechanism'],
        scaling_potential: 'Not scalable',
        policy_influence: 'No',
      },
    });
    expect(issues).toEqual([]);
  });

  it('accepts an activity with reach and no delivery mode or project summary', () => {
    const section4 = {
      activity_blocks: [
        {
          title: 'Hygiene session',
          primary_category: '🩺 Health & Clinical Outreach',
          sub_category: 'Health Education',
          status: 'Ongoing',
          description: 'Ran a hygiene session with the host clinic.',
          beneficiaries_reached: '180',
          unique_beneficiaries: '120',
        },
      ],
    };
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: { continuation_status: 'no', continuation_details: 'Done.' },
    });
    expect(issues.filter((i) => i.section === 4)).toEqual([]);
  });

  it('rejects an activity that has neither a countable output nor reach', () => {
    const section4 = {
      activity_blocks: [
        {
          title: 'Hygiene session',
          primary_category: '🩺 Health & Clinical Outreach',
          sub_category: 'Health Education',
          status: 'Ongoing',
          description: 'Ran a hygiene session with the host clinic.',
          outputs: [],
        },
      ],
    };
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: { continuation_status: 'no', continuation_details: 'Done.' },
    });
    expect(issues.some((i) => i.section === 4 && i.field === 'activity_blocks.0.outputs')).toBe(true);
  });

  it('keeps a named subcategory that contains the word Other', () => {
    const section4 = {
      activity_blocks: [
        {
          title: 'Kit distribution',
          primary_category: 'Resource Distribution',
          sub_category: 'Other Essential Resource Support',
          status: 'Completed',
          description: 'Distributed hygiene kits at the school gate.',
          outputs: [{ title: 'Hygiene kits', quantity: '40' }],
        },
      ],
    };
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: { continuation_status: 'no', continuation_details: 'Done.' },
    });
    expect(issues.filter((i) => i.section === 4)).toEqual([]);
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
    expect(sections.has(3)).toBe(true);
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

  it('rejects submission when the final declaration is missing or incomplete', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: { continuation_status: 'no', continuation_details: 'Wraps up with the semester.' },
      section11: { final_declaration: [true, true, false, true, true], signature_name: 'Jane Student' },
    });
    expect(issues.some((i) => i.section === 11 && i.field === 'final_declaration')).toBe(true);
  });

  it('rejects submission when the electronic signature is missing', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: { continuation_status: 'no', continuation_details: 'Wraps up with the semester.' },
      section11: { final_declaration: [true, true, true, true, true], signature_name: '  ' },
    });
    expect(issues.some((i) => i.section === 11 && i.field === 'signature_name')).toBe(true);
  });

  it('requires all three Section 1 declaration checkboxes, not just consent', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section1: { review_checked: [true, false, true] },
      section6: { use_resources: 'no' },
      section8: { has_evidence: 'no' },
      section10: { continuation_status: 'no', continuation_details: 'Wraps up with the semester.' },
    });
    expect(issues.some((i) => i.section === 1)).toBe(true);
  });
});

import { validateReportSectionsForSubmit } from './report-submit-validation.util';

/** Live wizard tabs 7–9 (data sections 8–10) presence payload. */
const WIZARD_ETHICS = {
  authentic: true,
  informed_consent: true,
  no_harm: true,
  privacy_respected: true,
};

const WIZARD_COMPETENCY_SCORES = {
  cognitive_systemic: 3,
  cognitive_critical: 3,
  cognitive_evaluate: 3,
  practical_design: 3,
  practical_evidence: 3,
  practical_engagement: 3,
  social_empathy: 3,
  social_diversity: 3,
  social_collaboration: 3,
  transformative_longterm: 3,
  transformative_benefits: 3,
  transformative_sustainability: 3,
};

/** Payload that matches a complete live-form submit (presence only; no word-count). */
const VALID_CORE_SECTIONS = {
  section1: { privacy_consent: true, review_checked: [true, true, true] },
  section2: {
    problem_statement: 'Community lacks access to clean drinking water.',
    discipline: 'Environmental Engineering',
    discipline_contribution: 'Engineering methods used to install and test filters.',
    affected_group: 'Households without safe water',
    affected_count: '40',
    system_gaps: ['Access'],
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
  section6: { use_resources: 'no' },
  section7: { has_partners: 'no' },
  section8: {
    has_evidence: 'no',
    media_visible: 'internal',
    ethical_compliance: WIZARD_ETHICS,
  },
  section9: {
    academic_integration: 'Course-linked assignment',
    skills_grown: ['💬 Communication'],
    reflection_biggest_learning: 'listening to the community',
    reflection_moment: 'children choosing books on day one',
    reflection_discipline_help: 'simple data tracking for attendance',
    personal_learning: 'I learned how to document community work.',
    academic_application: 'The project used fieldwork methods from my course.',
    competency_scores: WIZARD_COMPETENCY_SCORES,
  },
  section10: {
    continuation_status: 'no',
    continuation_details: 'Funding is exhausted; no further sessions planned.',
    mechanisms: ['No continuation mechanism'],
    scaling_potential: 'Not scalable',
    policy_influence: 'No',
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
    });
    expect(issues.some((i) => i.section === 6 && i.field === 'resources')).toBe(
      true,
    );
  });

  it('requires a use_resources yes or no choice', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: {},
    });
    expect(
      issues.some((i) => i.section === 6 && i.field === 'use_resources'),
    ).toBe(true);
  });

  it('does not require extra evidence files when has_evidence is no', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'no',
        media_visible: 'internal',
        ethical_compliance: WIZARD_ETHICS,
      },
    });
    expect(issues.some((i) => i.section === 8)).toBe(false);
  });

  it('accepts Restricted/Private without the old four ethics checkboxes', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'no',
        media_visible: 'restricted',
      },
    });
    expect(issues.filter((i) => i.section === 8)).toEqual([]);
  });

  it('requires public-share permission only when visibility is Public', () => {
    const missing = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'no',
        media_visible: 'public',
      },
    });
    expect(
      missing.some(
        (i) => i.section === 8 && i.field === 'public_share_permission',
      ),
    ).toBe(true);
    const ok = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'no',
        media_visible: 'public',
        public_share_permission: true,
      },
    });
    expect(ok.filter((i) => i.section === 8)).toEqual([]);
  });

  it('rejects an empty or whitespace-only section10 continuation_details', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section10: {
        ...VALID_CORE_SECTIONS.section10,
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
      section10: {
        ...VALID_CORE_SECTIONS.section10,
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

  it('flags missing continuation_status among other Step 9 sustainability gaps', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section10: {},
    });
    expect(
      issues.some((i) => i.section === 10 && i.field === 'continuation_status'),
    ).toBe(true);
  });

  it('requires Step 9 scaling, policy, and mechanism chips like the live form', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section10: {
        continuation_status: 'no',
        continuation_details: 'Funding is exhausted; no further sessions planned.',
      },
    });
    expect(issues.some((i) => i.section === 10 && i.field === 'mechanisms')).toBe(true);
    expect(issues.some((i) => i.section === 10 && i.field === 'scaling_potential')).toBe(true);
    expect(issues.some((i) => i.section === 10 && i.field === 'policy_influence')).toBe(true);
  });

  it('accepts a fully valid live-form report with no issues', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
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
    });
    expect(issues.filter((i) => i.section === 4)).toEqual([]);
  });

  it('rejects an unnamed activity and accepts the same block once it has a title', () => {
    const unnamed = {
      activity_blocks: [
        {
          title: '   ',
          primary_category: '🩺 Health & Clinical Outreach',
          sub_category: 'Health Education',
          status: 'Ongoing',
          description: 'Ran a hygiene session with the host clinic.',
          beneficiaries_reached: '40',
        },
      ],
    };
    const blank = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4: unnamed,
    });
    expect(blank.some((i) => i.field === 'activity_blocks.0.title')).toBe(true);

    const named = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4: {
        activity_blocks: [{ ...unnamed.activity_blocks[0], title: 'Classroom hygiene session' }],
      },
    });
    expect(named.filter((i) => i.section === 4)).toEqual([]);
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
    });
    expect(issues.some((i) => i.section === 7 && i.field === 'partners.0.name')).toBe(true);
    expect(issues.some((i) => i.section === 7 && i.field === 'partners.0.type')).toBe(true);
  });

  it('rejects submission when the final declaration is missing or incomplete', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section11: { final_declaration: [true, true, false, true, true], signature_name: 'Jane Student' },
    });
    expect(issues.some((i) => i.section === 11 && i.field === 'final_declaration')).toBe(true);
  });

  it('rejects submission when the electronic signature is missing', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section11: { final_declaration: [true, true, true, true, true], signature_name: '  ' },
    });
    expect(issues.some((i) => i.section === 11 && i.field === 'signature_name')).toBe(true);
  });

  it('requires all three Section 1 declaration checkboxes, not just consent', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section1: { review_checked: [true, false, true] },
    });
    expect(issues.some((i) => i.section === 1)).toBe(true);
  });

  it('rejects privacy_consent alone without the three declaration boxes', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section1: { privacy_consent: true },
    });
    expect(issues.some((i) => i.section === 1 && i.field === 'review_checked')).toBe(
      true,
    );
  });

  it('requires Section 2 affected group, count, gaps, and discipline contribution', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section2: {
        problem_statement: 'Community lacks access to clean drinking water.',
        discipline: 'Environmental Engineering',
        baseline_evidence: ['Survey'],
      },
    });
    expect(issues.some((i) => i.field === 'affected_group')).toBe(true);
    expect(issues.some((i) => i.field === 'affected_count')).toBe(true);
    expect(issues.some((i) => i.field === 'system_gaps')).toBe(true);
    expect(issues.some((i) => i.field === 'discipline_contribution')).toBe(true);
  });

  it('accepts a Step 8 Academic integration chip id', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section9: {
        ...VALID_CORE_SECTIONS.section9,
        academic_integration: 'Course-linked assignment',
      },
    });
    expect(issues.some((i) => i.field === 'academic_integration')).toBe(false);
  });

  it('requires Academic integration when the Step 8 chip is empty', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section9: {
        ...VALID_CORE_SECTIONS.section9,
        academic_integration: '',
      },
    });
    expect(
      issues.some(
        (i) =>
          i.section === 9 &&
          i.field === 'academic_integration' &&
          /Academic integration/i.test(i.message),
      ),
    ).toBe(true);
  });

  it('accepts extra evidence when has_evidence is yes and files are on the payload', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'yes',
        evidence_types: ['Attendance sheet'],
        evidence_files: [{ url: 'https://cdn.example/sheet.jpg', name: 'sheet.jpg' }],
        description: 'the attendance sheet confirms 40 participants across three sessions',
        media_visible: 'internal',
        ethical_compliance: WIZARD_ETHICS,
      },
    });
    expect(issues.filter((i) => i.section === 8)).toEqual([]);
  });

  it('requires the Step 7 caption when extra evidence is yes', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'yes',
        evidence_types: ['Attendance sheet'],
        evidence_files: ['https://cdn.example/sheet.jpg'],
        description: '  ',
        media_visible: 'internal',
        ethical_compliance: WIZARD_ETHICS,
      },
    });
    expect(issues.some((i) => i.section === 8 && i.field === 'description')).toBe(true);
  });

  it('accepts a V13 ladder activity plus a linked before/after outcome', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4: {
        activity_blocks: [
          {
            id: 'act-1',
            title: 'Digital-safety workshops',
            primary_category: '📚 Education & Learning',
            sub_category: 'Digital Literacy',
            status: 'Completed',
            description: 'Sara ran four sessions, Ali built the slides, the school arranged the lab.',
            outputs: [{ title: 'Sessions Conducted', type: 'Sessions Conducted', quantity: '4', unit: 'Sessions' }],
            serves_beneficiaries: true,
            unique_beneficiaries: '86',
            beneficiaries_reached: '86',
            overlap_status: 'Mostly Unique to This Activity',
            beneficiary_categories: ['Students'],
            reach_counting_method: 'Verified registration / list',
            geographic_reach: 'Single Site',
            sdgs: [4],
            ladder_ui: { open: 0 },
          },
        ],
        project_summary: { distinct_total_beneficiaries: '86' },
      },
      section5: {
        ...VALID_CORE_SECTIONS.section5,
        measurable_outcomes: [
          {
            id: 'out-1',
            activity_id: 'act-1',
            outcome_area: '4. Knowledge / Skills Improvement',
            outcome_sub_category: 'Awareness Sessions',
            metric_category: '🔹 Percentage-Based (Advanced)',
            metric: 'Percentage Improvement (%)',
            metric_other: 'Attendance rate (%)',
            baseline: '48',
            endline: '79',
            unit: '%',
            sure: 1,
            confidence_level: ['Directly Measured'],
            measurement_explanation: 'Compared the school attendance register four weeks before vs after.',
          },
        ],
      },
    });
    expect(issues.filter((i) => i.section === 4 || i.section === 5)).toEqual([]);
  });
});

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

/** Payload that matches a complete live-form submit, including word-count ranges. */
const VALID_CORE_SECTIONS = {
  section1: { privacy_consent: true, review_checked: [true, true, true] },
  section2: {
    problem_statement:
      'Community lacks access to clean drinking water, and many households have relied on unsafe open wells for years, leading to repeated illness among children and elderly residents during the dry season.',
    discipline: 'Environmental Engineering',
    discipline_contribution:
      'Engineering methods were used to design, install and pressure-test the filtration units, then train household members on routine cleaning and maintenance procedures.',
    affected_group: 'Households without safe water',
    affected_count: '40',
    system_gaps: ['Access'],
    baseline_evidence: ['Survey'],
  },
  section3: {
    contribution_intent_statement:
      'Students will support safer water handling in the host community by installing household filtration units, demonstrating correct usage, and documenting baseline and follow-up water quality readings so that the partner organization can track improvement over the coming months and plan further interventions where needed.',
  },
  section4: {
    activity_blocks: [
      {
        title: 'Water filter installation',
        primary_category: 'Infrastructure',
        sub_category: 'Water / Sanitation Infrastructure',
        status: 'Completed',
        description:
          'Installed household water filters across five homes, showed each family how to assemble, clean and use the units correctly, and answered questions about ongoing maintenance.',
        outputs: [{ title: 'Filters installed', quantity: '5' }],
      },
    ],
    project_summary: {
      distinct_total_beneficiaries: 50,
      counting_method: 'Headcount',
    },
  },
  section5: {
    observed_change:
      'Households report improved water quality and fewer stomach illnesses since the filters were installed, with several families noting that children miss fewer school days and that water now looks and tastes noticeably cleaner than before the project began, according to informal household feedback collected during follow-up visits.',
    challenges:
      'Replacement parts were hard to find locally in the first week, and the team had to travel to a neighboring town to source the correct filter cartridges before installation could continue.',
    story_because: 'Household register and follow-up visits by the team',
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
        measurement_explanation:
          "Counted directly from the partner organization's household register, which was updated and cross-checked by the team at each site visit during the project.",
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
    personal_learning:
      'I learned how to document community work carefully, listen to residents before proposing solutions, and record evidence in a way that other people could later verify. Working alongside the partner staff also taught me patience, because real change in a household routine takes weeks of follow-up rather than one visit.',
    academic_application:
      'The project used fieldwork and data-collection methods from my engineering coursework, including basic water-quality testing and structured household interviews to track outcomes over time and compare them against the baseline readings.',
    competency_scores: WIZARD_COMPETENCY_SCORES,
  },
  section10: {
    continuation_status: 'no',
    continuation_details:
      'Funding is exhausted and no further paid sessions are planned, but the partner organization has agreed to keep one filter-maintenance volunteer on site so households can still get help with basic repairs and replacement parts if something breaks after the project formally ends this term, and the school has also offered to store spare parts so the volunteer does not need to travel far to get them when a filter needs attention.',
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

  it('a donated or sponsored resource needs its contributor and evidence trail', () => {
    const base = {
      section6: {
        use_resources: 'yes',
        resources: [
          {
            type: 'Educational / Learning Materials',
            amount: '50',
            unit: 'Books / Materials',
            sources: ['Individual Donor'],
            purpose: 'Notebooks for Class 4',
            verification: ['Receipt / Invoice'],
          },
        ],
      },
    };
    const fields = validateReportSectionsForSubmit(base as never)
      .filter((i) => i.section === 6)
      .map((i) => i.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'resources.0.contributor_name',
        'resources.0.contributor_email',
        'resources.0.contributor_phone',
        'resources.0.evidence_trail',
      ]),
    );

    const complete = {
      section6: {
        use_resources: 'yes',
        resources: [
          {
            ...base.section6.resources[0],
            contributor_name: 'Ahmed Books',
            contributor_email: 'ahmed@books.pk',
            contributor_phone_code: '+92',
            contributor_phone: '0300 1234567',
            evidence_trail: 'Purchase receipt, handover photos to Class 4',
          },
        ],
      },
    };
    expect(
      validateReportSectionsForSubmit(complete as never).filter(
        (i) => i.section === 6,
      ),
    ).toEqual([]);
  });

  it('"What did it make possible?" is one clear line, not a single word; a numeric amount still counts as an amount', () => {
    const entry = {
      type: 'Educational / Learning Materials',
      amount: 50,
      unit: 'Books / Materials',
      sources: ['Student Team'],
      verification: ['Receipt / Invoice'],
    };
    const oneWord = {
      section6: {
        use_resources: 'yes',
        resources: [{ ...entry, purpose: 'Paint' }],
      },
    };
    const oneWordIssues = validateReportSectionsForSubmit(
      oneWord as never,
    ).filter((i) => i.section === 6);
    expect(oneWordIssues.map((i) => i.field)).toEqual(['resources.0.purpose']);
    expect(oneWordIssues[0].message).toMatch(/one clear line/);

    const line = {
      section6: {
        use_resources: 'yes',
        resources: [{ ...entry, purpose: 'Paint for both classroom walls' }],
      },
    };
    expect(
      validateReportSectionsForSubmit(line as never).filter(
        (i) => i.section === 6,
      ),
    ).toEqual([]);
  });

  it('team time / self-funded resources need no contributor details; a phone without a country code is refused', () => {
    const inKind = {
      section6: {
        use_resources: 'yes',
        resources: [
          {
            type: 'Volunteer Time',
            amount: '20',
            unit: 'Hours',
            sources: ['Student Team'],
            purpose: 'Facilitation of the training sessions',
            verification: ['Timesheet / Volunteer Log'],
          },
          {
            type: 'Cash / Funding',
            amount: '3000',
            unit: 'PKR',
            sources: ['Self-funded'],
            purpose: 'Paint for the classroom walls',
            verification: ['Receipt / Invoice'],
            contributor_phone_code: '',
            contributor_phone: '3001234567',
          },
        ],
      },
    };
    const fields = validateReportSectionsForSubmit(inKind as never)
      .filter((i) => i.section === 6)
      .map((i) => i.field);
    expect(fields).toEqual(['resources.1.contributor_phone']);
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

  it('accepts Restricted/Private once the V19 authenticity / consent confirmation is ticked', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'no',
        media_visible: 'restricted',
        ethical_compliance: WIZARD_ETHICS,
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
        ethical_compliance: WIZARD_ETHICS,
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
        ethical_compliance: WIZARD_ETHICS,
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

  it('rejects a section10 continuation_details below the 60-120 word minimum (mirrors the frontend wizard policy server-side)', () => {
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
    ).toBe(true);
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
        continuation_details:
          'Funding is exhausted; no further sessions planned.',
      },
    });
    expect(
      issues.some((i) => i.section === 10 && i.field === 'mechanisms'),
    ).toBe(true);
    expect(
      issues.some((i) => i.section === 10 && i.field === 'scaling_potential'),
    ).toBe(true);
    expect(
      issues.some((i) => i.section === 10 && i.field === 'policy_influence'),
    ).toBe(true);
  });

  it('accepts a fully valid live-form report with no issues', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
    });
    expect(issues).toEqual([]);
  });

  it('requires student_contribution_intent_statement only once the student picked their own SDG mapping', () => {
    const noMapping = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
    });
    expect(
      noMapping.some(
        (i) =>
          i.section === 3 &&
          i.field === 'student_contribution_intent_statement',
      ),
    ).toBe(false);

    const missing = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: {
        ...VALID_CORE_SECTIONS.section3,
        primary_sdg: { goal_number: 6, target_id: '6.1' },
      },
    });
    expect(
      missing.some(
        (i) =>
          i.section === 3 &&
          i.field === 'student_contribution_intent_statement',
      ),
    ).toBe(true);

    const tooShort = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: {
        ...VALID_CORE_SECTIONS.section3,
        primary_sdg: { goal_number: 6, target_id: '6.1' },
        student_contribution_intent_statement: 'too short',
      },
    });
    expect(
      tooShort.some(
        (i) =>
          i.section === 3 &&
          i.field === 'student_contribution_intent_statement',
      ),
    ).toBe(true);

    const ok = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: {
        ...VALID_CORE_SECTIONS.section3,
        primary_sdg: { goal_number: 6, target_id: '6.1' },
        student_contribution_intent_statement:
          'We mapped the gap against SDG 6 and focused on safe water handling, training household members on filter maintenance and documenting readings for the partner.',
      },
    });
    expect(
      ok.some(
        (i) =>
          i.section === 3 &&
          i.field === 'student_contribution_intent_statement',
      ),
    ).toBe(false);
  });

  it('requires a justification for every secondary SDG', () => {
    const missing = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: {
        ...VALID_CORE_SECTIONS.section3,
        secondary_sdgs: [{ sdg_id: '6', target_id: '6.1' }],
      },
    });
    expect(
      missing.some(
        (i) =>
          i.section === 3 && i.field === 'secondary_sdgs.0.justification_text',
      ),
    ).toBe(true);

    const tooShort = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: {
        ...VALID_CORE_SECTIONS.section3,
        secondary_sdgs: [
          { sdg_id: '6', target_id: '6.1', justification_text: 'too short' },
        ],
      },
    });
    expect(
      tooShort.some(
        (i) =>
          i.section === 3 && i.field === 'secondary_sdgs.0.justification_text',
      ),
    ).toBe(true);
  });

  it('requires an overlap note when an activity serves beneficiaries and reach is not "mostly unique"', () => {
    const baseActivity = VALID_CORE_SECTIONS.section4.activity_blocks[0];

    const missing = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4: {
        ...VALID_CORE_SECTIONS.section4,
        activity_blocks: [
          {
            ...baseActivity,
            overlap_status: 'Some overlap with another activity',
          },
        ],
      },
    });
    expect(
      missing.some(
        (i) => i.section === 4 && i.field === 'activity_blocks.0.overlap_note',
      ),
    ).toBe(true);

    const notRequiredWhenMostlyUnique = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4: {
        ...VALID_CORE_SECTIONS.section4,
        activity_blocks: [{ ...baseActivity, overlap_status: 'Mostly unique' }],
      },
    });
    expect(
      notRequiredWhenMostlyUnique.some(
        (i) => i.section === 4 && i.field === 'activity_blocks.0.overlap_note',
      ),
    ).toBe(false);

    const notRequiredWhenNoBeneficiaries = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4: {
        ...VALID_CORE_SECTIONS.section4,
        activity_blocks: [{ ...baseActivity, serves_beneficiaries: false }],
      },
    });
    expect(
      notRequiredWhenNoBeneficiaries.some(
        (i) => i.section === 4 && i.field === 'activity_blocks.0.overlap_note',
      ),
    ).toBe(false);

    const ok = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4: {
        ...VALID_CORE_SECTIONS.section4,
        activity_blocks: [
          {
            ...baseActivity,
            overlap_status: 'Some overlap with another activity',
            overlap_note:
              'Roughly a quarter of the households also appeared in the hygiene session roster from the same week, so their water-quality readings may double count toward beneficiary totals.',
          },
        ],
      },
    });
    expect(
      ok.some(
        (i) => i.section === 4 && i.field === 'activity_blocks.0.overlap_note',
      ),
    ).toBe(false);
  });

  it('accepts an activity with reach and no delivery mode or project summary', () => {
    const section4 = {
      activity_blocks: [
        {
          title: 'Hygiene session',
          primary_category: '🩺 Health & Clinical Outreach',
          sub_category: 'Health Education',
          status: 'Ongoing',
          description:
            'Ran a hygiene session with the host clinic, demonstrating handwashing steps and distributing soap to every family that attended.',
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
          description:
            'Ran a hygiene session with the host clinic, demonstrating handwashing steps and distributing soap to every family that attended.',
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
        activity_blocks: [
          { ...unnamed.activity_blocks[0], title: 'Classroom hygiene session' },
        ],
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
          description:
            'Ran a hygiene session with the host clinic, demonstrating handwashing steps and distributing soap to every family that attended.',
          outputs: [],
        },
      ],
    };
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section4,
    });
    expect(
      issues.some(
        (i) => i.section === 4 && i.field === 'activity_blocks.0.outputs',
      ),
    ).toBe(true);
  });

  it('keeps a named subcategory that contains the word Other', () => {
    const section4 = {
      activity_blocks: [
        {
          title: 'Kit distribution',
          primary_category: 'Resource Distribution',
          sub_category: 'Other Essential Resource Support',
          status: 'Completed',
          description:
            'Distributed hygiene kits at the school gate, showing each family how to use every item safely and answering their questions.',
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
        continuation_details:
          'Funding is exhausted; no further sessions planned.',
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

  it('requires each listed partner to have a name, roles and a contribution line; the partner type stays Recommended', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section7: { has_partners: 'yes', partners: [{}] },
    });
    expect(
      issues.some((i) => i.section === 7 && i.field === 'partners.0.name'),
    ).toBe(true);
    // The card marks the type "Recommended" (V19 Section 6 asks for roles + contribution), so the
    // gate must not demand it — the QA sweep found the validator out of step with the form.
    expect(
      issues.some((i) => i.section === 7 && i.field === 'partners.0.type'),
    ).toBe(false);
    const contribution = issues.find(
      (i) => i.section === 7 && i.field === 'partners.0.contribution',
    );
    expect(contribution?.message).toMatch(/in one line/);
    // A chosen "Other" type still has to be spelled out.
    const other = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section7: {
        has_partners: 'yes',
        partners: [
          {
            name: 'Local shop',
            type: '✏️ Other',
            role: ['Venue'],
            contribution: ['gave the hall'],
          },
        ],
      },
    });
    expect(
      other.some((i) => i.section === 7 && i.field === 'partners.0.type_other'),
    ).toBe(true);
  });

  it('rejects submission when the final declaration is missing or incomplete', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section11: {
        final_declaration: [true, true, false, true, true],
        signature_name: 'Jane Student',
      },
    });
    expect(
      issues.some((i) => i.section === 11 && i.field === 'final_declaration'),
    ).toBe(true);
  });

  it('rejects submission when the electronic signature is missing', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section11: {
        final_declaration: [true, true, true, true, true],
        signature_name: '  ',
      },
    });
    expect(
      issues.some((i) => i.section === 11 && i.field === 'signature_name'),
    ).toBe(true);
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
    expect(
      issues.some((i) => i.section === 1 && i.field === 'review_checked'),
    ).toBe(true);
  });

  describe('V19 item 08 · attendance sessions without evidence', () => {
    const s1 = (logs: unknown[]) => ({
      privacy_consent: true,
      review_checked: [true, true, true],
      attendance_logs: logs,
    });
    const evidenceIssue = (
      issues: ReturnType<typeof validateReportSectionsForSubmit>,
    ) => issues.find((i) => i.section === 1 && i.field === 'attendance_logs');

    it('blocks a counted session that has no evidence at all', () => {
      const issues = validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section1: s1([
          { id: 'a', date: '2026-03-02', hours: 3, approval_status: 'pending' },
        ]),
      });
      expect(evidenceIssue(issues)?.message).toContain(
        '1 attendance session has no supporting evidence',
      );
      expect(evidenceIssue(issues)?.message).toContain('2026-03-02');
    });

    it('accepts any evidence shape the wizard or the API sends', () => {
      const issues = validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section1: s1([
          { id: 'a', date: '2026-03-02', evidence_url: 'https://cdn/x.jpg' },
          { id: 'b', date: '2026-03-03', evidenceUrl: 'https://cdn/y.jpg' },
          { id: 'c', date: '2026-03-04', evidence_file: 'https://cdn/z.jpg' },
          { id: 'd', date: '2026-03-05', evidence_file: true },
          { id: 'e', date: '2026-03-06', evidenceUploaded: true },
          { id: 'f', date: '2026-03-07', evidence_urls: ['https://cdn/w.jpg'] },
        ]),
      });
      expect(evidenceIssue(issues)).toBeUndefined();
    });

    it('leaves approved / verified sessions and rejected sessions alone', () => {
      const issues = validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section1: s1([
          { id: 'a', date: '2026-03-02', approval_status: 'approved' },
          { id: 'b', date: '2026-03-03', entryStatus: 'verified' },
          { id: 'c', date: '2026-03-04', approval_status: 'rejected' },
        ]),
      });
      expect(evidenceIssue(issues)).toBeUndefined();
    });

    it('is silent for reports that carry no attendance_logs array (legacy payloads)', () => {
      const issues = validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section1: { privacy_consent: true, review_checked: [true, true, true] },
      });
      expect(evidenceIssue(issues)).toBeUndefined();
    });
  });

  describe('V19 item 17 · contribution per registered secondary SDG', () => {
    const fieldOf = (
      issues: ReturnType<typeof validateReportSectionsForSubmit>,
      goal: string,
    ) =>
      issues.find(
        (i) =>
          i.section === 3 &&
          i.field === `registered_secondary_contributions.${goal}`,
      );

    it('requires a statement for every registered secondary SDG the wizard seeded', () => {
      const issues = validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section3: {
          ...VALID_CORE_SECTIONS.section3,
          registered_secondary_contributions: { '5': '', '8': 'too short' },
        },
      });
      expect(fieldOf(issues, '5')?.message).toContain('Registered SDG 5');
      expect(fieldOf(issues, '8')?.message).toContain('10–60 words');
    });

    it('accepts a 10–60 word statement per registered SDG and ignores reports without the map', () => {
      const ok = validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section3: {
          ...VALID_CORE_SECTIONS.section3,
          registered_secondary_contributions: {
            '5': 'Women in the host community led the filter maintenance sessions and kept the water-quality log for their street.',
          },
        },
      });
      expect(fieldOf(ok, '5')).toBeUndefined();
      const legacy = validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
      });
      expect(
        legacy.some((i) =>
          i.field.startsWith('registered_secondary_contributions'),
        ),
      ).toBe(false);
    });
  });

  describe('Section 10 · 9.5 follow-up check', () => {
    const withFollowUp = (extra: Record<string, unknown>) =>
      validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section10: { ...VALID_CORE_SECTIONS.section10, ...extra },
      }).filter((i) => i.field.startsWith('followup_'));

    it('never blocks a report saved before 9.5 existed (no followup_* keys)', () => {
      expect(withFollowUp({})).toEqual([]);
      expect(withFollowUp({ followup_plan: '' })).toEqual([]);
      expect(withFollowUp({ followup_plan: null })).toEqual([]);
    });

    it('never blocks "Not decided yet"', () => {
      expect(
        withFollowUp({
          followup_plan: 'later',
          followup_decision_owner: 'faculty',
        }),
      ).toEqual([]);
    });

    it('requires a reason when no follow-up is planned, and text when the reason is Other', () => {
      expect(withFollowUp({ followup_plan: 'no' }).map((i) => i.field)).toEqual(
        ['followup_no_reason'],
      );
      expect(
        withFollowUp({ followup_plan: 'no', followup_no_reason: 'Other' }).map(
          (i) => i.field,
        ),
      ).toEqual(['followup_no_reason_other']);
      expect(
        withFollowUp({
          followup_plan: 'no',
          followup_no_reason: 'Follow-up is not feasible',
        }),
      ).toEqual([]);
    });

    it('requires the contact, a valid email and a due date when a follow-up is planned', () => {
      expect(
        withFollowUp({ followup_plan: 'yes' })
          .map((i) => i.field)
          .sort(),
      ).toEqual([
        'followup_due_date',
        'followup_owner_email',
        'followup_owner_name',
        'followup_owner_role',
      ]);
      const bad = withFollowUp({
        followup_plan: 'yes',
        followup_owner_role: 'Faculty supervisor',
        followup_owner_name: 'Dr Khan',
        followup_owner_email: 'not-an-email',
        followup_due_date: '2027-02-30',
      });
      expect(bad.map((i) => i.field).sort()).toEqual([
        'followup_due_date',
        'followup_owner_email',
      ]);
    });

    it('accepts a fully answered follow-up (instruction stays optional)', () => {
      expect(
        withFollowUp({
          followup_plan: 'yes',
          followup_owner_role: 'Faculty supervisor',
          followup_owner_name: 'Dr Khan',
          followup_owner_email: 'khan@example.org',
          followup_due_date: '2027-02-05',
          followup_check: 'Whether the reported benefits are still continuing',
        }),
      ).toEqual([]);
    });

    it('ignores stale contact fields once the plan is no longer "yes"', () => {
      expect(
        withFollowUp({
          followup_plan: 'later',
          followup_owner_email: 'garbage',
        }),
      ).toEqual([]);
    });
  });

  describe('Section 2.3 risk, safeguarding & consent', () => {
    const withRisk = (extra: Record<string, unknown>) =>
      validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section2: { ...VALID_CORE_SECTIONS.section2, ...extra },
      }).filter((i) => i.field.startsWith('risk_'));

    it('never blocks a report saved before 2.3 existed (no risk_* keys)', () => {
      expect(withRisk({})).toEqual([]);
    });

    it('never blocks "None identified" or an empty chip list', () => {
      expect(withRisk({ risk_factors: ['none'] })).toEqual([]);
      expect(withRisk({ risk_factors: [] })).toEqual([]);
      expect(withRisk({ risk_factors: null })).toEqual([]);
    });

    it('requires mitigation, consent and the on-site lead once a real risk is selected', () => {
      const fields = withRisk({ risk_factors: ['children_present'] }).map(
        (i) => i.field,
      );
      expect(fields.sort()).toEqual([
        'risk_consent',
        'risk_mitigation',
        'risk_safeguarding_lead',
      ]);
    });

    it('accepts a fully answered block (unresolved stays optional)', () => {
      expect(
        withRisk({
          risk_factors: ['children_present', 'beneficiary_photos'],
          risk_mitigation: 'Partner staff in every session.',
          risk_consent: 'written',
          risk_safeguarding_lead: 'Village Director',
        }),
      ).toEqual([]);
    });

    it('treats whitespace-only answers as missing and ignores a stray "none" next to a real risk', () => {
      const issues = withRisk({
        risk_factors: ['none', 'travel_to_site'],
        risk_mitigation: '   ',
        risk_consent: 'verbal',
        risk_safeguarding_lead: 'Mr Khan, coordinator',
      });
      expect(issues.map((i) => i.field)).toEqual(['risk_mitigation']);
    });
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
    expect(issues.some((i) => i.field === 'discipline_contribution')).toBe(
      true,
    );
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
        evidence_files: [
          { url: 'https://cdn.example/sheet.jpg', name: 'sheet.jpg' },
        ],
        description:
          'the attendance sheet confirms 40 participants took part across three separate sessions this month',
        media_visible: 'internal',
        ethical_compliance: WIZARD_ETHICS,
      },
    });
    expect(issues.filter((i) => i.section === 8)).toEqual([]);
  });

  it('V19 8.2 · the Step 7 caption is optional; a given caption may be short but never over 45 words', () => {
    const blank = validateReportSectionsForSubmit({
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
    expect(
      blank.some((i) => i.section === 8 && i.field === 'description'),
    ).toBe(false);
    const short = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'yes',
        evidence_types: ['Attendance sheet'],
        evidence_files: ['https://cdn.example/sheet.jpg'],
        description: 'photos of the day',
        media_visible: 'internal',
        ethical_compliance: WIZARD_ETHICS,
      },
    });
    expect(
      short.some((i) => i.section === 8 && i.field === 'description'),
    ).toBe(false);
    const long = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section8: {
        has_evidence: 'yes',
        evidence_types: ['Attendance sheet'],
        evidence_files: ['https://cdn.example/sheet.jpg'],
        description: Array.from({ length: 46 }, (_, i) => `word${i}`).join(' '),
        media_visible: 'internal',
        ethical_compliance: WIZARD_ETHICS,
      },
    });
    const issue = long.find(
      (i) => i.section === 8 && i.field === 'description',
    );
    expect(issue?.message).toMatch(/up to 45 words \(46 current\)/);
  });

  it('a blank earlier-version outcome row never blocks submit; a row with content keeps its rules; a half-filled V19 result is flagged', () => {
    // The old form saved an empty detailed row by default. The student cannot see it in the V19
    // wizard, so it must not be the reason the report cannot be submitted.
    const blankLegacy = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section5: {
        ...VALID_CORE_SECTIONS.section5,
        measurable_outcomes: [
          {
            id: 'old-1',
            outcome_area: '',
            outcome_sub_category: '',
            metric_category: '',
            metric: '',
            baseline: '',
            endline: '',
            unit: '',
            confidence_level: [],
            measurement_explanation: '',
          },
        ],
      },
    });
    expect(blankLegacy.filter((i) => i.section === 5)).toEqual([]);

    // A legacy row that says something is still held to the detailed rules.
    const partialLegacy = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section5: {
        ...VALID_CORE_SECTIONS.section5,
        measurable_outcomes: [{ id: 'old-2', baseline: '55', endline: '' }],
      },
    });
    expect(
      partialLegacy.filter((i) => i.section === 5).map((i) => i.field),
    ).toEqual(
      expect.arrayContaining([
        'measurable_outcomes.0.outcome_area',
        'measurable_outcomes.0.endline',
        'measurable_outcomes.0.unit',
      ]),
    );

    // The V19 single result: "Before 55, After blank, no unit" is incomplete and says so.
    const halfSimple = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section5: {
        ...VALID_CORE_SECTIONS.section5,
        measurable_outcomes: [
          {
            id: 'oc-1',
            simple: true,
            metric: 'QA calculation test',
            unit: '',
            baseline: '55',
            endline: '',
            measurement_explanation: '',
          },
        ],
      },
    });
    expect(
      halfSimple.filter((i) => i.section === 5).map((i) => i.message),
    ).toEqual([
      'Choose the unit of the measured result',
      'Enter the after value (same unit)',
      'Say where these figures come from',
    ]);
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
            description:
              'Sara ran four sessions, Ali built the slides, and the school arranged the computer lab and projector for every session.',
            outputs: [
              {
                title: 'Sessions Conducted',
                type: 'Sessions Conducted',
                quantity: '4',
                unit: 'Sessions',
              },
            ],
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
            measurement_explanation:
              'Compared the school attendance register from four weeks before the workshops to four weeks after, using the same register the school already keeps.',
          },
        ],
      },
    });
    expect(issues.filter((i) => i.section === 4 || i.section === 5)).toEqual(
      [],
    );
  });
});

describe('V19 spec audit · structural gates that were missing', () => {
  const run = (patch: Record<string, unknown>) =>
    validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      ...patch,
    } as Parameters<typeof validateReportSectionsForSubmit>[0]);
  const fields = (patch: Record<string, unknown>, section: number) =>
    run(patch)
      .filter((i) => i.section === section)
      .map((i) => i.field);

  it('3.2 · a student-added SDG needs its Target and Indicator, not only the justification', () => {
    const base = VALID_CORE_SECTIONS.section3 as Record<string, unknown>;
    const added = {
      goal_number: 6,
      justification_text:
        'Clean water storage at the school reduced the children exposure to contaminated supply during lessons.',
    };
    expect(
      fields({ section3: { ...base, secondary_sdgs: [added] } }, 3),
    ).toEqual(
      expect.arrayContaining([
        'secondary_sdgs.0.target_id',
        'secondary_sdgs.0.indicator_id',
      ]),
    );
    expect(
      fields(
        {
          section3: {
            ...base,
            secondary_sdgs: [
              { ...added, target_id: '6.1', indicator_id: '6.1.1' },
            ],
          },
        },
        3,
      ),
    ).toEqual([]);
  });

  it('4.3 · "How do you know?" is required beside the observed change', () => {
    const base = VALID_CORE_SECTIONS.section5 as Record<string, unknown>;
    expect(fields({ section5: { ...base, story_because: '' } }, 5)).toContain(
      'story_because',
    );
    expect(
      fields(
        {
          section5: {
            ...base,
            story_because: '',
            evidence_basis_tags: ['Photos'],
          },
        },
        5,
      ),
    ).not.toContain('story_because');
  });

  it('6.2 · a resource entry needs type, amount, unit, a source and a verification method', () => {
    const got = fields(
      {
        section6: {
          use_resources: 'yes',
          resources: [{ purpose: 'Paint for both classrooms' }],
        },
      },
      6,
    );
    expect(got).toEqual(
      expect.arrayContaining([
        'resources.0.type',
        'resources.0.amount',
        'resources.0.unit',
        'resources.0.sources',
        'resources.0.verification',
      ]),
    );
    expect(
      fields(
        {
          section6: {
            use_resources: 'yes',
            resources: [
              {
                type: 'Cash / Funding',
                amount: '8000',
                unit: 'Cash — PKR',
                sources: ['Student Team'],
                verification: ['Evidence Uploaded'],
                purpose: 'Paint for both classrooms',
              },
            ],
          },
        },
        6,
      ),
    ).toEqual([]);
  });

  it('8.2 · the authenticity / consent confirmation is mandatory; the caption is optional', () => {
    const base = VALID_CORE_SECTIONS.section8 as Record<string, unknown>;
    expect(
      fields(
        { section8: { ...base, ethical_compliance: { authentic: true } } },
        8,
      ),
    ).toContain('ethical_compliance');
    expect(
      fields({ section8: { ...base, ethical_compliance: undefined } }, 8),
    ).toContain('ethical_compliance');
    expect(
      fields(
        {
          section8: {
            ...base,
            has_evidence: 'yes',
            evidence_types: ['📋 Attendance sheet'],
            evidence_files: ['https://x/a.jpg'],
            description: '',
          },
        },
        8,
      ),
    ).not.toContain('description');
    expect(
      fields(
        {
          section8: {
            ...base,
            has_evidence: 'yes',
            evidence_types: ['📋 Attendance sheet'],
            evidence_files: ['https://x/a.jpg'],
            description: 'two words',
          },
        },
        8,
      ),
    ).not.toContain('description');
    // V19 8.2 "Optional evidence explanation": no minimum, but never more than 45 words.
    expect(
      fields(
        {
          section8: {
            ...base,
            has_evidence: 'yes',
            evidence_types: ['📋 Attendance sheet'],
            evidence_files: ['https://x/a.jpg'],
            description: Array.from({ length: 50 }, () => 'word').join(' '),
          },
        },
        8,
      ),
    ).toContain('description');
  });
});

describe('QA sweep (22 Nov) — validator matches the V19 form', () => {
  const extraSdg = (goal: number) => ({
    goal_number: goal,
    target_id: `${goal}.1`,
    indicator_id: `${goal}.1.1`,
    justification_text:
      'The project supports this goal through the weekly sessions and the materials handed to the families involved.',
    status: 'provisional',
  });

  it('FT-04 · at most two additional SDGs in total — the student primary counts when the opportunity has its own', () => {
    const base = {
      ...VALID_CORE_SECTIONS.section3,
      registered_primary_goal: 4,
      primary_sdg: {
        goal_number: 12,
        target_id: '12.5',
        indicator_id: '12.5.1',
      },
      student_contribution_intent_statement:
        'During implementation the team reused furniture and paint so that less material went to waste in the classrooms.',
    };
    const three = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: { ...base, secondary_sdgs: [extraSdg(11), extraSdg(13)] },
    });
    const cap = three.find(
      (i) => i.section === 3 && i.field === 'secondary_sdgs',
    );
    expect(cap?.message).toMatch(/at most 2 in total/);
    const two = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: { ...base, secondary_sdgs: [extraSdg(11)] },
    });
    expect(
      two.some((i) => i.section === 3 && i.field === 'secondary_sdgs'),
    ).toBe(false);
    // No registered primary on the opportunity: the student primary is the report's primary.
    const ownPrimary = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section3: {
        ...base,
        registered_primary_goal: null,
        secondary_sdgs: [extraSdg(11), extraSdg(13)],
      },
    });
    expect(
      ownPrimary.some((i) => i.section === 3 && i.field === 'secondary_sdgs'),
    ).toBe(false);
  });

  it('Section 5 · a negative or zero amount is refused; free-text amounts are left to the amount rule', () => {
    const entry = {
      type: 'Cash / Funding',
      unit: 'PKR',
      sources: ['Student Team'],
      purpose: 'Paint for both classroom walls',
      verification: ['Receipt / Invoice'],
    };
    const negative = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: {
        use_resources: 'yes',
        resources: [{ ...entry, amount: '-1' }],
      },
    }).filter((i) => i.section === 6);
    expect(negative.map((i) => i.message)).toEqual([
      'Enter an amount greater than 0',
    ]);
    const zero = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: { use_resources: 'yes', resources: [{ ...entry, amount: 0 }] },
    }).filter((i) => i.section === 6);
    expect(zero.map((i) => i.field)).toEqual(['resources.0.amount']);
    const fine = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section6: {
        use_resources: 'yes',
        resources: [{ ...entry, amount: '8,000' }],
      },
    }).filter((i) => i.section === 6);
    expect(fine).toEqual([]);
  });

  it('FT-06 · a mixed-source entry records the student team share, which cannot exceed the total', () => {
    const mixed = {
      type: 'Cash / Funding',
      amount: '8000',
      unit: 'PKR',
      sources: ['Student Team', 'Private Sponsor'],
      purpose: 'Paint and brushes for the classrooms',
      verification: ['Receipt / Invoice'],
      contributor_name: 'Ayesha Khan',
      contributor_email: 'ayesha@example.org',
      contributor_phone_code: '+92',
      contributor_phone: '3001234567',
      evidence_trail: 'Bank transfer receipt and the paint-shop invoice',
    };
    const run = (patch: Record<string, unknown>) =>
      validateReportSectionsForSubmit({
        ...VALID_CORE_SECTIONS,
        section6: { use_resources: 'yes', resources: [{ ...mixed, ...patch }] },
      }).filter((i) => i.section === 6);
    expect(run({}).map((i) => i.field)).toEqual([
      'resources.0.student_team_share',
    ]);
    expect(run({ student_team_share: '9000' })[0]?.message).toMatch(
      /cannot exceed the resource total/,
    );
    expect(run({ student_team_share: '-5' })[0]?.message).toMatch(/0 or more/);
    expect(run({ student_team_share: '3000' })).toEqual([]);
    expect(run({ student_team_share: 0 })).toEqual([]);
    // A purely outside source needs no share split.
    expect(
      run({ sources: ['Private Sponsor'], student_team_share: '' }),
    ).toEqual([]);
  });

  it('Section 8 · the reflections are gated on the on-screen ranges (40–100 and 25–70 words)', () => {
    const issues = validateReportSectionsForSubmit({
      ...VALID_CORE_SECTIONS,
      section9: {
        ...VALID_CORE_SECTIONS.section9,
        personal_learning: Array.from({ length: 30 }, () => 'word').join(' '),
        academic_application: Array.from({ length: 20 }, () => 'word').join(
          ' ',
        ),
      },
    }).filter((i) => i.section === 9);
    expect(
      issues.find((i) => i.field === 'personal_learning')?.message,
    ).toMatch(/40–100 words \(30 current\)/);
    expect(
      issues.find((i) => i.field === 'academic_application')?.message,
    ).toMatch(/25–70 words \(20 current\)/);
  });
});

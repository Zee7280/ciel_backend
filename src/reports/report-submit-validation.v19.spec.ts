import { validateReportSectionsForSubmit } from './report-submit-validation.util';

/**
 * V19 streamlined Section 4: the backend safety net accepts exactly what the wizard now collects —
 * an activity may declare "no countable output" (with a reason), the one before / after measure is
 * optional, and a short honest "what changed" is enough.
 */
const ETHICS = {
  authentic: true,
  informed_consent: true,
  no_harm: true,
  privacy_respected: true,
};
const SCORES = Object.fromEntries(
  [
    'cognitive_systemic',
    'cognitive_critical',
    'cognitive_evaluate',
    'practical_design',
    'practical_evidence',
    'practical_engagement',
    'social_empathy',
    'social_diversity',
    'social_collaboration',
    'transformative_longterm',
    'transformative_benefits',
    'transformative_sustainability',
  ].map((k) => [k, 3]),
);

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function report(overrides: Record<string, unknown> = {}) {
  return {
    section1: { privacy_consent: true, review_checked: [true, true, true] },
    section2: {
      problem_statement: words(20),
      discipline: 'Environmental Engineering',
      discipline_contribution: words(20),
      affected_group: 'Grade 5',
      affected_count: '30',
      system_gaps: ['Access'],
      baseline_evidence: ['Survey'],
    },
    section3: { contribution_intent_statement: words(40) },
    section4: {
      activity_blocks: [
        {
          title: 'English workshops',
          primary_category: 'Education',
          sub_category: 'Tutoring',
          status: 'Completed',
          description: words(20),
          outputs: [
            {
              title: 'Sessions Conducted',
              type: 'Sessions Conducted',
              quantity: '4',
              unit: 'Sessions',
            },
          ],
          v19: true,
        },
      ],
      project_summary: {
        reach_mode: 'counted',
        distinct_total_beneficiaries: 30,
        counting_method: 'Attendance register',
      },
    },
    section5: {
      story_because: 'Team records and partner feedback',
      observed_change:
        'Working lights were installed in two classrooms; learning improvement has not been assessed yet.',
      challenges: words(20),
      challenge_tags: ['⏰ Not enough time'],
      measurable_outcomes: [],
    },
    section6: { use_resources: 'no' },
    section7: { has_partners: 'no' },
    section8: {
      has_evidence: 'no',
      media_visible: 'internal',
      ethical_compliance: ETHICS,
    },
    section9: {
      academic_integration: 'Course-linked assignment',
      skills_grown: ['💬 Communication'],
      reflection_biggest_learning: 'listening',
      reflection_moment: 'day one',
      reflection_discipline_help: 'data tracking',
      personal_learning: words(25),
      academic_application: words(25),
      competency_scores: SCORES,
    },
    section10: {
      continuation_status: 'no',
      continuation_details: words(70),
      mechanisms: ['No continuation mechanism'],
      scaling_potential: 'Not scalable',
      policy_influence: 'No',
    },
    section11: {
      final_declaration: [true, true, true, true, true],
      signature_name: 'Jane Student',
    },
    ...overrides,
  };
}

const issuesOf = (r: ReturnType<typeof report>) =>
  validateReportSectionsForSubmit(r as never).map((i) => i.field);

describe('submit validation — V19 streamlined Section 4', () => {
  it('a V19 report with outputs, a counted reach, a short observed change and no measurable result submits', () => {
    expect(issuesOf(report())).toEqual([]);
  });

  it('"no countable output" is accepted with a reason and rejected without one', () => {
    const base = report();
    const act = base.section4.activity_blocks[0];
    const withReason = report({
      section4: {
        ...base.section4,
        activity_blocks: [
          {
            ...act,
            outputs: [],
            no_output: true,
            no_output_reason: 'Awareness talk only',
          },
        ],
      },
    });
    expect(issuesOf(withReason)).toEqual([]);
    const noReason = report({
      section4: {
        ...base.section4,
        activity_blocks: [
          { ...act, outputs: [], no_output: true, no_output_reason: '' },
        ],
      },
    });
    expect(issuesOf(noReason)).toContain('activity_blocks.0.outputs');
  });

  it('the optional simple measure must be complete once started; legacy detailed outcomes keep their rules', () => {
    const base = report();
    const partial = report({
      section5: {
        ...base.section5,
        measurable_outcomes: [
          {
            simple: true,
            metric: 'Reading score',
            unit: '',
            baseline: '',
            endline: '',
            measurement_explanation: '',
          },
        ],
      },
    });
    const fields = issuesOf(partial);
    expect(fields).toEqual(
      expect.arrayContaining([
        'measurable_outcomes.0.unit',
        'measurable_outcomes.0.baseline',
        'measurable_outcomes.0.endline',
        'measurable_outcomes.0.measurement_explanation',
      ]),
    );
    const complete = report({
      section5: {
        ...base.section5,
        measurable_outcomes: [
          {
            simple: true,
            metric: 'Reading score',
            unit: 'score',
            baseline: '40',
            endline: '55',
            measurement_explanation: 'Assessment sheets',
          },
        ],
      },
    });
    expect(issuesOf(complete)).toEqual([]);
    const legacy = report({
      section5: {
        ...base.section5,
        measurable_outcomes: [
          { outcome_area: 'Health', baseline: '', endline: '' },
        ],
      },
    });
    expect(issuesOf(legacy)).toEqual(
      expect.arrayContaining([
        'measurable_outcomes.0.metric',
        'measurable_outcomes.0.baseline',
      ]),
    );
  });

  it('observed change: 8 words is enough, 7 is not', () => {
    const base = report();
    expect(
      issuesOf(
        report({ section5: { ...base.section5, observed_change: words(8) } }),
      ),
    ).toEqual([]);
    expect(
      issuesOf(
        report({ section5: { ...base.section5, observed_change: words(7) } }),
      ),
    ).toContain('observed_change');
  });
});

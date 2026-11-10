import {
  CII_V4_5_EVALUATOR_PROMPT,
  CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE,
} from './cii-v4-5-prompt.constant';
import { CII_V45_AI_DIMENSIONS } from '../../reports/cii-v4-5.constants';

describe('CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE — per-dimension criterion manifest', () => {
  it.each(CII_V45_AI_DIMENSIONS)(
    'states the exact criterion count and keys for dimension "$id"',
    (dim) => {
      const line = `Dimension "${dim.id}": exactly ${dim.criteria.length} criterionScores — ${dim.criteria
        .map((c) => `"${c.key}"`)
        .join(', ')}.`;
      expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toContain(line);
    },
  );

  it('does not ask the model for Dimension 7 (Admin evidence)', () => {
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(
      /Do NOT return dimension "7"/,
    );
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).not.toContain('Dimension "7":');
  });

  it('warns explicitly that criterionScores count never scales with team size', () => {
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(
      /NEVER one entry per team member/,
    );
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(
      /Omitted criteria are held pending/,
    );
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(/max 25 words/);
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(/Omit claimInventory/);
  });

  it('tells the model not to flag pending attendance verification or live-attendance gates', () => {
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(
      /pending faculty\/partner attendance verification/i,
    );
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(/no separate live-attendance/i);
    expect(CII_V4_5_EVALUATOR_PROMPT).toContain('hoursRequirement');
    expect(CII_V4_5_EVALUATOR_PROMPT).not.toContain('hoursConsistency');
    expect(CII_V4_5_EVALUATOR_PROMPT).not.toContain('hoursCompletion');
    expect(CII_V4_5_EVALUATOR_PROMPT).toContain('sectionAnalyses');
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(/primary\/main SDG/i);
  });
});

describe('CII_V4_5_EVALUATOR_PROMPT — R3 criteria', () => {
  it('names the rubric version and the 38-criterion AI layer', () => {
    expect(CII_V4_5_EVALUATOR_PROMPT).toContain('CIEL-CII-2026.11-R3');
    expect(CII_V4_5_EVALUATOR_PROMPT).toContain('38 criteria');
  });

  it.each(CII_V45_AI_DIMENSIONS)(
    'guides every criterion of dimension "$id" with its exact key and weight',
    (dim) => {
      for (const c of dim.criteria) {
        expect(CII_V4_5_EVALUATOR_PROMPT).toContain(
          `\`${c.key}\` (${c.weight})`,
        );
      }
    },
  );

  it('never lets the model park a report-quality criterion as pending (a pending criterion blocks the CII)', () => {
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(
      /Always give every criterion an integer anchor 0–4/,
    );
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(
      /Never return `P` for a report-quality criterion/,
    );
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(
      /blocks its whole section and the CII/,
    );
    // no instruction anywhere invites pending for "not asked" criteria
    expect(CII_V4_5_EVALUATOR_PROMPT).not.toMatch(
      /did not ask[^.]*return anchor `P`/i,
    );
    expect(CII_V4_5_EVALUATOR_PROMPT).not.toMatch(/anchor `P` \(pending\)/);
  });

  it('judges only what the report form can capture: unasked detail is neutral Sound, never a penalty or a pending hold', () => {
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(
      /Judge only what the CIEL PK report form can capture/,
    );
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(
      /do not punish the student for the form: score it Sound \(2\)/,
    );
    for (const key of [
      'objectiveAttainment',
      'communityConfirmation',
      'evaluationImprovement',
      'competencyDevelopment',
      'needAndVoice',
    ]) {
      expect(CII_V4_5_EVALUATOR_PROMPT).toContain(`\`${key}\``);
    }
  });
});

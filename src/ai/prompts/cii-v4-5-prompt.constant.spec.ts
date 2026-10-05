import { CII_V4_5_EVALUATOR_PROMPT, CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE } from './cii-v4-5-prompt.constant';
import { CII_V45_AI_DIMENSIONS } from '../../reports/cii-v4-5.constants';

describe('CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE — per-dimension criterion manifest', () => {
  it.each(CII_V45_AI_DIMENSIONS)('states the exact criterion count and keys for dimension "$id"', (dim) => {
    const line = `Dimension "${dim.id}": exactly ${dim.criteria.length} criterionScores — ${dim.criteria
      .map((c) => `"${c.key}"`)
      .join(', ')}.`;
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toContain(line);
  });

  it('does not ask the model for Dimension 7 (Admin evidence)', () => {
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(/Do NOT return dimension "7"/);
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).not.toContain('Dimension "7":');
  });

  it('warns explicitly that criterionScores count never scales with team size', () => {
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(/NEVER one entry per team member/);
  });

  it('tells the model not to flag pending attendance verification or live-attendance gates', () => {
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(/pending faculty\/partner attendance verification/i);
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(/no separate live-attendance/i);
    expect(CII_V4_5_EVALUATOR_PROMPT).toContain('hoursCompletion');
    expect(CII_V4_5_EVALUATOR_PROMPT).not.toContain('hoursConsistency');
    expect(CII_V4_5_EVALUATOR_PROMPT).toContain('sectionAnalyses');
    expect(CII_V4_5_EVALUATOR_PROMPT).toMatch(/primary\/main SDG/i);
  });
});

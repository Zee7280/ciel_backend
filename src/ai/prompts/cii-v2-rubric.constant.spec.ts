import {
  buildCiiV2EvaluatorPrompt,
  CII_V2_RUBRIC_VERSION,
} from './cii-v2-rubric.constant';

describe('Admin AI Analyzer live prompt', () => {
  const prompt = buildCiiV2EvaluatorPrompt();

  it('uses Balanced CII v3.1', () => {
    expect(CII_V2_RUBRIC_VERSION).toBe('v3.1-balanced');
    expect(prompt).toContain(
      'Balanced Composite Impact Index (CII) Rubric v3.1',
    );
    expect(prompt).toContain('TEN evaluation sections');
    expect(prompt).toContain('Outcomes & Measured Change');
    expect(prompt).toContain('framework_version": "v3.1-balanced"');
  });

  it('does not keep the previous 9-section v2 prompt', () => {
    expect(prompt).not.toContain('CII Rubric v2');
    expect(prompt).not.toContain('You are the CIEL PK AI Evaluator v8.2');
    expect(prompt).not.toContain(
      'Execution, Outputs & Outcomes · What We Did → What Changed',
    );
    expect(prompt).not.toContain('Participation Quality & Individual Commitment');
  });
});

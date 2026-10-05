import { CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE } from './cii-v4-5-prompt.constant';
import { CII_V45_DIMENSIONS } from '../../reports/cii-v4-5.constants';

describe('CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE — per-dimension criterion manifest', () => {
  // Guards the production bug where the AI returned the wrong criterionScores count for
  // Dimension 1 (likely reading its per-student anchor wording as "one row per team member").
  // This asserts the prompt explicitly states the exact count/keys for every dimension, generated
  // from the same `CII_V45_DIMENSIONS` table `computeCiiV45Result` validates against — so the
  // prompt and the validator can never silently drift apart.
  it.each(CII_V45_DIMENSIONS)('states the exact criterion count and keys for dimension "$id"', (dim) => {
    const line = `Dimension "${dim.id}": exactly ${dim.criteria.length} criterionScores — ${dim.criteria
      .map((c) => `"${c.key}"`)
      .join(', ')}.`;
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toContain(line);
  });

  it('warns explicitly that criterionScores count never scales with team size', () => {
    expect(CII_V4_5_JSON_ONLY_DEPLOYMENT_NOTE).toMatch(/NEVER one entry per team member/);
  });
});

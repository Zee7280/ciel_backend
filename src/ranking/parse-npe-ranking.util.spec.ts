import { parseNpeRankingResponse } from './parse-npe-ranking.util';
import { NPE_CRITERION_KEYS } from './npe-ranking.constants';

describe('parseNpeRankingResponse', () => {
  it('accepts a complete evaluation and rejects a guessed score without claims', () => {
    const criteria = Object.fromEntries(
      NPE_CRITERION_KEYS.map((k) => [
        k,
        { anchor: 4, confidence: 'high', reason: 'ok', claimIds: [`${k}-1`] },
      ]),
    );
    const claims = NPE_CRITERION_KEYS.map((k) => ({
      id: `${k}-1`,
      criterion: k,
      statement: 'claim',
      source: 'report',
      locator: 'S4',
      support: 'high',
      limitation: 'small n',
    }));
    const ok = parseNpeRankingResponse(
      JSON.stringify({
        projectId: 'r1',
        packageVersion: 'v1',
        readComplete: true,
        flags: [],
        summary: 'Change documented.',
        limitations: 'Small sample.',
        criteria,
        claims,
      }),
    );
    expect(ok?.projectId).toBe('r1');

    const guessed = JSON.parse(JSON.stringify(ok)) as {
      criteria: { impact: { claimIds: string[] } };
    };
    guessed.criteria.impact.claimIds = [];
    expect(parseNpeRankingResponse(JSON.stringify(guessed))).toBeNull();
  });

  it('reads a confidence level the model wrapped in an array, and rejects a non-level', () => {
    const build = (confidence: unknown, support: unknown) =>
      JSON.stringify({
        projectId: 'r1',
        packageVersion: 'v1',
        readComplete: true,
        flags: [],
        summary: 'Change documented.',
        limitations: 'Small sample.',
        criteria: Object.fromEntries(
          NPE_CRITERION_KEYS.map((k) => [
            k,
            { anchor: 4, confidence, reason: 'ok', claimIds: [`${k}-1`] },
          ]),
        ),
        claims: NPE_CRITERION_KEYS.map((k) => ({
          id: `${k}-1`,
          criterion: k,
          statement: 'claim',
          source: 'report',
          locator: 'S4',
          support,
          limitation: 'small n',
        })),
      });
    expect(
      parseNpeRankingResponse(build(['High '], ['moderate'])),
    ).not.toBeNull();
    expect(parseNpeRankingResponse(build(4, 'high'))).toBeNull();
    expect(
      parseNpeRankingResponse(build({ level: 'high' }, 'high')),
    ).toBeNull();
  });
});

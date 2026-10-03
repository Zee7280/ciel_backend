import { parseCiiV2Response } from './parse-cii-v2.util';
import { CII_V2_SECTIONS } from '../reports/cii-v2.constants';

function fullResponse() {
  return {
    framework_version: 'v3.1-balanced',
    sections: CII_V2_SECTIONS.map((s) => ({
      id: s.id,
      good: 'ok',
      limit: 'ok',
      criteria: s.criteria.map((c) => ({
        key: c.key,
        anchor: 4,
        note: 'because',
      })),
    })),
    extraMileUplift: {
      extra_effort: { amount: 1.25 },
      resource_mobilization: { amount: 1.25 },
      partnership_building: { amount: 1.25 },
      exceptional_outcome: { amount: 1.25 },
    },
    integrityPenalty: { amount: 0, why: '' },
    evidence: [],
    redFlags: [],
    needsAdminReview: false,
    studentFeedback: 'Great work.',
  };
}

describe('parseCiiV2Response', () => {
  it('parses a complete, well-formed response with no parsing red flags', () => {
    const result = parseCiiV2Response(JSON.stringify(fullResponse()));

    expect(result).not.toBeNull();
    expect(result!.frameworkVersion).toBe('v3.1-balanced');
    expect(result!.bonus).toEqual({
      effort: 1.25,
      resources: 1.25,
      partners: 1.25,
      outcome: 1.25,
    });
    expect(result!.redFlags).toEqual([]);
    expect(result!.needsAdminReview).toBe(false);
    expect(
      result!.sections
        .find((s) => s.id === 4)!
        .criteria.every((c) => c.anchor === 4),
    ).toBe(true);
  });

  it('raises a visible red flag and forces admin review when the AI omits an entire section', () => {
    const response = fullResponse();
    response.sections = response.sections.filter((s) => s.id !== 4);

    const result = parseCiiV2Response(JSON.stringify(response));

    expect(result).not.toBeNull();
    expect(
      result!.sections
        .find((s) => s.id === 4)!
        .criteria.every((c) => c.anchor === 0),
    ).toBe(true);
    expect(result!.redFlags.some((f) => f.includes('Section 4'))).toBe(true);
    expect(result!.needsAdminReview).toBe(true);
  });

  it('raises a visible red flag when a section is present but missing individual criteria', () => {
    const response = fullResponse();
    const section4 = response.sections.find((s) => s.id === 4)!;
    section4.criteria = section4.criteria.filter(
      (c) => c.key !== 'planned_vs_actual',
    );

    const result = parseCiiV2Response(JSON.stringify(response));

    expect(result).not.toBeNull();
    const plannedVsActual = result!.sections
      .find((s) => s.id === 4)!
      .criteria.find((c) => c.key === 'planned_vs_actual')!;
    expect(plannedVsActual.anchor).toBe(0);
    expect(
      result!.redFlags.some((f) => f.includes('planned_vs_actual')),
    ).toBe(true);
    expect(result!.needsAdminReview).toBe(true);
  });
});

describe('parseCiiV2Response — claim–evidence verdicts', () => {
  const withEvidence = (evidence: unknown[], extra: Record<string, unknown> = {}) =>
    parseCiiV2Response(JSON.stringify({ ...fullResponse(), evidence, ...extra }))!;

  it('keeps explicit claimSupport and adds the UNRELATED flag + wording to unsupported rows', () => {
    const r = withEvidence([
      { id: 'E1', file: 'a.jpg', claim: '120 children served', match: 20, verdict: 'MISMATCH', claimSupport: 'contradicted', why: 'Photo shows an empty room.' },
      { id: 'CLAIM-1', file: '(no file attached)', claim: 'Attendance rose 55 to 82', match: 0, verdict: 'MISMATCH', why: '' },
    ]).evidence;
    expect(r[0]).toMatchObject({ claimSupport: 'contradicted', flag: 'UNRELATED / DOES NOT SUPPORT CLAIM' });
    expect(r[0].why).toBe('UNRELATED / DOES NOT SUPPORT CLAIM: Photo shows an empty room.');
    expect(r[1].claimSupport).toBe('unsupported');
    expect(r[1].why).toMatch(/^UNRELATED \/ DOES NOT SUPPORT CLAIM:/);
  });

  it('does not double-prefix a why that already starts with the wording', () => {
    const r = withEvidence([{ id: 'E', file: 'f', claim: 'c', match: 10, verdict: 'MISMATCH', why: 'UNRELATED / DOES NOT SUPPORT CLAIM: unrelated photo' }]).evidence[0];
    expect(r.why).toBe('UNRELATED / DOES NOT SUPPORT CLAIM: unrelated photo');
  });

  it('derives the claim support from the verdict when the model omits it; supported rows carry no flag', () => {
    const r = withEvidence([
      { id: 'A', file: 'a', claim: 'c', match: 92, verdict: 'MATCH', why: 'clear' },
      { id: 'B', file: 'b', claim: 'c', match: 60, verdict: 'PARTIAL', why: 'some' },
    ]).evidence;
    expect(r[0]).toMatchObject({ claimSupport: 'supported' });
    expect(r[0].flag).toBeUndefined();
    expect(r[1]).toMatchObject({ claimSupport: 'partially_supported' });
  });

  it('an unknown verdict is derived from the numeric match instead of being softened to PARTIAL', () => {
    const r = withEvidence([
      { id: 'A', file: 'a', claim: 'c', match: 10, verdict: 'unrelated', why: 'x' },
      { id: 'B', file: 'b', claim: 'c', match: 90, verdict: '???', why: 'y' },
      { id: 'C', file: 'c', claim: 'c', match: 60, why: 'z' },
    ]).evidence;
    expect(r.map((x) => x.verdict)).toEqual(['MISMATCH', 'MATCH', 'PARTIAL']);
  });

  it('a MISMATCH can never read "supported" (and a MATCH never "unsupported")', () => {
    const r = withEvidence([
      { id: 'A', file: 'a', claim: 'c', match: 10, verdict: 'MISMATCH', claimSupport: 'supported', why: 'x' },
      { id: 'B', file: 'b', claim: 'c', match: 95, verdict: 'MATCH', claimSupport: 'unsupported', why: 'y' },
    ]).evidence;
    expect(r[0].claimSupport).toBe('unsupported');
    expect(r[1].claimSupport).toBe('partially_supported');
  });
});

describe('parseCiiV2Response — score guard rails', () => {
  it('caps a runaway integrity penalty', () => {
    const r = parseCiiV2Response(JSON.stringify({ ...fullResponse(), integrityPenalty: { amount: 500, why: 'x' } }))!;
    expect(r.integrityPenalty).toBe(30);
    expect(parseCiiV2Response(JSON.stringify({ ...fullResponse(), integrityPenalty: -5 }))!.integrityPenalty).toBe(0);
  });

  it('flags a run that skipped rubric sections as incomplete (must be re-run, not locked)', () => {
    const complete = parseCiiV2Response(JSON.stringify(fullResponse()))!;
    expect(complete.incomplete).toBe(false);
    const partial = fullResponse();
    partial.sections = partial.sections.slice(0, 3);
    const r = parseCiiV2Response(JSON.stringify(partial))!;
    expect(r.incomplete).toBe(true);
    expect(r.needsAdminReview).toBe(true);
  });
});

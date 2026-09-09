import { parseCiiV2Response } from './parse-cii-v2.util';
import { CII_V2_SECTIONS } from '../reports/cii-v2.constants';

function fullResponse() {
  return {
    framework_version: 'v2.0',
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
    bonus: {
      effort: { amount: 2 },
      resources: { amount: 2 },
      partners: { amount: 2 },
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
      (c) => c.key !== 'measurable_outcomes',
    );

    const result = parseCiiV2Response(JSON.stringify(response));

    expect(result).not.toBeNull();
    const measurableOutcomes = result!.sections
      .find((s) => s.id === 4)!
      .criteria.find((c) => c.key === 'measurable_outcomes')!;
    expect(measurableOutcomes.anchor).toBe(0);
    expect(
      result!.redFlags.some((f) => f.includes('measurable_outcomes')),
    ).toBe(true);
    expect(result!.needsAdminReview).toBe(true);
  });
});

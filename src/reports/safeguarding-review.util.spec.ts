import { safeguardingReviewNotes } from './safeguarding-review.util';

const codes = (block: Record<string, unknown> | null | undefined) =>
  safeguardingReviewNotes(block).map((n) => n.code);

describe('safeguardingReviewNotes (V19 item 13)', () => {
  it('flags a blank block and nothing else', () => {
    expect(codes(undefined)).toEqual(['block_blank']);
    expect(codes({})).toEqual(['block_blank']);
    expect(codes({ risk_factors: ['none'] })).toEqual([]);
  });

  it('flags incomplete and inconsistent answers', () => {
    expect(codes({ risk_factors: ['children_present'] })).toEqual([
      'fields_missing',
      'consent_missing_sensitive',
    ]);
    expect(
      codes({
        risk_factors: ['beneficiary_photos'],
        risk_mitigation: 'x',
        risk_consent: 'not_obtained',
        risk_safeguarding_lead: 'Ms A',
      }),
    ).toEqual(['consent_not_obtained_sensitive']);
    expect(
      codes({
        risk_factors: ['personal_data'],
        risk_mitigation: 'x',
        risk_consent: 'not_applicable',
        risk_safeguarding_lead: 'Ms A',
      }),
    ).toEqual(['consent_not_applicable_sensitive']);
    expect(
      codes({ risk_factors: ['none'], risk_unresolved: 'Roof still unsafe' }),
    ).toEqual(['none_but_details', 'unresolved_risks']);
  });

  it('a complete block only carries the student-reported consent note', () => {
    const notes = safeguardingReviewNotes({
      risk_factors: ['physical_work'],
      risk_mitigation: 'Helmets and a contractor for heights',
      risk_consent: 'written',
      risk_safeguarding_lead: 'Mr B, site supervisor',
    });
    expect(notes.map((n) => [n.level, n.code])).toEqual([
      ['info', 'consent_student_reported'],
    ]);
    expect(notes[0].message).toContain('not independently verified');
  });
});

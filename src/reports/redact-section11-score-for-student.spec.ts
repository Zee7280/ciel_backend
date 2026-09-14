import { StudentReportsService } from './student-reports.service';

const redact = (StudentReportsService as any).redactSection11ScoreForStudent.bind(
  StudentReportsService,
);

const PENDING_RESPONSE = {
  success: true,
  data: {
    status: 'submitted',
    faculty_status: 'pending',
    section11: {
      ai_generated_impact_score: 92,
      institutional_alignment_score: 88,
      verified_narrative: 'A glowing AI narrative.',
      summary_text: "Section 11 audit: strong evidence base.",
      audit_meta: { risk_level: 'low' },
    },
  },
};

describe('StudentReportsService.redactSection11ScoreForStudent', () => {
  it('strips the AI-only score/narrative fields before Faculty has approved', () => {
    const result = redact(PENDING_RESPONSE);

    expect(result.data.section11).not.toHaveProperty('ai_generated_impact_score');
    expect(result.data.section11).not.toHaveProperty('institutional_alignment_score');
    expect(result.data.section11).not.toHaveProperty('verified_narrative');
    // The student's own self-audit text (from the wizard's Section 11 step) stays intact.
    expect(result.data.section11.summary_text).toBe(
      'Section 11 audit: strong evidence base.',
    );
    expect(result.data.section11.audit_meta).toEqual({ risk_level: 'low' });
  });

  it('exposes the full section11, including the score, once Faculty has approved', () => {
    const approved = {
      ...PENDING_RESPONSE,
      data: { ...PENDING_RESPONSE.data, faculty_status: 'approved' },
    };

    const result = redact(approved);

    expect(result.data.section11.ai_generated_impact_score).toBe(92);
    expect(result.data.section11.institutional_alignment_score).toBe(88);
    expect(result.data.section11.verified_narrative).toBe(
      'A glowing AI narrative.',
    );
  });

  it('passes through responses with no section11 untouched', () => {
    const response = { success: true, data: { status: 'draft' } };
    expect(redact(response)).toBe(response);
  });
});

const stripWritable = (StudentReportsService.prototype as any).stripStudentWritableSection11;

describe('StudentReportsService.stripStudentWritableSection11', () => {
  it('drops the AI-only score/narrative fields from a client-submitted section11 payload', () => {
    const result = stripWritable({
      ai_generated_impact_score: 100,
      institutional_alignment_score: 100,
      verified_narrative: 'forged',
      summary_text: 'my self-audit',
      audit_meta: { risk_level: 'low' },
    });

    expect(result).not.toHaveProperty('ai_generated_impact_score');
    expect(result).not.toHaveProperty('institutional_alignment_score');
    expect(result).not.toHaveProperty('verified_narrative');
    expect(result.summary_text).toBe('my self-audit');
    expect(result.audit_meta).toEqual({ risk_level: 'low' });
  });

  it('returns undefined for a non-object payload', () => {
    expect(stripWritable(null)).toBeUndefined();
    expect(stripWritable('not an object')).toBeUndefined();
  });
});

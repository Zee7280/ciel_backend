import { FeedbackService } from './feedback.service';

function build(
  existing: Array<{ userId: string; reportId: string | null }> = [],
) {
  const saved: Record<string, unknown>[] = [];
  const cepRepo = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn((row: Record<string, unknown>) => {
      saved.push(row);
      return Promise.resolve({ ...row, id: 'fb-1' });
    }),
    count: jest.fn(
      ({ where }: { where: { userId: string; reportId: string } }) =>
        Promise.resolve(
          existing.filter(
            (r) => r.userId === where.userId && r.reportId === where.reportId,
          ).length,
        ),
    ),
  };
  const service = new FeedbackService(cepRepo as never, {} as never);
  return { service, saved, cepRepo };
}

describe('FeedbackService result-package feedback', () => {
  it('stores the report id and marks the submission as the result-package survey', async () => {
    const { service, saved } = build();
    const out = await service.submitCepExperience('stu-1', 'student', {
      overallRating: 5,
      sectionsEase: 'easy',
      reflectImpact: 'yes',
      mostUsefulText: '  the guide  ',
      reportId: 'rep-9',
    });
    expect(out).toEqual({ success: true, id: 'fb-1' });
    expect(saved[0]).toMatchObject({
      userId: 'stu-1',
      reportId: 'rep-9',
      surveyVersion: 'cep_result_v1',
      mostUsefulText: 'the guide',
    });
  });

  it('the older general prompt keeps its version and no report id', async () => {
    const { service, saved } = build();
    await service.submitCepExperience('stu-1', 'student', {
      overallRating: 4,
      sectionsEase: 'neutral',
      reflectImpact: 'partially',
    });
    expect(saved[0]).toMatchObject({
      reportId: null,
      surveyVersion: 'cep_report_v1',
    });
  });

  it('hasSubmittedForReport is per user and per report', async () => {
    const { service } = build([{ userId: 'stu-1', reportId: 'rep-9' }]);
    expect(await service.hasSubmittedForReport('stu-1', 'rep-9')).toBe(true);
    expect(await service.hasSubmittedForReport('stu-1', 'rep-8')).toBe(false);
    expect(await service.hasSubmittedForReport('stu-2', 'rep-9')).toBe(false);
    expect(await service.hasSubmittedForReport('stu-1', '')).toBe(false);
  });
});

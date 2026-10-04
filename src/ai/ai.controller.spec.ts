import { ForbiddenException } from '@nestjs/common';
import { AiController } from './ai.controller';

describe('AiController.summarize — evaluator sections are CIEL PK Admin only', () => {
  const ai = { summarize: jest.fn().mockResolvedValue({ summary: 'ok' }) };
  const controller = new AiController(ai as any);
  const as = (role: string) => ({ user: { id: 'u1', role } });

  beforeEach(() => ai.summarize.mockClear());

  it.each(['cii_v2_evaluation', 'fyp_ai_evaluation'])(
    'refuses %s for student / faculty / ngo',
    async (section) => {
      for (const role of ['student', 'faculty', 'ngo', 'university', 'corporate']) {
        await expect(controller.summarize(as(role), { section, data: {} } as any)).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(ai.summarize).not.toHaveBeenCalled();
    },
  );

  it('allows evaluator sections for the admin', async () => {
    await expect(controller.summarize(as('admin'), { section: 'cii_v2_evaluation', data: { x: 1 } } as any)).resolves.toEqual({ summary: 'ok' });
    expect(ai.summarize).toHaveBeenCalledWith('cii_v2_evaluation', { x: 1 });
  });

  it('still allows the student wizard summary section', async () => {
    await expect(controller.summarize(as('student'), { section: 'section11', data: {} } as any)).resolves.toBeTruthy();
  });
});

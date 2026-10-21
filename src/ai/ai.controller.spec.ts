import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../users/enums/user-role.enum';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

describe('AiController.summarize — evaluator sections are CIEL PK Admin only', () => {
  const ai = { summarize: jest.fn().mockResolvedValue({ summary: 'ok' }) };
  const controller = new AiController(ai as unknown as AiService);
  const as = (role: string) => ({ user: { id: 'u1', role: role as UserRole } });

  beforeEach(() => ai.summarize.mockClear());

  it.each(['cii_v4_5_evaluation', 'fyp_ai_evaluation'])(
    'refuses %s for student / faculty / ngo',
    async (section) => {
      for (const role of [
        'student',
        'faculty',
        'ngo',
        'university',
        'corporate',
      ]) {
        await expect(
          controller.summarize(as(role), { section, data: {} }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(ai.summarize).not.toHaveBeenCalled();
    },
  );

  it('allows evaluator sections for the admin', async () => {
    await expect(
      controller.summarize(as('admin'), {
        section: 'cii_v4_5_evaluation',
        data: { x: 1 },
      }),
    ).resolves.toEqual({ summary: 'ok' });
    expect(ai.summarize).toHaveBeenCalledWith('cii_v4_5_evaluation', { x: 1 });
  });

  it('still allows the student wizard summary section', async () => {
    await expect(
      controller.summarize(as('student'), {
        section: 'section11',
        data: {},
      }),
    ).resolves.toBeTruthy();
  });
});

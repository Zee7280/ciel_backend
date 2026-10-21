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

describe('AiController.opportunityDraft — roles and feature flag', () => {
  const draft = { fields: { title: 'T' }, model: 'm' };
  const make = (enabled: boolean | null) => {
    const ai = { generateOpportunityDraft: jest.fn().mockResolvedValue(draft) };
    const settings =
      enabled === null
        ? undefined
        : { isAiOpportunityDraftEnabled: jest.fn().mockResolvedValue(enabled) };
    const controller = new AiController(
      ai as unknown as AiService,
      settings as never,
    );
    return { ai, controller };
  };
  const as = (role: string) => ({ user: { id: 'u1', role: role as UserRole } });
  const body = { idea: 'tree plantation' };

  it('drafts for students, faculty and admin when the flag is on', async () => {
    const { ai, controller } = make(true);
    for (const role of ['student', 'faculty', 'admin']) {
      await expect(
        controller.opportunityDraft(as(role), body),
      ).resolves.toEqual({ success: true, data: draft });
    }
    expect(ai.generateOpportunityDraft).toHaveBeenCalledWith(body);
  });

  it('refuses other roles', async () => {
    const { ai, controller } = make(true);
    for (const role of ['ngo', 'university', 'corporate']) {
      await expect(
        controller.opportunityDraft(as(role), body),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(ai.generateOpportunityDraft).not.toHaveBeenCalled();
  });

  it('is unavailable while the flag is off or settings are missing', async () => {
    for (const enabled of [false, null]) {
      const { ai, controller } = make(enabled);
      await expect(
        controller.opportunityDraft(as('student'), body),
      ).rejects.toMatchObject({ status: 503 });
      expect(ai.generateOpportunityDraft).not.toHaveBeenCalled();
    }
  });
});

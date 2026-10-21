import { PlatformSettingsService } from './platform-settings.service';

describe('PlatformSettingsService', () => {
  const makeRepo = (value: string | null | Error) => ({
    findOne: jest.fn((): Promise<{ value: string } | null> => {
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value === null ? null : { value });
    }),
  });

  it('defaults: maintenance off, registration on', async () => {
    const svc = new PlatformSettingsService(makeRepo(null) as never);
    expect(await svc.isMaintenanceMode()).toBe(false);
    expect(await svc.isRegistrationAllowed()).toBe(true);
  });

  it('parses stored booleans and caches reads', async () => {
    const repo = makeRepo('true');
    const svc = new PlatformSettingsService(repo as never);
    expect(await svc.isMaintenanceMode()).toBe(true);
    await svc.isMaintenanceMode();
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    svc.invalidate();
    await svc.isMaintenanceMode();
    expect(repo.findOne).toHaveBeenCalledTimes(2);
  });

  it('keeps private teams off until an admin enables them, and exposes the flag publicly', async () => {
    const off = new PlatformSettingsService(makeRepo(null) as never);
    expect(await off.isPrivateTeamEnabled()).toBe(false);
    expect((await off.getPublicConfig()).student_private_team_enabled).toBe(
      false,
    );
    const on = new PlatformSettingsService(makeRepo('true') as never);
    expect(await on.isPrivateTeamEnabled()).toBe(true);
    expect((await on.getPublicConfig()).student_private_team_enabled).toBe(
      true,
    );
  });

  it('advertises AI drafting only when the flag is on AND an OpenAI key exists', async () => {
    const realKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = 'sk-test';
      const on = new PlatformSettingsService(makeRepo('true') as never);
      expect(await on.isAiOpportunityDraftEnabled()).toBe(true);
      expect((await on.getPublicConfig()).student_ai_draft_enabled).toBe(true);
      const off = new PlatformSettingsService(makeRepo(null) as never);
      expect((await off.getPublicConfig()).student_ai_draft_enabled).toBe(
        false,
      );
      delete process.env.OPENAI_API_KEY;
      const noKey = new PlatformSettingsService(makeRepo('true') as never);
      expect((await noKey.getPublicConfig()).student_ai_draft_enabled).toBe(
        false,
      );
    } finally {
      if (realKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = realKey;
    }
  });

  it('never throws when the settings table is unreadable', async () => {
    const svc = new PlatformSettingsService(
      makeRepo(new Error('db down')) as never,
    );
    expect(await svc.isMaintenanceMode()).toBe(false);
  });
});

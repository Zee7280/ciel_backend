import { PlatformSettingsService } from './platform-settings.service';

describe('PlatformSettingsService', () => {
  const makeRepo = (value: string | null | Error) => ({
    findOne: jest.fn(async () => {
      if (value instanceof Error) throw value;
      return value === null ? null : { value };
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

  it('never throws when the settings table is unreadable', async () => {
    const svc = new PlatformSettingsService(makeRepo(new Error('db down')) as never);
    expect(await svc.isMaintenanceMode()).toBe(false);
  });
});

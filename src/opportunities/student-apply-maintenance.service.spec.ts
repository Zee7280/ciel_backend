import { StudentApplyMaintenanceService } from './student-apply-maintenance.service';
import { parseClosedBeforeSettingValue } from './student-apply-maintenance.util';

describe('StudentApplyMaintenanceService expiry toggle', () => {
  const build = (rows: Array<{ key: string; value: string }>) => {
    const repo: any = {
      find: jest.fn(async () => rows),
      findOne: jest.fn(async ({ where }: any) =>
        rows.find((r) => r.key === where.key) ?? null,
      ),
      create: jest.fn((v: any) => v),
      save: jest.fn(async (v: any) => {
        rows.push(v);
        return v;
      }),
    };
    return { repo, service: new StudentApplyMaintenanceService(repo) };
  };

  it("parses 'disabled' and empty as no cutoff", () => {
    expect(parseClosedBeforeSettingValue('disabled')).toBeNull();
    expect(parseClosedBeforeSettingValue('')).toBeNull();
    expect(parseClosedBeforeSettingValue('2026-01-01T00:00:00Z')).toBeInstanceOf(Date);
  });

  it('keeps expiry off after cache refresh and never seeds over a disabled row', async () => {
    const { repo, service } = build([
      { key: 'STUDENT_APPLY_CLOSED_BEFORE', value: 'disabled' },
    ]);
    expect((await service.getState()).closedBefore).toBeNull();
    service.invalidateCache();
    expect((await service.getState()).closedBefore).toBeNull();
    await service.seedClosedBeforeIfMissing();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('seeds exactly once when the row is missing', async () => {
    const { repo, service } = build([]);
    await service.seedClosedBeforeIfMissing();
    await service.seedClosedBeforeIfMissing();
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect((await service.getState()).closedBefore).toBeInstanceOf(Date);
  });

  it('getState itself never seeds', async () => {
    const { repo, service } = build([]);
    await service.getState();
    expect(repo.save).not.toHaveBeenCalled();
  });
});

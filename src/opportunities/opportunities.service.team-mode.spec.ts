import { BadRequestException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import type { PlatformSettingsService } from '../settings/platform-settings.service';

type ServiceArgs = ConstructorParameters<typeof OpportunitiesService>;

/** Only `platformSettings` (the optional last argument) is used by assertStudentTeamMode. */
function makeService(privateTeamEnabled: boolean | null) {
  const args = new Array<unknown>(11).fill({});
  if (privateTeamEnabled !== null) {
    args.push({
      isPrivateTeamEnabled: jest.fn().mockResolvedValue(privateTeamEnabled),
    } as unknown as PlatformSettingsService);
  }
  return new OpportunitiesService(...(args as ServiceArgs));
}

const seats = (n: unknown) => ({ volunteers_required: n });

describe('OpportunitiesService.assertStudentTeamMode', () => {
  it('stores null when nothing is chosen (legacy open behaviour)', async () => {
    const service = makeService(false);
    for (const value of [undefined, null, '']) {
      await expect(
        service.assertStudentTeamMode(value, seats(500), {
          requireSeats: true,
        }),
      ).resolves.toBeNull();
    }
  });

  it('allows open with any seat count while the feature is on', async () => {
    await expect(
      makeService(true).assertStudentTeamMode('open', seats(5000), {
        requireSeats: true,
      }),
    ).resolves.toBe('open');
  });

  it('keeps legacy rules (null) when a client sends open while the feature is off', async () => {
    for (const service of [makeService(false), makeService(null)]) {
      await expect(
        service.assertStudentTeamMode('open', seats(50), {
          requireSeats: true,
          previous: null,
        }),
      ).resolves.toBeNull();
    }
    // An already-open listing keeps its mode when the feature is later switched off.
    await expect(
      makeService(false).assertStudentTeamMode('open', seats(50), {
        requireSeats: true,
        previous: 'open',
      }),
    ).resolves.toBe('open');
  });

  it('lets an existing private team switch to open after the feature is off (stored as legacy null)', async () => {
    await expect(
      makeService(false).assertStudentTeamMode('open', seats(50), {
        requireSeats: true,
        previous: 'private_team',
      }),
    ).resolves.toBeNull();
  });

  it('rejects unknown values (the draft / edit bodies are not DTO-validated)', async () => {
    await expect(
      makeService(true).assertStudentTeamMode('private', seats(5), {
        requireSeats: true,
      }),
    ).rejects.toThrow(/team_mode must be one of/);
  });

  it('refuses a NEW private team while the feature flag is off (or the settings service is absent)', async () => {
    for (const service of [makeService(false), makeService(null)]) {
      await expect(
        service.assertStudentTeamMode('private_team', seats(5), {
          requireSeats: true,
          previous: null,
        }),
      ).rejects.toThrow(/not available yet/);
    }
  });

  it('keeps an existing private team editable after the flag is switched off', async () => {
    await expect(
      makeService(false).assertStudentTeamMode('private_team', seats(5), {
        requireSeats: true,
        previous: 'private_team',
      }),
    ).resolves.toBe('private_team');
  });

  it('enforces 1–20 seats on submit but not on a partial draft', async () => {
    const service = makeService(true);
    await expect(
      service.assertStudentTeamMode('private_team', seats(20), {
        requireSeats: true,
      }),
    ).resolves.toBe('private_team');
    await expect(
      service.assertStudentTeamMode('private_team', seats(21), {
        requireSeats: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.assertStudentTeamMode('private_team', null, {
        requireSeats: false,
      }),
    ).resolves.toBe('private_team');
  });
});

import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { PathsController } from './paths.controller';
import type { PathsService } from './paths.service';
import type { S3Service } from '../common/s3.service';
import type { VentureInvestorSignalsService } from './venture-investor-signals.service';

describe('PathsController — faculty FYP (own record)', () => {
  const pathsService = {
    updateFypByIdForUser: jest.fn().mockResolvedValue({ id: 'f1' }),
    selfCertifyOwnFyp: jest.fn().mockResolvedValue({ id: 'f1' }),
  };
  const controller = new PathsController(
    pathsService as unknown as PathsService,
    {} as S3Service,
    {} as VentureInvestorSignalsService,
  );
  const req = (role: UserRole) =>
    ({
      user: { id: 'u1', email: 'u1@uni.edu', role, organizationId: '' },
    }) as never;
  const ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => jest.clearAllMocks());

  it('opens the own-FYP deck to faculty; self-certify is faculty-only', () => {
    const reflector = new Reflector();
    const rolesOf = (name: keyof PathsController) =>
      reflector.get<UserRole[]>(ROLES_KEY, PathsController.prototype[name]);
    for (const name of [
      'listFyps',
      'createFyp',
      'getFypById',
      'updateFypById',
      'deleteFypById',
      'addFypDeliverableById',
      'removeFypDeliverableById',
    ] as const) {
      expect(rolesOf(name)).toEqual([UserRole.STUDENT, UserRole.FACULTY]);
    }
    expect(rolesOf('selfCertifyOwnFyp')).toEqual([UserRole.FACULTY]);
    // The legacy singleton routes stay student-only.
    expect(rolesOf('getFyp')).toEqual([UserRole.STUDENT]);
    expect(rolesOf('updateFyp')).toEqual([UserRole.STUDENT]);
  });

  it('a faculty FYP cannot be submitted into a review queue; a student still submits', async () => {
    await expect(
      controller.updateFypById(req(UserRole.FACULTY), ID, {
        status: 'submitted',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pathsService.updateFypByIdForUser).not.toHaveBeenCalled();

    await controller.updateFypById(req(UserRole.FACULTY), ID, {
      projectTitle: 'Draft edit',
    } as never);
    await controller.updateFypById(req(UserRole.STUDENT), ID, {
      status: 'submitted',
    } as never);
    expect(pathsService.updateFypByIdForUser).toHaveBeenCalledTimes(2);
  });

  it('self-certify passes the caller and the record id', async () => {
    await controller.selfCertifyOwnFyp(req(UserRole.FACULTY), ID);
    expect(pathsService.selfCertifyOwnFyp).toHaveBeenCalledWith('u1', ID);
  });
});

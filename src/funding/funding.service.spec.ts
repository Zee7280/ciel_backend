import { ForbiddenException } from '@nestjs/common';
import { FundingService } from './funding.service';

describe('FundingService — organization scoping', () => {
  const build = () => {
    const applications = {
      find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };
    const opportunities = {
      findOne: jest.fn().mockResolvedValue({ id: 'fund-1' }),
    };
    const svc = new FundingService(
      opportunities as never,
      applications as never,
    );
    return { svc, applications };
  };

  it('returns no applications for a login without an organization (not every org’s)', async () => {
    const { svc, applications } = build();
    await expect(
      svc.getApplications(undefined as unknown as string),
    ).resolves.toEqual([]);
    expect(applications.find).not.toHaveBeenCalled();
  });

  it('scopes the list to the caller’s organization', async () => {
    const { svc, applications } = build();
    await svc.getApplications('org-1');
    expect(applications.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    );
  });

  it('refuses to create an application without an organization', async () => {
    const { svc, applications } = build();
    await expect(
      svc.createApplication(
        undefined as unknown as string,
        {
          fundingId: 'fund-1',
        } as never,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(applications.save).not.toHaveBeenCalled();
  });
});

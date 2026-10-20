import { OpportunityApplicationsService } from './opportunity-applications.service';

function build(
  over: { appRepo?: any; userRepo?: any; opportunityRepo?: any } = {},
) {
  const args: any[] = new Array(11).fill({});
  args[0] = over.appRepo ?? {};
  args[1] = over.opportunityRepo ?? {};
  args[3] = over.userRepo ?? {};
  return new (OpportunityApplicationsService as any)(...args);
}

describe('ensureSeatsForApprovedStudent', () => {
  it('provisions the lead own approved application', async () => {
    const svc = build({
      userRepo: {
        findOne: jest.fn().mockResolvedValue({ id: 's1', email: 'S1@x.pk' }),
      },
      appRepo: {
        find: jest.fn().mockResolvedValue([
          { id: 'a1', studentUserId: 's1', applyPayload: {} },
          { id: 'a2', studentUserId: 'other', applyPayload: {} },
        ]),
      },
    });
    const provision = jest.fn().mockResolvedValue(undefined);
    svc.provisionApprovedApplicationSeats = provision;
    await expect(svc.ensureSeatsForApprovedStudent('s1', 'opp')).resolves.toBe(
      true,
    );
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision.mock.calls[0][0].id).toBe('a1');
  });

  it('provisions a teammate through the lead application team list', async () => {
    const svc = build({
      userRepo: {
        findOne: jest.fn().mockResolvedValue({ id: 's2', email: 'Mate@x.pk' }),
      },
      appRepo: {
        find: jest.fn().mockResolvedValue([
          {
            id: 'a1',
            studentUserId: 's1',
            applyPayload: { team_members: [{ email: ' mate@x.pk ' }] },
          },
        ]),
      },
    });
    svc.provisionApprovedApplicationSeats = jest
      .fn()
      .mockResolvedValue(undefined);
    await expect(svc.ensureSeatsForApprovedStudent('s2', 'opp')).resolves.toBe(
      true,
    );
  });

  it('does nothing for a student with no approved application', async () => {
    const svc = build({
      userRepo: {
        findOne: jest.fn().mockResolvedValue({ id: 's3', email: 'z@x.pk' }),
      },
      appRepo: {
        find: jest
          .fn()
          .mockResolvedValue([
            { id: 'a1', studentUserId: 's1', applyPayload: {} },
          ]),
      },
    });
    svc.provisionApprovedApplicationSeats = jest.fn();
    await expect(svc.ensureSeatsForApprovedStudent('s3', 'opp')).resolves.toBe(
      false,
    );
    expect(svc.provisionApprovedApplicationSeats).not.toHaveBeenCalled();
  });
});

describe('adminEnrollPendingApplications', () => {
  it('approves each pending application and keeps going when one fails', async () => {
    const svc = build({
      opportunityRepo: { findOne: jest.fn().mockResolvedValue({ id: 'opp' }) },
      appRepo: {
        find: jest.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]),
      },
    });
    svc.adminApprove = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});
    svc.reconcileMissingTeamMemberSeatsForOpportunity = jest
      .fn()
      .mockResolvedValue(undefined);
    svc.adminListOpportunityTeams = jest.fn().mockResolvedValue({ data: [] });
    const res = await svc.adminEnrollPendingApplications('opp', 'admin');
    expect(svc.adminApprove).toHaveBeenCalledTimes(2);
    expect(res.data.approved).toBe(1);
    expect(res.data.failed).toBe(1);
    expect(res.success).toBe(false);
  });
});

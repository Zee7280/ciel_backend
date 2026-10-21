import {
  countOccupiedSeats,
  lockOpportunitySeats,
  OCCUPIED_SEAT_STATUSES,
  pendingApplicationSeatCount,
  seatsUnavailableMessage,
} from './seat-capacity.util';

describe('pendingApplicationSeatCount', () => {
  it('counts an individual application as one seat', () => {
    expect(pendingApplicationSeatCount({}, 'lead@uni.edu')).toBe(1);
    expect(
      pendingApplicationSeatCount(
        { participation_type: 'individual' },
        'lead@uni.edu',
      ),
    ).toBe(1);
    expect(pendingApplicationSeatCount(null, null)).toBe(1);
  });

  it('counts the lead plus distinct teammate emails, ignoring blanks and the lead', () => {
    expect(
      pendingApplicationSeatCount(
        {
          participation_type: 'Team',
          team_members: [
            { email: 'a@uni.edu' },
            { email: ' A@uni.edu ' },
            { email: '' },
            { email: 'LEAD@uni.edu' },
            { email: 'b@uni.edu' },
          ],
        },
        'lead@uni.edu',
      ),
    ).toBe(3);
  });

  it('treats a member list without participation_type as a team', () => {
    expect(
      pendingApplicationSeatCount(
        { team_members: [{ email: 'a@uni.edu' }] },
        'lead@uni.edu',
      ),
    ).toBe(2);
  });
});

describe('seatsUnavailableMessage', () => {
  it('allows when it fits or there is no cap', () => {
    expect(seatsUnavailableMessage(10, 7, 3)).toBeNull();
    expect(seatsUnavailableMessage(0, 500, 3)).toBeNull();
  });
  it('explains a full listing and a too-large team', () => {
    expect(seatsUnavailableMessage(10, 10, 1)).toBe(
      'All seats for this opportunity are taken.',
    );
    expect(seatsUnavailableMessage(10, 8, 3)).toBe(
      'Only 2 seats left, but this application needs 3.',
    );
    expect(seatsUnavailableMessage(10, 9, 2)).toMatch(/Only 1 seat left/);
  });
});

describe('lockOpportunitySeats / countOccupiedSeats', () => {
  it('takes a transaction-scoped advisory lock keyed by the listing', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await lockOpportunitySeats({ query } as never, 'opp-1');
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['opportunity_seats:opp-1'],
    );
  });

  it('adds occupied participations to every seat still in the join pipeline', async () => {
    const count = jest.fn().mockResolvedValue(4);
    const find = jest.fn().mockResolvedValue([
      { applyPayload: {}, studentUser: { email: 'x@uni.edu' } },
      {
        applyPayload: {
          participation_type: 'team',
          team_members: [{ email: 'a@uni.edu' }, { email: 'b@uni.edu' }],
        },
        studentUser: { email: 'lead@uni.edu' },
      },
    ]);
    await expect(
      countOccupiedSeats({ count, find } as never, 'opp-1'),
    ).resolves.toBe(4 + 1 + 3);
    const where = (
      count.mock.calls[0] as [
        unknown,
        { where: { status: { _value: unknown } } },
      ]
    )[1].where;
    expect(where.status._value).toEqual([...OCCUPIED_SEAT_STATUSES]);
  });
});

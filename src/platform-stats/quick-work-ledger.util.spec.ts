import { Repository } from 'typeorm';
import { StudentReport } from '../reports/entities/student-report.entity';
import { User } from '../users/entities/user.entity';
import { QuickWorkLog } from '../quick-work/entities/quick-work-log.entity';
import { PlatformStatsService } from './platform-stats.service';
import {
  cityKeyFromPin,
  cityKeyFromText,
  QUICK_WORK_LEDGER_PATH,
  QuickWorkLedgerEntry,
  QuickWorkLedgerLog,
  quickWorkLedgerEntry,
} from './quick-work-ledger.util';

const log = (over: Partial<QuickWorkLedgerLog> = {}): QuickWorkLedgerLog => ({
  id: 'qw-1',
  title: 'Tree drive',
  leadUserId: 'lead',
  location: 'Jinnah Park',
  locationPin: null,
  host: null,
  partners: [],
  sdg: 15,
  peopleReached: 40,
  reviewedAt: new Date('2026-10-20T10:00:00Z'),
  updatedAt: new Date('2026-10-21T10:00:00Z'),
  participants: [
    { userId: 'lead', minutes: 90 },
    { userId: 'mate', minutes: 30 },
    { userId: 'absent', minutes: 0 },
  ],
  ...over,
});

describe('quick-work ledger entries', () => {
  it('credits each present member’s own minutes as person-hours', () => {
    const e = quickWorkLedgerEntry(log(), null);
    expect(e.hours).toBe(2);
    expect(e.memberIds).toEqual(['lead', 'mate']);
    expect(e.peopleReached).toBe(40);
    expect(e.sdg).toBe(15);
    expect(e.verifiedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('city comes from the pin, then the venue text, then the lead’s profile', () => {
    expect(cityKeyFromPin('31.5204,74.3587')).toBe('lahore');
    expect(cityKeyFromPin('0,0')).toBeNull();
    expect(cityKeyFromPin('nonsense')).toBeNull();
    expect(cityKeyFromText('Clifton beach, Karachi')).toBe('karachi');
    expect(cityKeyFromText('Online (Zoom)')).toBeNull();

    expect(
      quickWorkLedgerEntry(
        log({ locationPin: '24.8607,67.0011', location: 'Lahore' }),
        'Islamabad',
      ).cityKey,
    ).toBe('karachi');
    expect(
      quickWorkLedgerEntry(log({ location: 'Model Town, Lahore' }), 'Islamabad')
        .cityKey,
    ).toBe('lahore');
    expect(quickWorkLedgerEntry(log(), 'Islamabad').cityKey).toBe('islamabad');
    expect(quickWorkLedgerEntry(log(), null).cityKey).toBeNull();
  });

  it('partners include the host; a bad SDG or reach is ignored', () => {
    const e = quickWorkLedgerEntry(
      log({
        partners: ['Edhi Foundation', ' '],
        host: 'WWF',
        sdg: 99,
        peopleReached: null,
      }),
      null,
    );
    expect(e.partners).toEqual(['Edhi Foundation', 'WWF']);
    expect(e.sdg).toBeNull();
    expect(e.peopleReached).toBe(0);
  });
});

describe('public community ledger includes approved quick work', () => {
  type Ledger = {
    computeCommunityLedger(q: QuickWorkLedgerEntry[]): Promise<{
      verifiedHours: number;
      peopleReached: number;
      peopleServing: number;
      communityDividendPkr: number;
      sdgsTouched: number;
      partnerOrganisations: number;
      cities: { id: string; verifiedHours: number; partners: string[] }[];
      recentActivity: { hours: number; partnerName: string | null }[];
      sdgs: {
        number: number;
        projects: number;
        attributedHours: number;
        items: { path: string }[];
      }[];
    }>;
  };
  const noop = <T>(): T => ({}) as T;
  const service = new PlatformStatsService(
    noop(),
    noop(),
    noop(),
    noop(),
    noop(),
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<StudentReport>,
    noop(),
    noop(),
    noop(),
    noop(),
  ) as unknown as Ledger;

  it('adds hours, dividend, people, SDG, partners, city and activity', async () => {
    const entries = [
      quickWorkLedgerEntry(
        log({
          locationPin: '31.5204,74.3587',
          partners: ['Edhi Foundation'],
        }),
        null,
      ),
      quickWorkLedgerEntry(
        log({
          id: 'qw-2',
          sdg: 3,
          peopleReached: 10,
          partners: ['edhi foundation'],
          participants: [{ userId: 'x', minutes: 60 }],
        }),
        'Karachi',
      ),
    ];
    const ledger = await service.computeCommunityLedger(entries);

    expect(ledger.verifiedHours).toBe(3);
    expect(ledger.communityDividendPkr).toBeGreaterThan(0);
    expect(ledger.peopleReached).toBe(50);
    expect(ledger.peopleServing).toBe(3);
    expect(ledger.sdgsTouched).toBe(2);
    expect(ledger.partnerOrganisations).toBe(1);
    expect(ledger.cities.map((c) => [c.id, c.verifiedHours]).sort()).toEqual([
      ['karachi', 1],
      ['lahore', 2],
    ]);
    expect(ledger.recentActivity).toHaveLength(2);
    const sdg15 = ledger.sdgs.find((s) => s.number === 15);
    expect(sdg15).toMatchObject({ projects: 1, attributedHours: 2 });
    expect(sdg15?.items[0].path).toBe(QUICK_WORK_LEDGER_PATH);
  });
});

describe('verified records and the approved-only quick work loader (QCI + SCI aggregate)', () => {
  type Private = {
    countVerifiedRecords(q: QuickWorkLedgerEntry[]): Promise<number>;
    loadApprovedQuickWork(): Promise<QuickWorkLedgerEntry[]>;
  };
  const noop = <T>(): T => ({}) as T;
  const quickWorkFind = jest.fn();
  const usersFind = jest
    .fn()
    .mockResolvedValue([{ id: 'lead', city: 'Multan' }]);
  const service = new PlatformStatsService(
    { find: usersFind } as unknown as Repository<User>,
    noop(),
    noop(),
    noop(),
    noop(),
    {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(3),
    } as unknown as Repository<StudentReport>,
    noop(),
    noop(),
    noop(),
    { find: quickWorkFind } as unknown as Repository<QuickWorkLog>,
  ) as unknown as Private;

  it('verified records = verified structured reports (SCI) + approved quick work logs (QCI)', async () => {
    const entries = [
      quickWorkLedgerEntry(log(), null),
      quickWorkLedgerEntry(log({ id: 'qw-2' }), null),
    ];
    expect(await service.countVerifiedRecords(entries)).toBe(5);
    expect(await service.countVerifiedRecords([])).toBe(3);
  });

  it('only approved logs are loaded, and the lead’s city fills in when the log has none', async () => {
    quickWorkFind.mockResolvedValueOnce([log({ location: '' })]);
    const entries = await service.loadApprovedQuickWork();
    expect(quickWorkFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'approved' } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].cityKey).toBe('multan');
    expect(entries[0].hours).toBe(2);
  });

  it('a failing quick work query drops QCI from the totals but never breaks the public stats', async () => {
    quickWorkFind.mockRejectedValueOnce(new Error('db down'));
    expect(await service.loadApprovedQuickWork()).toEqual([]);
  });
});

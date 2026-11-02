import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { VentureEntry } from './entities/venture-entry.entity';
import {
  VentureInvestorSignal,
  type VentureIntroStatus,
  type VentureSignalKind,
} from './entities/venture-investor-signal.entity';

/** Per-venture figures every stakeholder screen shows ("investor activity"). */
export type VentureInvestorActivity = {
  views: number;
  saves: number;
  interests: number;
  intros: number;
  /** Intro requests not yet decided (pending CIEL PK or the founder). */
  introsOpen: number;
  /** Intro requests the founder accepted. */
  introsAccepted: number;
};

const EMPTY: VentureInvestorActivity = {
  views: 0,
  saves: 0,
  interests: 0,
  intros: 0,
  introsOpen: 0,
  introsAccepted: 0,
};

const isVerifiedInvestor = (status?: string | null) => {
  const s = String(status || '').toLowerCase();
  return s === 'active' || s === 'approved';
};

const investorOpen = (v: VentureEntry): boolean => {
  const ps = v.publishSettings || {};
  return (
    v.status === 'submitted' &&
    v.reviewPipeline?.supervisorStatus === 'approved' &&
    ps.audience !== 'private' &&
    (ps.acceptIntros === true || ps.audience === 'investors')
  );
};

@Injectable()
export class VentureInvestorSignalsService {
  private readonly logger = new Logger(VentureInvestorSignalsService.name);

  constructor(
    @InjectRepository(VentureInvestorSignal)
    private readonly repo: Repository<VentureInvestorSignal>,
    @InjectRepository(VentureEntry)
    private readonly ventures: Repository<VentureEntry>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------ investor

  private async openVenture(ventureId: string): Promise<VentureEntry> {
    const v = await this.ventures.findOne({ where: { id: ventureId } });
    if (!v || !investorOpen(v)) {
      throw new NotFoundException('Venture is not listed in the Investor Hub');
    }
    return v;
  }

  /** Investor acted on a venture. Views count up; save / interest / intro are one-shot. */
  async record(
    investor: { id: string; status?: string | null },
    ventureId: string,
    kind: VentureSignalKind,
    note?: string,
  ) {
    const venture = await this.openVenture(ventureId);
    if (kind !== 'view' && !isVerifiedInvestor(investor.status)) {
      throw new ForbiddenException(
        'CIEL PK verification is required before you can act on ventures.',
      );
    }
    const existing = await this.repo.findOne({
      where: { ventureId, investorUserId: investor.id, kind },
    });
    if (kind === 'view') {
      if (existing) {
        existing.count += 1;
        return this.repo.save(existing);
      }
      return this.repo.save(
        this.repo.create({ ventureId, investorUserId: investor.id, kind }),
      );
    }
    if (existing) return existing;
    const saved = await this.repo.save(
      this.repo.create({
        ventureId,
        investorUserId: investor.id,
        kind,
        note: (note || '').trim() || null,
        status: kind === 'intro' ? 'pending' : null,
      }),
    );
    if (kind === 'interest' || kind === 'intro') {
      const name = venture.ventureName || 'your venture';
      await this.notify(venture.userId, {
        type: 'update',
        title:
          kind === 'interest'
            ? 'An investor expressed interest in your venture'
            : 'An investor asked for an introduction',
        message:
          kind === 'interest'
            ? `A verified investor on the CIEL Investor Hub marked interest in “${name}”. No contact details were shared.`
            : `A verified investor asked CIEL PK for an introduction to “${name}”. CIEL PK screens the request first; you then accept or decline it from your Startup dashboard. Nothing is shared until you accept.`,
      });
    }
    return saved;
  }

  /** Un-save. Interest and intro requests are not retractable by the investor. */
  async remove(investorUserId: string, ventureId: string, kind: 'save') {
    await this.repo.delete({ investorUserId, ventureId, kind });
    return { removed: true };
  }

  async mine(investorUserId: string) {
    return this.repo.find({
      where: { investorUserId },
      order: { updatedAt: 'DESC' },
    });
  }

  /** Ventures whose founder accepted this investor's introduction: contact may be shown. */
  async contactUnlockedVentureIds(
    investorUserId: string,
  ): Promise<Set<string>> {
    const rows = await this.repo.find({
      where: { investorUserId, kind: 'intro', status: 'accepted' },
      select: ['ventureId'],
    });
    return new Set(rows.map((r) => r.ventureId));
  }

  // ------------------------------------------------------------- counts

  async countsFor(
    ventureIds: string[],
  ): Promise<Map<string, VentureInvestorActivity>> {
    const ids = [...new Set(ventureIds.filter(Boolean))];
    const out = new Map<string, VentureInvestorActivity>();
    if (!ids.length) return out;
    const rows = await this.repo.find({ where: { ventureId: In(ids) } });
    for (const r of rows) {
      const cur = out.get(r.ventureId) ?? { ...EMPTY };
      if (r.kind === 'view') cur.views += r.count;
      else if (r.kind === 'save') cur.saves += 1;
      else if (r.kind === 'interest') cur.interests += 1;
      else if (r.kind === 'intro') {
        cur.intros += 1;
        if (r.status === 'pending' || r.status === 'screened')
          cur.introsOpen += 1;
        if (r.status === 'accepted') cur.introsAccepted += 1;
      }
      out.set(r.ventureId, cur);
    }
    return out;
  }

  /** Adds `investorActivity` to one venture or a list of them. Null / undefined pass through. */
  async attach<T extends { id?: string } | null | undefined>(
    entries: T | T[],
  ): Promise<T | T[] | (T & { investorActivity: VentureInvestorActivity })[]> {
    const list = (Array.isArray(entries) ? entries : [entries]).filter(
      (e): e is NonNullable<T> => Boolean(e),
    );
    const counts = await this.countsFor(
      list.map((e) => e.id).filter((id): id is string => Boolean(id)),
    );
    const withCounts = list.map((e) => ({
      ...e,
      investorActivity: (e.id && counts.get(e.id)) || { ...EMPTY },
    }));
    return Array.isArray(entries) ? withCounts : (withCounts[0] ?? entries);
  }

  // ------------------------------------------------------------- founder

  /** Interest and intro rows on the caller's own venture. Investor identity only once CIEL PK
   * screened the request; organisation name is enough before that. */
  async forFounder(userId: string) {
    const venture = await this.ventures.findOne({ where: { userId } });
    if (!venture) return [];
    const rows = await this.repo.find({
      where: { ventureId: venture.id, kind: In(['interest', 'intro']) },
      order: { createdAt: 'DESC' },
    });
    const investors = await this.usersById(rows.map((r) => r.investorUserId));
    return rows.map((r) => {
      const inv = investors.get(r.investorUserId);
      const revealed =
        r.kind === 'intro' &&
        (r.status === 'screened' || r.status === 'accepted');
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        note: r.note,
        created_at: r.createdAt,
        investor: {
          organisation: inv?.orgName || 'Investor (organisation withheld)',
          name: revealed ? inv?.name || null : null,
          type:
            (inv?.settings as { investor?: { investorType?: string } } | null)
              ?.investor?.investorType ?? null,
        },
      };
    });
  }

  async founderDecide(
    userId: string,
    signalId: string,
    decision: 'accept' | 'decline',
  ) {
    const venture = await this.ventures.findOne({ where: { userId } });
    if (!venture) throw new NotFoundException('Venture not found');
    const row = await this.repo.findOne({
      where: { id: signalId, ventureId: venture.id, kind: 'intro' },
    });
    if (!row) throw new NotFoundException('Introduction request not found');
    if (row.status !== 'screened') {
      throw new ForbiddenException(
        row.status === 'pending'
          ? 'CIEL PK has not screened this request yet.'
          : 'This request was already decided.',
      );
    }
    row.status = decision === 'accept' ? 'accepted' : 'declined';
    const saved = await this.repo.save(row);
    const name = venture.ventureName || 'the venture';
    await this.notify(row.investorUserId, {
      type: decision === 'accept' ? 'approval' : 'update',
      title:
        decision === 'accept'
          ? `Introduction accepted: ${name}`
          : `Introduction declined: ${name}`,
      message:
        decision === 'accept'
          ? `The founder of “${name}” accepted your introduction. Their contact details are now visible on the venture card in the Investor Hub.`
          : `The founder of “${name}” declined the introduction for now. You can keep following the venture in the Hub.`,
    });
    return saved;
  }

  // --------------------------------------------------------------- admin

  async adminActivity(filters: {
    kind?: string;
    status?: string;
    ventureId?: string;
  }) {
    const where: Record<string, unknown> = {};
    if (filters.kind) where.kind = filters.kind;
    if (filters.status) where.status = filters.status;
    if (filters.ventureId) where.ventureId = filters.ventureId;
    const rows = await this.repo.find({
      where,
      order: { updatedAt: 'DESC' },
      take: 500,
    });
    const [investors, ventures] = await Promise.all([
      this.usersById(rows.map((r) => r.investorUserId)),
      this.ventures.find({
        where: { id: In([...new Set(rows.map((r) => r.ventureId))]) },
      }),
    ]);
    const ventureById = new Map(ventures.map((v) => [v.id, v]));
    const founders = await this.usersById(ventures.map((v) => v.userId));
    const items = rows.map((r) => {
      const inv = investors.get(r.investorUserId);
      const v = ventureById.get(r.ventureId);
      const founder = v ? founders.get(v.userId) : undefined;
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        note: r.note,
        admin_note: r.adminNote,
        count: r.count,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        investor: inv
          ? {
              id: inv.id,
              name: inv.name,
              email: inv.email,
              organisation: inv.orgName || null,
              account_status: inv.status,
            }
          : null,
        venture: v
          ? {
              id: v.id,
              name: v.ventureName,
              university: v.academicSetup?.university ?? null,
              founder: founder
                ? { id: founder.id, name: founder.name, email: founder.email }
                : null,
            }
          : null,
      };
    });
    const totals = {
      actions: rows.reduce((n, r) => n + (r.kind === 'view' ? r.count : 1), 0),
      investors: new Set(rows.map((r) => r.investorUserId)).size,
      organisations: new Set(
        rows
          .map((r) => investors.get(r.investorUserId)?.orgName || '')
          .filter(Boolean),
      ).size,
      intros_pending: rows.filter(
        (r) => r.kind === 'intro' && r.status === 'pending',
      ).length,
      intros_with_founder: rows.filter(
        (r) => r.kind === 'intro' && r.status === 'screened',
      ).length,
    };
    return { items, totals };
  }

  /** Gate 1: CIEL PK clears or declines an introduction request. */
  async adminScreen(
    signalId: string,
    status: Extract<VentureIntroStatus, 'screened' | 'declined'>,
    note?: string,
  ) {
    const row = await this.repo.findOne({
      where: { id: signalId, kind: 'intro' },
    });
    if (!row) throw new NotFoundException('Introduction request not found');
    if (row.status !== 'pending') {
      throw new ForbiddenException('This request was already screened.');
    }
    row.status = status;
    row.adminNote = (note || '').trim() || null;
    const saved = await this.repo.save(row);
    const venture = await this.ventures.findOne({
      where: { id: row.ventureId },
    });
    const name = venture?.ventureName || 'your venture';
    if (status === 'screened' && venture) {
      await this.notify(venture.userId, {
        type: 'update',
        title: 'An introduction request is waiting for your decision',
        message: `CIEL PK screened an investor's request to be introduced to “${name}”. Open your Startup dashboard to accept or decline. Your contact details are shared only if you accept.`,
      });
    } else if (status === 'declined') {
      await this.notify(row.investorUserId, {
        type: 'update',
        title: `Introduction request not cleared: ${name}`,
        message: `CIEL PK did not clear your introduction request for “${name}”.${row.adminNote ? ` Note: ${row.adminNote}` : ''}`,
      });
    }
    return saved;
  }

  // ------------------------------------------------------------- helpers

  private async usersById(ids: string[]): Promise<Map<string, User>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.users.find({
      where: { id: In(unique) },
      select: ['id', 'name', 'email', 'orgName', 'status', 'settings'],
    });
    return new Map(rows.map((u) => [u.id, u]));
  }

  private async notify(
    userId: string,
    input: { type: string; title: string; message: string },
  ) {
    try {
      await this.notifications.createNotification(userId, input);
    } catch (err) {
      this.logger.warn(
        `investor-signal notification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

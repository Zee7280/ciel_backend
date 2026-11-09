import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  NpeChallengeDto,
  NpeOverrideDto,
  NpeResolveChallengeDto,
} from './dto/npe-ranking.dto';
import { NpeAdminAction } from './entities/npe-admin-action.entity';
import { NpeCriterionOverride } from './entities/npe-criterion-override.entity';
import { NpeRankingChallenge } from './entities/npe-ranking-challenge.entity';
import { NpeStudioPublication } from './entities/npe-studio-publication.entity';
import {
  NPE_CRITERION_KEYS,
  NPE_RUBRIC_VERSION,
} from './npe-ranking.constants';
import { NpeRankingService, type NpeActor } from './npe-ranking.service';
import { STUDIO_LENSES, type StudioLens } from './npe-studio.util';

/**
 * NPE-1.3 governance around the ranking pipeline — everything the National Ranking Analyzer v2
 * contract adds on top of the comparator:
 *  - Admin criterion corrections (evidence locator + reason, scoped, versioned, never deleted);
 *  - the append-only administrator action log;
 *  - the evidence-based challenge process on published rankings;
 *  - the automatic My Impact Wall feed status;
 *  - a project's rank progression across published revisions.
 * Nothing here recomputes a CII or rewrites a published ranking: corrections change what the next
 * preview/publication is computed from, challenges are records that lead to a correction and a new
 * revision, and the log only describes what happened.
 */
@Injectable()
export class NpeGovernanceService {
  constructor(
    private readonly ranking: NpeRankingService,
    @InjectRepository(NpeCriterionOverride)
    private readonly overrides: Repository<NpeCriterionOverride>,
    @InjectRepository(NpeAdminAction)
    private readonly actions: Repository<NpeAdminAction>,
    @InjectRepository(NpeRankingChallenge)
    private readonly challenges: Repository<NpeRankingChallenge>,
    @InjectRepository(NpeStudioPublication)
    private readonly publications: Repository<NpeStudioPublication>,
  ) {}

  // ------------------------------------------------------------------------------------- feed

  /** "Check automatic feed": what the ranking pipeline can see right now, without writing anything. */
  async feed(actor: NpeActor) {
    const scope = this.ranking.scopeFor(actor);
    const pool = await this.ranking.studioCandidates(actor);
    const [lastPublication, openChallenges] = await Promise.all([
      this.publications.findOne({
        where: { scope },
        order: { publishedAt: 'DESC' },
      }),
      this.challenges.count({ where: { scope, status: 'open' } }),
    ]);
    const evaluated = pool.candidates.filter((c) => c.evaluated).length;
    const awaitingRead = pool.candidates.filter(
      (c) => c.gateOk && !c.evaluated,
    ).length;
    const corrections = pool.candidates.reduce(
      (sum, c) => sum + (c.corrections ?? 0),
      0,
    );
    return {
      connected: true,
      packageSource: 'MY_IMPACT_WALL' as const,
      approvedCIIFieldsReady: true,
      canRun: true,
      scope,
      rubricVersion: NPE_RUBRIC_VERSION,
      checkedAt: new Date().toISOString(),
      counts: {
        discovered: pool.packageCount,
        eligible: pool.eligibleCount,
        held: pool.heldCount,
        evaluated,
        awaitingRead,
        pendingReviews: pool.pendingReviews,
        corrections,
        openChallenges,
      },
      run: pool.run,
      lastPublication: lastPublication
        ? {
            id: lastPublication.id,
            name: lastPublication.name,
            revision: lastPublication.revision,
            publishedAt: lastPublication.publishedAt.toISOString(),
          }
        : null,
    };
  }

  // ------------------------------------------------------------------------------------ audit

  /** Recent administrator actions in this scope, newest first. */
  async audit(actor: NpeActor, limit = 100) {
    const scope = this.ranking.scopeFor(actor);
    const rows = await this.actions.find({
      where: { scope },
      order: { createdAt: 'DESC' },
      take: Math.max(1, Math.min(500, limit)),
    });
    return rows.map((a) => ({
      id: a.id,
      action: a.action,
      role: a.role,
      actorUserId: a.actorUserId,
      reportId: a.reportId,
      targetId: a.targetId,
      details: a.details ?? {},
      at: a.createdAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------------- corrections

  private serializeOverride(o: NpeCriterionOverride) {
    return {
      id: o.id,
      scope: o.scope,
      reportId: o.reportId,
      packageVersion: o.packageVersion,
      criterion: o.criterion,
      anchor: o.anchor,
      originalAnchor: o.originalAnchor,
      originalConfidence: o.originalConfidence,
      locator: o.locator,
      reason: o.reason,
      role: o.role,
      createdByUserId: o.createdByUserId,
      createdAt: o.createdAt.toISOString(),
      active: o.active,
      revokedAt: o.revokedAt ? o.revokedAt.toISOString() : null,
      revokeReason: o.revokeReason,
    };
  }

  /** Corrections of this scope (active first), optionally for one project. */
  async listOverrides(actor: NpeActor, reportId?: string) {
    const scope = this.ranking.scopeFor(actor);
    const rows = await this.overrides.find({
      where: reportId ? { scope, reportId } : { scope },
      order: { active: 'DESC', createdAt: 'DESC' },
      take: 500,
    });
    return rows.map((o) => this.serializeOverride(o));
  }

  /**
   * Records a correction after checking it against the judgment it corrects. The previous active
   * correction of the same criterion is superseded (kept, deactivated). Nothing is re-ranked here:
   * the next preview/publication recomputes from the corrected anchors.
   */
  async saveOverride(actor: NpeActor, dto: NpeOverrideDto) {
    const scope = this.ranking.scopeFor(actor);
    if (!(NPE_CRITERION_KEYS as readonly string[]).includes(dto.criterion)) {
      throw new BadRequestException('Unknown ranking criterion.');
    }
    const row = await this.ranking.rowForReport(actor, dto.reportId);
    if (!row) {
      throw new ForbiddenException(
        'This project is outside your ranking scope.',
      );
    }
    const ai = row.evaluation?.criteria?.[dto.criterion as never] as
      | { anchor: number; confidence: string }
      | undefined;
    if (!row.evaluation || !ai) {
      throw new BadRequestException(
        'The AI evaluator has not read this package yet. Run the Ranking Analyzer first; a correction must refer to an existing judgment.',
      );
    }
    if (ai.confidence === 'unsupported') {
      throw new BadRequestException(
        'Unsupported criteria require verified new evidence before comparative credit. Add the evidence to the report and re-run the analysis instead of correcting the anchor.',
      );
    }
    const current =
      (
        row.effectiveCriteria?.[dto.criterion as never] as
          | { anchor: number }
          | undefined
      )?.anchor ?? ai.anchor;
    if (Number(current) === dto.anchor) {
      throw new BadRequestException(
        `This criterion already stands at ${dto.anchor}/5. Nothing to correct.`,
      );
    }
    const previous = await this.overrides.find({
      where: {
        scope,
        reportId: dto.reportId,
        criterion: dto.criterion,
        active: true,
      },
    });
    const now = new Date();
    for (const p of previous) {
      p.active = false;
      p.revokedAt = now;
      p.revokedByUserId = actor.userId;
      p.revokeReason = 'Superseded by a newer correction.';
    }
    if (previous.length) await this.overrides.save(previous);
    const saved = await this.overrides.save(
      this.overrides.create({
        scope,
        reportId: dto.reportId,
        packageVersion: row.version,
        criterion: dto.criterion,
        anchor: dto.anchor,
        originalAnchor: Number(ai.anchor),
        originalConfidence: String(ai.confidence),
        locator: dto.locator.trim(),
        reason: dto.reason.trim(),
        createdByUserId: actor.userId,
        role: actor.role,
        active: true,
      }),
    );
    await this.ranking.logAction(actor, scope, 'override.save', {
      reportId: dto.reportId,
      targetId: saved.id,
      details: {
        criterion: dto.criterion,
        from: Number(current),
        to: dto.anchor,
        aiAnchor: Number(ai.anchor),
        locator: saved.locator,
        reason: saved.reason,
        superseded: previous.map((p) => p.id),
        summary: `${row.title}: ${dto.criterion} ${Number(current)} → ${dto.anchor}/5`,
      },
    });
    return {
      status: 'approved' as const,
      override: this.serializeOverride(saved),
    };
  }

  /** Deactivates a correction (the record stays for the audit trail). */
  async revokeOverride(actor: NpeActor, id: string, reason?: string) {
    const scope = this.ranking.scopeFor(actor);
    const row = await this.overrides.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Correction not found.');
    if (row.scope !== scope) {
      throw new ForbiddenException('This correction belongs to another scope.');
    }
    if (!row.active) {
      return {
        status: 'unchanged' as const,
        override: this.serializeOverride(row),
      };
    }
    row.active = false;
    row.revokedAt = new Date();
    row.revokedByUserId = actor.userId;
    row.revokeReason = (reason || '').trim() || 'Revoked by administrator.';
    const saved = await this.overrides.save(row);
    await this.ranking.logAction(actor, scope, 'override.revoke', {
      reportId: row.reportId,
      targetId: row.id,
      details: {
        criterion: row.criterion,
        from: row.anchor,
        to: row.originalAnchor,
        reason: row.revokeReason,
        summary: `${row.criterion} correction revoked (${row.anchor} → AI ${row.originalAnchor ?? '—'}/5)`,
      },
    });
    return {
      status: 'revoked' as const,
      override: this.serializeOverride(saved),
    };
  }

  // --------------------------------------------------------------------------------- challenges

  private serializeChallenge(c: NpeRankingChallenge) {
    return {
      id: c.id,
      scope: c.scope,
      publicationId: c.publicationId,
      reportId: c.reportId,
      raisedByRole: c.raisedByRole,
      raisedByScope: c.raisedByScope,
      raisedByUserId: c.raisedByUserId,
      locator: c.locator,
      reason: c.reason,
      status: c.status,
      resolution: c.resolution,
      resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
    };
  }

  /** Challenges this actor may see: those on their own publications and those they raised. */
  async listChallenges(actor: NpeActor) {
    const scope = this.ranking.scopeFor(actor);
    const [own, raised] = await Promise.all([
      this.challenges.find({
        where: { scope },
        order: { createdAt: 'DESC' },
        take: 300,
      }),
      this.challenges.find({
        where: { raisedByScope: scope },
        order: { createdAt: 'DESC' },
        take: 300,
      }),
    ]);
    const seen = new Set<string>();
    const all = [...own, ...raised]
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const pubIds = [...new Set(all.map((c) => c.publicationId))];
    const pubs = pubIds.length
      ? await this.publications.find({ where: { id: In(pubIds) } })
      : [];
    const pubById = new Map(pubs.map((p) => [p.id, p]));
    return all.map((c) => {
      const p = pubById.get(c.publicationId);
      const row = p?.rows.find((r) =>
        (r.projectIds ?? []).includes(c.reportId),
      );
      return {
        ...this.serializeChallenge(c),
        canResolve: c.scope === scope && c.status === 'open',
        publication: p
          ? {
              name: p.name,
              revision: p.revision,
              lensTitle: STUDIO_LENSES[p.lens as StudioLens]?.title ?? p.lens,
              publishedAt: p.publishedAt.toISOString(),
              rank: row?.rank ?? null,
              label: row?.label ?? null,
              of: p.rows.length,
            }
          : null,
      };
    });
  }

  /**
   * Opens a challenge. Allowed against a publication of the actor's own scope, or against a
   * national publication when the project is in the actor's pool (a university challenging the
   * national position of its own project).
   */
  async openChallenge(actor: NpeActor, dto: NpeChallengeDto) {
    const scope = this.ranking.scopeFor(actor);
    const pub = await this.publications.findOne({
      where: { id: dto.publicationId },
    });
    if (!pub) throw new NotFoundException('Published ranking not found.');
    if (pub.scope !== scope) {
      if (pub.scope !== 'national') {
        throw new ForbiddenException('This ranking belongs to another scope.');
      }
      await this.ranking.assertReportInScope(actor, dto.reportId);
    }
    const inRows = pub.rows.some((r) =>
      (r.projectIds ?? []).includes(dto.reportId),
    );
    if (!inRows) {
      throw new BadRequestException(
        'This project is not part of that published ranking.',
      );
    }
    const duplicate = await this.challenges.findOne({
      where: {
        publicationId: pub.id,
        reportId: dto.reportId,
        status: 'open',
      },
    });
    if (duplicate) {
      throw new BadRequestException(
        'An open challenge already exists for this project in this publication.',
      );
    }
    const saved = await this.challenges.save(
      this.challenges.create({
        scope: pub.scope,
        publicationId: pub.id,
        reportId: dto.reportId,
        raisedByUserId: actor.userId,
        raisedByRole: actor.role,
        raisedByScope: scope,
        locator: dto.locator.trim(),
        reason: dto.reason.trim(),
        status: 'open',
      }),
    );
    await this.ranking.logAction(actor, pub.scope, 'challenge.open', {
      reportId: dto.reportId,
      targetId: saved.id,
      details: {
        publicationId: pub.id,
        publicationName: pub.name,
        revision: pub.revision,
        locator: saved.locator,
        summary: `Challenge opened on “${pub.name}” (update ${pub.revision})`,
      },
    });
    return this.serializeChallenge(saved);
  }

  /** Only the owner of the publication's scope resolves. The published ranking itself is untouched. */
  async resolveChallenge(
    actor: NpeActor,
    id: string,
    dto: NpeResolveChallengeDto,
  ) {
    const scope = this.ranking.scopeFor(actor);
    const row = await this.challenges.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Challenge not found.');
    if (row.scope !== scope) {
      throw new ForbiddenException(
        'Only the owner of this ranking scope can resolve the challenge.',
      );
    }
    if (row.status !== 'open') {
      throw new BadRequestException('This challenge is already resolved.');
    }
    row.status = dto.status;
    row.resolution = dto.resolution.trim();
    row.resolvedByUserId = actor.userId;
    row.resolvedAt = new Date();
    const saved = await this.challenges.save(row);
    await this.ranking.logAction(actor, scope, 'challenge.resolve', {
      reportId: row.reportId,
      targetId: row.id,
      details: {
        status: dto.status,
        resolution: saved.resolution,
        summary: `Challenge ${dto.status}${dto.status === 'upheld' ? ' — correct the criterion and publish a new revision' : ''}`,
      },
    });
    return this.serializeChallenge(saved);
  }

  // ------------------------------------------------------------------------------ rank history

  /**
   * Every published revision (in the scopes this actor may see) that placed the project, oldest
   * first. Revisions of the same ranking share a `signature`, so the client can draw one trend
   * line per named ranking and compare like with like only.
   */
  async projectRankHistory(actor: NpeActor, reportId: string) {
    const scopes = ['national'];
    if (actor.role === 'university' && actor.organizationId) {
      scopes.push(`university:${actor.organizationId}`);
    }
    await this.ranking.assertReportInScope(actor, reportId);
    const pubs = await this.publications.find({
      where: { scope: In(scopes) },
      order: { publishedAt: 'ASC' },
      take: 1000,
    });
    const out: Array<Record<string, unknown>> = [];
    for (const p of pubs) {
      const row = p.rows.find((r) => (r.projectIds ?? []).includes(reportId));
      if (!row) continue;
      out.push({
        publicationId: p.id,
        signature: p.signature,
        name: p.name,
        lens: p.lens,
        lensTitle: STUDIO_LENSES[p.lens as StudioLens]?.title ?? p.lens,
        groupBy: p.groupBy,
        scope: p.scope === 'national' ? 'national' : 'university',
        revision: p.revision,
        cohortComparable: p.cohortComparable,
        publishedAt: p.publishedAt.toISOString(),
        rank: row.rank,
        of: p.rows.length,
        label: row.label,
        movement: row.movement ?? null,
        previousRank: row.previousRank ?? null,
      });
    }
    return out;
  }
}

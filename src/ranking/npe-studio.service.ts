import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NpeStudioDto } from './dto/npe-ranking.dto';
import { NpeStudioPublication } from './entities/npe-studio-publication.entity';
import { npeCriteriaFor } from './npe-ranking.constants';
import { NpeRankingService, type NpeActor } from './npe-ranking.service';
import {
  STUDIO_GROUPS,
  STUDIO_LENSES,
  applyStudioMovement,
  computeStudioRanking,
  isStudioGroup,
  isStudioLens,
  normalizeCustomWeights,
  sanitizeStudioFilters,
  type StudioCandidate,
  type StudioLens,
  type StudioResult,
} from './npe-studio.util';

const FILTER_OPTION_KEYS = [
  'university',
  'department',
  'instructor',
  'sdg',
  'year',
  'semester',
  'city',
  'partner',
  'activity',
  'theme',
  'ciiBadge',
  'privacy',
] as const;

/** Distinct, sorted values present in the pool for each filter dropdown. */
function buildOptions(candidates: StudioCandidate[]) {
  const out: Record<string, string[]> = {};
  for (const key of FILTER_OPTION_KEYS) {
    out[key] = [
      ...new Set(
        candidates
          .map((c) => String(c.facets[key] ?? '').trim())
          .filter((v) => v && v !== '—'),
      ),
    ].sort((a, b) => a.localeCompare(b));
  }
  out.skills = [...new Set(candidates.flatMap((c) => c.facets.skills))].sort(
    (a, b) => a.localeCompare(b),
  );
  out.month = [
    ...new Set(candidates.map((c) => c.facets.month).filter(Boolean)),
  ].sort();
  return out;
}

@Injectable()
export class NpeStudioService {
  constructor(
    private readonly ranking: NpeRankingService,
    @InjectRepository(NpeStudioPublication)
    private readonly publications: Repository<NpeStudioPublication>,
  ) {}

  private parse(dto: NpeStudioDto) {
    const lens = dto.lens || 'excellence';
    const groupBy = dto.groupBy || 'project';
    if (!isStudioLens(lens))
      throw new BadRequestException('Unknown ranking lens.');
    if (!isStudioGroup(groupBy))
      throw new BadRequestException('Unknown comparison.');
    const filters = sanitizeStudioFilters(dto.filters);
    if (
      filters.dateFrom &&
      filters.dateTo &&
      filters.dateFrom > filters.dateTo
    ) {
      throw new BadRequestException(
        'The start date must be before the end date.',
      );
    }
    return {
      lens: lens,
      groupBy: groupBy,
      filters,
      weights: normalizeCustomWeights(dto.weights),
    };
  }

  private async compute(actor: NpeActor, dto: NpeStudioDto) {
    const { lens, groupBy, filters, weights } = this.parse(dto);
    const pool = await this.ranking.studioCandidates(actor, dto.runId);
    const result = computeStudioRanking(
      { lens, groupBy, filters, weights, candidates: pool.candidates },
      pool.rubric,
    );
    return { pool, result, lens, groupBy };
  }

  private blockers(
    lens: StudioLens,
    pool: { run: unknown; pendingReviews: number },
    result: StudioResult,
  ): string[] {
    const out: string[] = [];
    if (!result.rows.length)
      out.push('No eligible projects match this ranking yet.');
    if (STUDIO_LENSES[lens].needsEvaluation) {
      if (!pool.run)
        out.push(
          'Run the AI analysis first: this angle uses the evidence-based evaluation.',
        );
      if (result.unreadIds.length > 0) {
        out.push(
          `${result.unreadIds.length} eligible project(s) in this selection have not been read yet. Run the Ranking Analyzer first, so the ranking includes every eligible project.`,
        );
      }
      if (pool.pendingReviews > 0) {
        out.push(
          `${pool.pendingReviews} required review(s) are still open. Clear the review queue first.`,
        );
      }
    }
    return out;
  }

  /** Deterministic standings for the chosen angle. Never writes anything. */
  async preview(actor: NpeActor, dto: NpeStudioDto) {
    const { pool, result, lens } = await this.compute(actor, dto);
    const latest = await this.latestFor(pool.scope, result.signature);
    return {
      scope: pool.scope,
      run: pool.run,
      rubricVersion: pool.rubric,
      criteria: npeCriteriaFor(pool.rubric),
      lenses: Object.entries(STUDIO_LENSES).map(([key, v]) => ({ key, ...v })),
      groups: Object.entries(STUDIO_GROUPS).map(([key, title]) => ({
        key,
        title,
      })),
      counts: {
        packages: pool.packageCount,
        eligible: pool.eligibleCount,
        held: pool.heldCount,
        inRanking: result.eligibleIds.length,
        heldInSelection: result.heldIds.length,
        populationInFilters: result.populationCount,
      },
      pendingReviews: pool.pendingReviews,
      options: buildOptions(pool.candidates),
      /** Combined Project Package Library: every package with its readiness, never a rank. */
      packages: pool.candidates.map((c) => ({
        id: c.id,
        title: c.title,
        university: c.facets.university,
        department: c.facets.department,
        sdg: c.facets.sdg,
        date: c.facets.date,
        cii: c.cii,
        ready: c.gateOk,
        evaluated: c.evaluated,
        reason: c.gateOk ? '' : c.reason,
      })),
      result,
      publishBlockers: this.blockers(lens, pool, result),
      lastPublication: latest
        ? {
            id: latest.id,
            revision: latest.revision,
            publishedAt: latest.publishedAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * Publishes the ranking exactly as the server computes it now (the client's rows are never
   * trusted). Same ranking published again becomes the next revision, with movement against the
   * previous one only when the eligible cohort is unchanged.
   */
  async publish(actor: NpeActor, dto: NpeStudioDto) {
    const { pool, result, lens } = await this.compute(actor, dto);
    const blockers = this.blockers(lens, pool, result);
    if (blockers.length) throw new BadRequestException(blockers[0]);

    const prior = await this.latestFor(pool.scope, result.signature);
    const moved = applyStudioMovement(result.rows, result.eligibleIds, prior);

    // Publishing an unchanged result twice (double click, retry) must not create a new revision.
    if (
      prior &&
      JSON.stringify(prior.rows.map((r) => [r.id, r.rank, r.metric])) ===
        JSON.stringify(result.rows.map((r) => [r.id, r.rank, r.metric])) &&
      JSON.stringify([...prior.eligibleReportIds].sort()) ===
        JSON.stringify([...result.eligibleIds].sort())
    ) {
      return { status: 'unchanged' as const, publication: this.summary(prior) };
    }

    const name = (dto.name || '').trim().slice(0, 200) || result.name;
    let saved: NpeStudioPublication;
    try {
      saved = await this.publications.save(
        this.publications.create({
          scope: pool.scope,
          role: actor.role,
          runId: pool.run?.id ?? null,
          rubricVersion: pool.rubric,
          name,
          lens: result.lens,
          groupBy: result.groupBy,
          filters: result.filters as Record<string, unknown>,
          weights: result.weights ? { ...result.weights } : null,
          signature: result.signature,
          revision: (prior?.revision ?? 0) + 1,
          previousId: prior?.id ?? null,
          cohortComparable: moved.cohortComparable,
          eligibleReportIds: result.eligibleIds,
          heldReportIds: result.heldIds,
          rows: moved.rows,
          publishedByUserId: actor.userId,
        }),
      );
    } catch (err) {
      // Two simultaneous publishes of the same ranking: the second loses the revision race and
      // simply reports the one that won, instead of failing with a database error.
      if ((err as { code?: string })?.code === '23505') {
        const winner = await this.latestFor(pool.scope, result.signature);
        if (winner)
          return {
            status: 'unchanged' as const,
            publication: this.summary(winner),
          };
      }
      throw err;
    }
    return { status: 'published' as const, publication: this.summary(saved) };
  }

  private async latestFor(scope: string, signature: string) {
    return this.publications.findOne({
      where: { scope, signature },
      order: { revision: 'DESC' },
    });
  }

  private summary(p: NpeStudioPublication, withRows = false) {
    return {
      id: p.id,
      scope: p.scope,
      name: p.name,
      lens: p.lens,
      lensTitle: STUDIO_LENSES[p.lens as StudioLens]?.title ?? p.lens,
      groupBy: p.groupBy,
      filters: p.filters,
      weights: p.weights,
      rubricVersion: p.rubricVersion,
      revision: p.revision,
      cohortComparable: p.cohortComparable,
      eligibleCount: p.eligibleReportIds.length,
      heldCount: p.heldReportIds.length,
      rowCount: p.rows.length,
      publishedAt: p.publishedAt.toISOString(),
      top: p.rows
        .slice(0, 3)
        .map((r) => ({ rank: r.rank, label: r.label, metric: r.metric })),
      ...(withRows ? { rows: p.rows } : {}),
    };
  }

  /** Every ranking published in this scope, newest first. */
  async history(actor: NpeActor) {
    const scope = this.ranking.scopeFor(actor);
    const rows = await this.publications.find({
      where: { scope },
      order: { publishedAt: 'DESC' },
      take: 200,
    });
    return rows.map((p) => this.summary(p));
  }

  async getPublication(actor: NpeActor, id: string) {
    const scope = this.ranking.scopeFor(actor);
    const row = await this.publications.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Published ranking not found.');
    if (row.scope !== scope)
      throw new ForbiddenException('This ranking belongs to another scope.');
    return this.summary(row, true);
  }

  /** Published rankings for one project, for the Impact Wall preview. */
  async rankingsForProject(actor: NpeActor, reportId: string) {
    const scopes = ['national'];
    if (actor.role === 'university' && actor.organizationId) {
      scopes.push(`university:${actor.organizationId}`);
    }
    await this.ranking.assertReportInScope(actor, reportId);
    const map = await this.ranking.studioRankingsForReports([reportId], scopes);
    return map.get(reportId) ?? [];
  }
}

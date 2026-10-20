import {
  Optional,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { groupSiblingSeats } from '../engagement/team-lead-canonical.util';
import { AiService } from '../ai/ai.service';
import { collectReportEvidenceFiles } from '../reports/collect-report-evidence.util';
import { CommunityAwardService } from '../reports/community-award.service';
import { isCiiFacultyLocked } from '../reports/community-award.util';
import { StudentReport } from '../reports/entities/student-report.entity';
import { IMPACT_PACKAGE_CONTENT_SOURCES } from '../reports/impact-package-packet.util';
import {
  NPE_PAYLOAD_VERSION,
  NPE_RUBRIC_VERSION,
  NPE_SUPPORTED_RUBRIC_VERSIONS,
  isSupportedNpeRubricVersion,
  npeCriteriaFor,
  type NpeStanding,
} from './npe-ranking.constants';
import {
  buildNpePackageRecord,
  gateNpePackage,
  type NpePackageRecord,
} from './npe-ranking-eligibility';
import { NpeRankingEvaluation } from './entities/npe-ranking-evaluation.entity';
import { NpeRankingRun } from './entities/npe-ranking-run.entity';
import {
  NpeRankingSnapshot,
  type NpeSnapshotStanding,
} from './entities/npe-ranking-snapshot.entity';
import {
  unreadNpeEvaluation,
  type NpeAiEvaluation,
} from './parse-npe-ranking.util';
import { npeCalculate, npeRankPool } from './npe-ranking.scoring';
import { NpeStudioPublication } from './entities/npe-studio-publication.entity';
import { buildNpeAiPayload } from './npe-package-payload.util';
import {
  STUDIO_LENSES,
  buildStudioFacets,
  type StudioCandidate,
  type StudioLens,
} from './npe-studio.util';

export type NpeActor = {
  userId: string;
  role: 'ciel_admin' | 'university';
  organizationId?: string | null;
  organizationName?: string | null;
};

/**
 * One analyze call must finish inside the hosting function limit (300s) even when a single AI
 * read takes minutes: stop STARTING new reads after this budget; the caller continues the same
 * run (`runId`) until nothing is left.
 */
export const NPE_ANALYZE_BUDGET_MS = 90_000;
/** Override in tests / ops (milliseconds). Never above the default in production. */
function analyzeBudgetMs(): number {
  const raw = Number(process.env.NPE_ANALYZE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.min(raw, NPE_ANALYZE_BUDGET_MS)
    : NPE_ANALYZE_BUDGET_MS;
}
export const NPE_ANALYZE_CONCURRENCY = 3;

/** Human reason for a failed AI read. HttpException#message is just "Http Exception" — the real text is in its body. */
export function describeAiFailure(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (typeof body === 'string' && body.trim()) return body.trim();
    const rec =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : null;
    for (const key of ['error', 'message']) {
      const value = rec?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value) && value.length)
        return value.map(String).join('; ');
    }
  }
  return err instanceof Error && err.message
    ? err.message
    : 'Ranking AI call failed.';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

@Injectable()
export class NpeRankingService {
  private readonly logger = new Logger(NpeRankingService.name);

  constructor(
    @InjectRepository(StudentReport)
    private readonly reports: Repository<StudentReport>,
    @InjectRepository(NpeRankingRun)
    private readonly runs: Repository<NpeRankingRun>,
    @InjectRepository(NpeRankingEvaluation)
    private readonly evaluations: Repository<NpeRankingEvaluation>,
    @InjectRepository(NpeRankingSnapshot)
    private readonly snapshots: Repository<NpeRankingSnapshot>,
    private readonly communityAward: CommunityAwardService,
    private readonly ai: AiService,
    @Optional()
    @InjectRepository(AttendanceLog)
    private readonly attendanceLogs?: Repository<AttendanceLog>,
    @Optional()
    @InjectRepository(Participation)
    private readonly participations?: Repository<Participation>,
    @Optional()
    @InjectRepository(NpeStudioPublication)
    private readonly studioPublications?: Repository<NpeStudioPublication>,
  ) {}

  scopeFor(actor: NpeActor): string {
    if (actor.role === 'ciel_admin') return 'national';
    if (!actor.organizationId) {
      throw new ForbiddenException(
        'University ranking requires an organization.',
      );
    }
    return `university:${actor.organizationId}`;
  }

  async listPackages(actor: NpeActor) {
    const reports = await this.poolReports(actor);
    const packages = reports.map((r) => buildNpePackageRecord(r));
    const latest = await this.runs.findOne({
      where: { scope: this.scopeFor(actor) },
      order: { createdAt: 'DESC' },
    });
    let runPayload: Record<string, unknown> | null = null;
    if (latest) {
      runPayload = await this.serializeRun(latest.id, actor);
    }
    return {
      role: actor.role,
      scope: this.scopeFor(actor),
      cohortLabel:
        actor.role === 'ciel_admin'
          ? 'CIEL PK national cohort'
          : actor.organizationName || 'University cohort',
      rubricVersion: NPE_RUBRIC_VERSION,
      criteria: npeCriteriaFor(NPE_RUBRIC_VERSION),
      packages,
      run: runPayload,
    };
  }

  /**
   * Resumable, bounded analysis.
   * - Without `runId`: starts a new draft run. Packages already read successfully in an earlier run
   *   of this scope (same package version) are reused, so re-running never re-pays AI or reshuffles
   *   marks for unchanged projects. Failed reads are retried.
   * - With `runId`: continues that run, reading only packages that have no evaluation yet.
   * Reads are done a few at a time and stop starting after NPE_ANALYZE_BUDGET_MS; `progress.remaining`
   * tells the caller to call again.
   */
  async analyze(
    actor: NpeActor,
    body: {
      rubricVersion?: string;
      runId?: string;
      projects: Array<{ id: string; version: string }>;
    },
  ) {
    // A client built against an older weighting may still send its version; accept any supported
    // one. A new run is always created under the current version, a continued run keeps its own.
    if (
      body.rubricVersion &&
      !isSupportedNpeRubricVersion(body.rubricVersion)
    ) {
      throw new BadRequestException('Unsupported ranking rubric version.');
    }
    const requested = body.projects || [];
    if (!requested.length) {
      throw new BadRequestException('No projects submitted for analysis.');
    }
    const pool = await this.poolReports(actor);
    const byId = new Map(pool.map((r) => [r.id, r]));
    const eligible: Array<{ report: StudentReport; pkg: NpePackageRecord }> =
      [];
    for (const item of requested) {
      const report = byId.get(item.id);
      if (!report) {
        throw new ForbiddenException(
          `Project ${item.id} is outside this ranking scope (only approved packages with a locked CII are ranked).`,
        );
      }
      const pkg = buildNpePackageRecord(report);
      if (pkg.version !== item.version) {
        throw new BadRequestException(
          `Stale package version for ${item.id}. Sync Impact Wall and retry.`,
        );
      }
      if (gateNpePackage(pkg).status !== 'Eligible') continue;
      eligible.push({ report, pkg });
    }

    const scope = this.scopeFor(actor);
    const continuing = Boolean(body.runId);
    let run: NpeRankingRun;
    if (body.runId) {
      run = await this.requireRun(body.runId, actor);
      if (run.status === 'published') {
        throw new BadRequestException('This ranking run is already published.');
      }
      run.packageVersions = {
        ...(run.packageVersions || {}),
        ...Object.fromEntries(
          eligible.map((row) => [row.report.id, row.pkg.version]),
        ),
      };
      await this.runs.save(run);
    } else {
      run = this.runs.create({
        rubricVersion: NPE_RUBRIC_VERSION,
        scope,
        role: actor.role,
        status: 'draft',
        createdByUserId: actor.userId,
        packageVersions: Object.fromEntries(
          eligible.map((row) => [row.report.id, row.pkg.version]),
        ),
        reviewClearances: {},
        meta: { requested: eligible.length },
      });
      await this.runs.save(run);
    }

    const existing = await this.evaluations.find({ where: { runId: run.id } });
    const hasRow = new Set(existing.map((e) => e.reportId));
    let pending = eligible.filter((row) => !hasRow.has(row.report.id));

    // New run: reuse earlier successful reads of the same package version.
    if (!continuing && pending.length) {
      const reusable = await this.findReusableEvaluations(
        pending.map((row) => ({ id: row.report.id, version: row.pkg.version })),
      );
      const stillPending: typeof pending = [];
      for (const row of pending) {
        const prior = reusable.get(row.report.id);
        if (!prior) {
          stillPending.push(row);
          continue;
        }
        let score: ReturnType<typeof npeCalculate> | null = null;
        try {
          score = npeCalculate(
            row.pkg.cii ?? 0,
            prior.criteria as NpeAiEvaluation['criteria'],
            run.rubricVersion,
          );
        } catch {
          stillPending.push(row);
          continue;
        }
        await this.evaluations.save(
          this.evaluations.create({
            runId: run.id,
            reportId: row.report.id,
            packageVersion: row.pkg.version,
            readComplete: true,
            flags: [],
            criteria: prior.criteria,
            claims: prior.claims,
            summary: prior.summary,
            limitations: prior.limitations,
            excellenceScore: score.total,
            scoreBreakdown: score,
            audit: {
              model: 'npe_ranking_evaluation',
              reusedFromRun: prior.runId,
              payloadVersion: NPE_PAYLOAD_VERSION,
              evidenceRead:
                (prior.audit as { evidenceRead?: unknown } | null)
                  ?.evidenceRead ?? null,
            },
          }),
        );
      }
      pending = stillPending;
    }

    const started = Date.now();
    let cursor = 0;
    const readOne = async (row: {
      report: StudentReport;
      pkg: NpePackageRecord;
    }) => {
      const evaluation = await this.evaluateOne(row.report, row.pkg);
      const score =
        evaluation.readComplete && !evaluation.flags.length
          ? (() => {
              try {
                return npeCalculate(
                  row.pkg.cii ?? 0,
                  evaluation.criteria,
                  run.rubricVersion,
                );
              } catch {
                return null;
              }
            })()
          : null;
      await this.evaluations.delete({ runId: run.id, reportId: row.report.id });
      await this.evaluations.save(
        this.evaluations.create({
          runId: run.id,
          reportId: row.report.id,
          packageVersion: row.pkg.version,
          readComplete: evaluation.readComplete,
          flags: evaluation.flags,
          criteria: evaluation.criteria,
          claims: evaluation.claims,
          summary: evaluation.summary,
          limitations: evaluation.limitations,
          excellenceScore: score?.total ?? null,
          scoreBreakdown: score,
          audit: {
            model: 'npe_ranking_evaluation',
            payloadVersion: NPE_PAYLOAD_VERSION,
            evidenceRead: evaluation.evidenceRead ?? null,
          },
        }),
      );
    };
    const worker = async () => {
      const budget = analyzeBudgetMs();
      while (Date.now() - started < budget) {
        const index = cursor++;
        if (index >= pending.length) return;
        await readOne(pending[index]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(NPE_ANALYZE_CONCURRENCY, pending.length) },
        worker,
      ),
    );

    return this.serializeRun(run.id, actor);
  }

  /**
   * Latest clean (fully read, no flags) evaluation per report for this rubric + package version,
   * from ANY scope: the AI read depends only on the package, so a project must get the same marks
   * in its university cohort as in the national one (and is never paid for twice). Callers only
   * pass reports already inside their own scope's pool.
   */
  private async findReusableEvaluations(
    wanted: Array<{ id: string; version: string }>,
  ): Promise<Map<string, NpeRankingEvaluation>> {
    const out = new Map<string, NpeRankingEvaluation>();
    if (!wanted.length) return out;
    const versionById = new Map(wanted.map((w) => [w.id, w.version]));
    const rows = await this.evaluations
      .createQueryBuilder('e')
      .innerJoin('e.run', 'r')
      // The AI read is identical across supported rubric versions (only the weights differ), so a
      // read made under any of them is reused and simply re-scored under the new run's version.
      .where('r.rubricVersion IN (:...rvs)', {
        rvs: [...NPE_SUPPORTED_RUBRIC_VERSIONS],
      })
      .andWhere('e.reportId IN (:...ids)', { ids: wanted.map((w) => w.id) })
      .andWhere('e.readComplete = true')
      .orderBy('e.createdAt', 'DESC')
      .getMany();
    for (const row of rows) {
      if (out.has(row.reportId)) continue;
      if (row.packageVersion !== versionById.get(row.reportId)) continue;
      if ((row.flags || []).length) continue;
      // Only reads made from the complete package (current payload version) are re-used.
      if (
        (row.audit as { payloadVersion?: number } | null)?.payloadVersion !==
        NPE_PAYLOAD_VERSION
      )
        continue;
      out.set(row.reportId, row);
    }
    return out;
  }

  /**
   * Everything the Ranking Studio needs to rank this actor's pool: one candidate per approved,
   * CII-locked package with its gate result, stored AI judgments, score and facets. Reads the
   * given run (or the latest one of the scope); with no run, only evaluation-free angles
   * (approved CII, hours, reach, resources) are computable.
   */
  async studioCandidates(actor: NpeActor, runId?: string) {
    const scope = this.scopeFor(actor);
    const run = runId
      ? await this.requireRun(runId, actor)
      : await this.runs.findOne({
          where: { scope },
          order: { createdAt: 'DESC' },
        });
    const { rows, rubric } = await this.buildRows(run, actor);
    const rankedRows = rows.filter(
      (r) => r.status === 'Ranked' && r.rank != null,
    );
    const reviewItems = run
      ? this.reviewItems(rows, rankedRows, run.reviewClearances || {})
      : [];
    const pendingReviews = reviewItems.filter(
      (item) =>
        (item.type === 'Validation' || item.type === 'Close comparison') &&
        !item.cleared,
    ).length;
    const candidates: StudioCandidate[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      gateOk: r.status === 'Ready' || r.status === 'Ranked',
      evaluated: r.status === 'Ranked' && !!r.scoreBreakdown,
      reason: r.reason,
      cii: r.cii,
      criteria: r.evaluation
        ? Object.fromEntries(
            Object.entries(r.evaluation.criteria || {}).map(([key, j]) => [
              key,
              { anchor: Number(j.anchor), confidence: j.confidence },
            ]),
          )
        : null,
      excellence: r.scoreBreakdown
        ? { total: r.scoreBreakdown.total, criteria: r.scoreBreakdown.criteria }
        : null,
      facets: r.facets,
    }));
    return {
      run: run
        ? {
            id: run.id,
            status: run.status,
            createdAt: run.createdAt.toISOString(),
            rubricVersion: run.rubricVersion,
          }
        : null,
      rubric,
      scope,
      candidates,
      pendingReviews,
      packageCount: rows.length,
      eligibleCount: rows.filter(
        (r) => r.status === 'Ready' || r.status === 'Ranked',
      ).length,
      heldCount: rows.filter(
        (r) => r.status === 'Review' || r.status === 'Excluded',
      ).length,
    };
  }

  /**
   * Latest revision of every distinct published ranking (within the allowed scopes) that includes
   * each report. This is the projection onto the Impact Wall flashcards: same label, filters,
   * position and publication date for everyone who may see it.
   */
  async studioRankingsForReports(reportIds: string[], scopes: string[]) {
    const out = new Map<string, Array<Record<string, unknown>>>();
    if (!this.studioPublications || !reportIds.length || !scopes.length)
      return out;
    const wanted = new Set(reportIds);
    const rows = await this.studioPublications.find({
      where: { scope: In(scopes) },
      order: { publishedAt: 'DESC' },
      take: 500,
    });
    const seen = new Set<string>();
    for (const pub of rows) {
      const key = `${pub.scope}:${pub.signature}`;
      if (seen.has(key)) continue; // an older revision of a ranking already represented
      seen.add(key);
      for (const row of pub.rows) {
        for (const reportId of row.projectIds) {
          if (!wanted.has(reportId)) continue;
          const list = out.get(reportId) ?? [];
          list.push({
            publicationId: pub.id,
            name: pub.name,
            lens: pub.lens,
            lensTitle: STUDIO_LENSES[pub.lens as StudioLens]?.title ?? pub.lens,
            groupBy: pub.groupBy,
            filters: pub.filters,
            rank: row.rank,
            of: pub.rows.length,
            label: row.label,
            metric: row.metric,
            revision: pub.revision,
            publishedAt: pub.publishedAt.toISOString(),
            movement: row.movement ?? 'new',
            previousRank: row.previousRank ?? null,
            scope: pub.scope === 'national' ? 'national' : 'university',
          });
          out.set(reportId, list);
        }
      }
    }
    return out;
  }

  /** Admin may read any project; a university only its own pool (never someone else's project). */
  async assertReportInScope(actor: NpeActor, reportId: string) {
    if (actor.role === 'ciel_admin') return;
    const pool = await this.poolReports(actor);
    if (!pool.some((r) => r.id === reportId)) {
      throw new ForbiddenException(
        'This project is outside your ranking scope.',
      );
    }
  }

  async clearReview(actor: NpeActor, runId: string, itemId: string) {
    const run = await this.requireRun(runId, actor);
    if (run.status === 'published') {
      throw new BadRequestException('This ranking run is already published.');
    }
    run.reviewClearances = { ...(run.reviewClearances || {}), [itemId]: true };
    await this.runs.save(run);
    return this.serializeRun(run.id, actor);
  }

  async publish(actor: NpeActor, runId: string) {
    const run = await this.requireRun(runId, actor);
    if (run.status === 'published') {
      const existing = await this.snapshots.findOne({
        where: { runId: run.id, scope: run.scope },
      });
      if (existing) {
        return { status: 'published', snapshotId: existing.id };
      }
    }
    const payload = await this.serializeRun(run.id, actor);
    const ranked = (payload.rows as Array<Record<string, unknown>>).filter(
      (row) => row.status === 'Ranked',
    );
    if (!ranked.length) {
      throw new BadRequestException('No ranked projects are ready to publish.');
    }
    const unread = (payload.progress as { remaining: number }).remaining;
    if (unread > 0) {
      throw new BadRequestException(
        `${unread} eligible package(s) have not been read yet, or changed since they were read. Run the analysis again before publishing, so the snapshot ranks every eligible project.`,
      );
    }
    const pending = (
      payload.reviewItems as Array<{ id: string; type: string }>
    ).filter(
      (item) =>
        (item.type === 'Validation' || item.type === 'Close comparison') &&
        !run.reviewClearances?.[item.id],
    );
    if (pending.length) {
      throw new BadRequestException(
        `Required reviews are still open (${pending.length}). Clear the review queue first.`,
      );
    }
    const standings: NpeSnapshotStanding[] = ranked.map((row) => ({
      reportId: String(row.id),
      title: String(row.title),
      university: String(row.university),
      excellenceScore: Number(row.score),
      rank: Number(row.rank),
      cii: typeof row.cii === 'number' ? row.cii : null,
    }));
    const snapshot = this.snapshots.create({
      runId: run.id,
      scope: run.scope,
      rubricVersion: run.rubricVersion,
      standings,
      publishedByUserId: actor.userId,
    });
    await this.snapshots.save(snapshot);
    run.status = 'published';
    await this.runs.save(run);
    // Existing badges follow the ranking that was just published (never blocks the publish).
    try {
      const national = run.scope === 'national';
      await this.communityAward.syncBadgesToPublishedRanking(
        national ? 'ciel' : 'uni',
        national
          ? `CIEL PK National Ranking (${run.rubricVersion})`
          : `${actor.organizationName || 'University'} University Cohort`,
        standings.map((row) => ({
          reportId: row.reportId,
          rank: row.rank,
          score: row.excellenceScore,
        })),
      );
    } catch (err) {
      this.logger.warn(
        `Badge sync after publish failed: ${(err as Error).message}`,
      );
    }
    return { status: 'published', snapshotId: snapshot.id };
  }

  async decorateAwardCards<T extends { id: string; university?: string }>(
    cards: T[],
    actor?: NpeActor | null,
  ): Promise<Array<T & { npeStanding?: NpeStanding }>> {
    const national = await this.latestSnapshot('national');
    const uniScope =
      actor?.role === 'university' && actor.organizationId
        ? `university:${actor.organizationId}`
        : null;
    const university = uniScope ? await this.latestSnapshot(uniScope) : null;
    const nationalMap = new Map(
      (national?.standings || []).map((s) => [s.reportId, s]),
    );
    const uniMap = new Map(
      (university?.standings || []).map((s) => [s.reportId, s]),
    );
    const studioScopes = ['national', ...(uniScope ? [uniScope] : [])];
    const studio = await this.studioRankingsForReports(
      cards.map((card) => card.id),
      studioScopes,
    ).catch(() => new Map<string, Array<Record<string, unknown>>>());
    return cards.map((rawCard) => {
      const studioRankings = studio.get(rawCard.id);
      const card = studioRankings?.length
        ? { ...rawCard, studioRankings }
        : rawCard;
      const nat = nationalMap.get(card.id);
      const uni = uniMap.get(card.id);
      if (!nat && !uni) return card;
      return {
        ...card,
        npeStanding: {
          snapshotId: nat ? national!.id : university!.id,
          scope: nat ? 'national' : uniScope || 'university',
          excellenceScore: nat?.excellenceScore ?? uni!.excellenceScore,
          nationalRank: nat?.rank ?? null,
          universityRank: uni?.rank ?? null,
          publishedAt: (nat
            ? national!.publishedAt
            : university!.publishedAt
          ).toISOString(),
        },
      };
    });
  }

  /** Latest published standings for a scope (`national` | `university:<orgId>`), or null. */
  async publishedStandings(scope: string) {
    const snap = await this.latestSnapshot(scope);
    if (!snap?.standings?.length) return null;
    return {
      snapshotId: snap.id,
      publishedAt: snap.publishedAt,
      standings: snap.standings.map((s) => ({
        reportId: s.reportId,
        rank: s.rank,
        score: s.excellenceScore,
      })),
    };
  }

  private async latestSnapshot(scope: string) {
    return this.snapshots.findOne({
      where: { scope },
      order: { publishedAt: 'DESC' },
    });
  }

  private async poolReports(actor: NpeActor): Promise<StudentReport[]> {
    const cards =
      actor.role === 'ciel_admin'
        ? await this.communityAward.listForAdmin()
        : await this.communityAward.listForUniversity(
            actor.organizationId || '',
          );
    const ids = cards.map((c) => c.id);
    if (!ids.length) return [];
    const rows = await this.reports.find({
      where: { id: In(ids) },
      relations: [
        'student',
        'faculty',
        'opportunity',
        'opportunity.organization',
      ],
    });
    // The ranking compares only projects whose CII has been approved AND locked. Unlocked packages
    // would just sit in the review queue as noise and can never be ranked.
    const locked = rows.filter((r) => isCiiFacultyLocked(r.ciiV45Lock));
    await this.hydrateLiveHours(locked);
    return locked;
  }

  /**
   * The "required individual hours" gate reads `section1` — but the stored report JSON is whatever
   * the student's browser last saved, and teammates' hours live in the attendance_logs table (the
   * same source the submit gate checks). Without this, an approved package whose stored JSON lacks
   * per-member hours is held as "Required individual hours not verified" forever and never ranked.
   * Overlays the live roster (one canonical seat per person) and live logs onto an in-memory copy of
   * section1; nothing is written back to the report.
   */
  async hydrateLiveHours(reports: StudentReport[]): Promise<void> {
    if (!this.attendanceLogs || !this.participations || !reports.length) return;
    const projectIds = [
      ...new Set(
        reports
          .map((r) => String(r.opportunityId || r.project_id || '').trim())
          .filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
      ),
    ];
    if (!projectIds.length) return;
    const [seats, logs] = await Promise.all([
      this.participations.find({
        where: { projectId: In(projectIds), status: Not('rejected') },
      }),
      this.attendanceLogs.find({ where: { projectId: In(projectIds) } }),
    ]);
    const seatsByProject = new Map<string, Participation[]>();
    for (const seat of seats) {
      seatsByProject.set(seat.projectId, [
        ...(seatsByProject.get(seat.projectId) ?? []),
        seat,
      ]);
    }
    const logsByProject = new Map<string, AttendanceLog[]>();
    for (const log of logs) {
      logsByProject.set(log.projectId, [
        ...(logsByProject.get(log.projectId) ?? []),
        log,
      ]);
    }

    for (const report of reports) {
      const projectId = String(
        report.opportunityId || report.project_id || '',
      ).trim();
      const projectSeats = seatsByProject.get(projectId) ?? [];
      if (!projectSeats.length) continue;
      const groups = groupSiblingSeats(projectSeats);
      const canonicalOf = (seatId: string) =>
        groups.get(seatId)?.canonical ?? null;
      const mine =
        projectSeats.find((p) => p.studentId === report.studentId) ?? null;
      // Scope to the author's team (same rule as the report dossier); a solo author is judged alone.
      let scoped = projectSeats;
      if (mine?.teamId)
        scoped = projectSeats.filter((p) => p.teamId === mine.teamId);
      else if (mine?.applicationId)
        scoped = projectSeats.filter(
          (p) => p.applicationId === mine.applicationId,
        );
      else if (mine) scoped = [mine];
      const canonicalSeats = scoped.filter(
        (p) => canonicalOf(p.id)?.id === p.id,
      );
      if (!canonicalSeats.length) continue;
      const seatIds = new Set(scoped.map((p) => p.id));

      const liveLogs = (logsByProject.get(projectId) ?? [])
        .filter((l) => seatIds.has(l.participantId))
        .map((l) => {
          const seat = canonicalOf(l.participantId);
          return {
            id: l.id,
            participantId: seat?.id ?? l.participantId,
            studentId: seat?.studentId ?? null,
            date: l.dateOfEngagement,
            hours: Number(l.sessionHours) || 0,
            approval_status: l.approvalStatus ?? null,
            entryStatus: l.entryStatus ?? null,
          };
        });
      const hoursFor = (seatId: string) =>
        liveLogs
          .filter(
            (l) =>
              l.participantId === seatId &&
              String(l.approval_status || '').toLowerCase() !== 'rejected',
          )
          .reduce((sum, l) => sum + l.hours, 0);
      const toPerson = (p: Participation) => ({
        id: p.id,
        participantId: p.id,
        studentId: p.studentId ?? null,
        fullName: p.fullName ?? null,
        email: p.email ?? null,
        hours: hoursFor(p.id),
      });

      const leadSeat =
        canonicalSeats.find((p) => p.isTeamLead) ??
        canonicalSeats.find((p) => p.studentId === report.studentId) ??
        canonicalSeats[0];
      const members = canonicalSeats.filter((p) => p.id !== leadSeat.id);
      const stored =
        report.section1 &&
        typeof report.section1 === 'object' &&
        !Array.isArray(report.section1)
          ? (report.section1 as Record<string, unknown>)
          : {};
      const storedLead =
        stored.team_lead &&
        typeof stored.team_lead === 'object' &&
        !Array.isArray(stored.team_lead)
          ? (stored.team_lead as Record<string, unknown>)
          : {};
      report.section1 = {
        ...stored,
        participation_type: members.length
          ? 'team'
          : stored.participation_type || 'individual',
        team_lead: { ...storedLead, ...toPerson(leadSeat) },
        team_members: members.map(toPerson),
        attendance_logs: liveLogs,
      } as unknown as StudentReport['section1'];
    }
  }

  private async requireRun(runId: string, actor: NpeActor) {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException('Ranking run not found.');
    if (run.scope !== this.scopeFor(actor)) {
      throw new ForbiddenException('This ranking run is outside your scope.');
    }
    return run;
  }

  private async evaluateOne(
    report: StudentReport,
    pkg: NpePackageRecord,
  ): Promise<NpeAiEvaluation> {
    const files = collectReportEvidenceFiles(report);
    const payload = buildNpeAiPayload(report, pkg, files);
    try {
      const { npeRanking, evidenceInspection } = await this.ai.summarize(
        'npe_ranking_evaluation',
        payload,
      );
      if (!npeRanking) {
        return unreadNpeEvaluation(report.id, pkg.version, [
          'AI did not return a readable ranking evaluation.',
        ]);
      }
      const unread = (evidenceInspection?.notInspected || []).filter((file) =>
        /could not be loaded|too large|unsupported image/i.test(file.reason),
      );
      if (unread.length) {
        return {
          ...npeRanking,
          projectId: report.id,
          packageVersion: pkg.version,
          readComplete: false,
          flags: [
            ...npeRanking.flags,
            ...unread.map(
              (file) => `Could not read ${file.name}: ${file.reason}`,
            ),
          ],
          evidenceRead: evidenceInspection ?? null,
        };
      }
      return {
        ...npeRanking,
        projectId: report.id,
        packageVersion: pkg.version,
        flags: npeRanking.flags,
        evidenceRead: evidenceInspection ?? null,
      };
    } catch (err) {
      return unreadNpeEvaluation(report.id, pkg.version, [
        describeAiFailure(err),
      ]);
    }
  }

  /**
   * Every package in the actor's pool with its gate / evaluation / score, scored under the run's
   * rubric version. `run` may be null (nothing analysed yet): then no package has an evaluation.
   * Shared by the run payload and the Ranking Studio so both always agree.
   */
  private async buildRows(
    run: NpeRankingRun | null,
    actor: NpeActor,
    liveResults?: NpeAiEvaluation[],
  ) {
    const rubric = run?.rubricVersion || NPE_RUBRIC_VERSION;
    const reports = await this.poolReports(actor);
    const stored = run
      ? await this.evaluations.find({ where: { runId: run.id } })
      : [];
    const evalById = new Map(stored.map((row) => [row.reportId, row]));
    const liveById = new Map(
      (liveResults || []).map((row) => [row.projectId, row]),
    );

    const facetsById = new Map(
      reports.map((r) => [r.id, buildStudioFacets(r)]),
    );
    const computed = reports.map((report) => {
      const pkg = buildNpePackageRecord(report);
      const gate = gateNpePackage(pkg);
      const live = liveById.get(report.id);
      // A read only counts for the package version it was made from: if the student's report changed
      // (re-submitted / re-approved) since, the old judgment must not rank the new content.
      const storedEval = evalById.get(report.id);
      const staleRead = Boolean(
        storedEval && storedEval.packageVersion !== pkg.version,
      );
      const saved = staleRead ? undefined : storedEval;
      const evaluation: NpeAiEvaluation | null = live
        ? live
        : saved
          ? {
              projectId: saved.reportId,
              packageVersion: saved.packageVersion,
              readComplete: saved.readComplete,
              flags: saved.flags || [],
              summary: saved.summary,
              limitations: saved.limitations,
              criteria: saved.criteria as NpeAiEvaluation['criteria'],
              claims: (saved.claims || []) as NpeAiEvaluation['claims'],
            }
          : null;
      const evidenceRead =
        evaluation?.evidenceRead ??
        (
          saved?.audit as {
            evidenceRead?: NpeAiEvaluation['evidenceRead'];
          } | null
        )?.evidenceRead ??
        null;
      let status = gate.status;
      let reason = gate.reason;
      if (status === 'Eligible' && evaluation) {
        if (!evaluation.readComplete || evaluation.flags.length) {
          status = 'Review';
          reason =
            evaluation.flags.join('; ') ||
            'Material evidence could not be read.';
        } else {
          status = 'Ranked';
        }
      } else if (status === 'Eligible') {
        status = 'Ready';
        reason = staleRead
          ? 'The report changed since it was read. Run the analysis again.'
          : 'Awaiting analysis';
      }
      let score: ReturnType<typeof npeCalculate> | null = null;
      if (evaluation && status === 'Ranked' && pkg.cii != null) {
        try {
          score = npeCalculate(pkg.cii, evaluation.criteria, rubric);
        } catch {
          status = 'Review';
          reason =
            'AI returned incomplete criterion scores. Held without guessing marks.';
        }
      } else if (saved?.scoreBreakdown && status === 'Ranked') {
        score = saved.scoreBreakdown as ReturnType<typeof npeCalculate>;
      }
      return {
        p: pkg,
        evaluation,
        evidenceRead,
        status,
        reason,
        score,
      };
    });

    const ranked = npeRankPool(
      computed
        .filter((row) => row.status === 'Ranked' && row.score)
        .map((row) => ({
          id: row.p.id,
          total: row.score!.total,
          impact: row.score!.criteria.impact,
          sustain: row.score!.criteria.sustain,
          cii: row.p.cii ?? 0,
          row,
        })),
    );
    const rankMap = new Map(ranked.map((r) => [r.id, r.rank]));

    const rows = computed.map((row) => ({
      id: row.p.id,
      title: row.p.title,
      university: row.p.university,
      pathway: row.p.pathway,
      version: row.p.version,
      parts: row.p.parts,
      cii: row.p.cii,
      ciiLocked: row.p.ciiLocked,
      status: row.status,
      reason: row.reason,
      rank: rankMap.get(row.p.id) ?? null,
      score: row.score?.total ?? null,
      scoreBreakdown: row.score,
      evaluation: row.evaluation,
      evidenceRead: row.evidenceRead,
      package: row.p,
      facets: facetsById.get(row.p.id)!,
    }));
    return { rows, rubric };
  }

  private async serializeRun(
    runId: string,
    actor: NpeActor,
    liveResults?: NpeAiEvaluation[],
  ) {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException('Ranking run not found.');
    const { rows } = await this.buildRows(run, actor, liveResults);

    const rankedRows = rows.filter(
      (r) => r.status === 'Ranked' && r.rank != null,
    );
    const reviewItems = this.reviewItems(
      rows,
      rankedRows,
      run.reviewClearances || {},
    );

    const progress = {
      total: rows.filter((r) => r.status !== 'Excluded').length,
      analyzed: rows.filter((r) => r.evaluation).length,
      remaining: rows.filter((r) => r.status === 'Ready').length,
    };

    return {
      runId: run.id,
      progress,
      rubricVersion: run.rubricVersion,
      createdAt: run.createdAt.toISOString(),
      published: run.status === 'published',
      role: actor.role,
      scope: run.scope,
      criteria: npeCriteriaFor(run.rubricVersion),
      rows,
      reviewItems,
      reviewClearances: run.reviewClearances,
    };
  }

  private reviewItems(
    rows: Array<{
      id: string;
      title: string;
      status: string;
      reason: string;
      rank: number | null;
      score: number | null;
    }>,
    ranked: Array<{
      id: string;
      title: string;
      rank: number | null;
      score: number | null;
    }>,
    clearances: Record<string, boolean>,
  ) {
    const out: Array<{
      id: string;
      title: string;
      reason: string;
      type: string;
      cleared: boolean;
    }> = [];
    for (const row of rows) {
      if (row.status === 'Review' || row.status === 'Excluded') {
        out.push({
          id: row.id,
          title: row.title,
          reason: row.reason,
          type: row.status,
          cleared: Boolean(clearances[row.id]),
        });
      }
    }
    const ordered = ranked
      .slice()
      .sort((a, b) => (a.rank || 0) - (b.rank || 0));
    for (const row of ordered) {
      if ((row.rank || 99) <= 3) {
        const id = `${row.id}:lead`;
        out.push({
          id,
          title: row.title,
          reason:
            'Leading project: blinded second review required before publication.',
          type: 'Validation',
          cleared: Boolean(clearances[id]),
        });
      }
    }
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (
        a.score != null &&
        b.score != null &&
        Math.abs(a.score - b.score) <= 2
      ) {
        const id = `${a.id}:${b.id}:close`;
        out.push({
          id,
          title: `${a.title} ↔ ${b.title}`,
          reason:
            'Scores within 2 points. Validate source evidence and scoring consistency.',
          type: 'Close comparison',
          cleared: Boolean(clearances[id]),
        });
      }
    }
    return out;
  }
}

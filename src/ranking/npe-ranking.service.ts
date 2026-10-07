import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AiService } from '../ai/ai.service';
import { collectReportEvidenceFiles } from '../reports/collect-report-evidence.util';
import { CommunityAwardService } from '../reports/community-award.service';
import { StudentReport } from '../reports/entities/student-report.entity';
import { IMPACT_PACKAGE_CONTENT_SOURCES } from '../reports/impact-package-packet.util';
import {
  NPE_CRITERIA,
  NPE_RUBRIC_VERSION,
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

export type NpeActor = {
  userId: string;
  role: 'ciel_admin' | 'university';
  organizationId?: string | null;
  organizationName?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redactPerson(value: unknown): unknown {
  const rec = asRecord(value);
  if (!rec) return value;
  const {
    cnic: _cnic,
    cnic_number: _cnicN,
    phone: _phone,
    email: _email,
    whatsapp: _wa,
    ...rest
  } = rec;
  return rest;
}

@Injectable()
export class NpeRankingService {
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
  ) {}

  scopeFor(actor: NpeActor): string {
    if (actor.role === 'ciel_admin') return 'national';
    if (!actor.organizationId) {
      throw new ForbiddenException('University ranking requires an organization.');
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
      packages,
      run: runPayload,
    };
  }

  async analyze(
    actor: NpeActor,
    body: { rubricVersion?: string; projects: Array<{ id: string; version: string }> },
  ) {
    if (body.rubricVersion && body.rubricVersion !== NPE_RUBRIC_VERSION) {
      throw new BadRequestException('Unsupported ranking rubric version.');
    }
    const requested = body.projects || [];
    if (!requested.length) {
      throw new BadRequestException('No projects submitted for analysis.');
    }
    const pool = await this.poolReports(actor);
    const byId = new Map(pool.map((r) => [r.id, r]));
    const eligible: Array<{ report: StudentReport; pkg: NpePackageRecord }> = [];
    for (const item of requested) {
      const report = byId.get(item.id);
      if (!report) {
        throw new ForbiddenException(`Project ${item.id} is outside this ranking scope.`);
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
    const run = this.runs.create({
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

    const MAX_INLINE_AI = 8;
    const toScore = eligible.slice(0, MAX_INLINE_AI);
    const overflow = eligible.slice(MAX_INLINE_AI);
    const results: NpeAiEvaluation[] = [];
    for (const row of overflow) {
      const evaluation = unreadNpeEvaluation(row.report.id, row.pkg.version, [
        `Cohort larger than the inline AI limit (${MAX_INLINE_AI}). Filter the pool or re-run remaining projects.`,
      ]);
      results.push(evaluation);
      await this.evaluations.save(
        this.evaluations.create({
          runId: run.id,
          reportId: row.report.id,
          packageVersion: row.pkg.version,
          readComplete: false,
          flags: evaluation.flags,
          criteria: evaluation.criteria,
          claims: evaluation.claims,
          summary: evaluation.summary,
          limitations: evaluation.limitations,
          excellenceScore: null,
          scoreBreakdown: null,
          audit: { skipped: 'inline_limit' },
        }),
      );
    }
    for (const row of toScore) {
      const evaluation = await this.evaluateOne(row.report, row.pkg);
      results.push(evaluation);
      const score =
        evaluation.readComplete && !evaluation.flags.length
          ? npeCalculate(row.pkg.cii ?? 0, evaluation.criteria)
          : null;
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
          audit: { model: 'npe_ranking_evaluation' },
        }),
      );
    }

    return this.serializeRun(run.id, actor, results);
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
    const pending = (payload.reviewItems as Array<{ id: string; type: string }>).filter(
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
      rubricVersion: NPE_RUBRIC_VERSION,
      standings,
      publishedByUserId: actor.userId,
    });
    await this.snapshots.save(snapshot);
    run.status = 'published';
    await this.runs.save(run);
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
    return cards.map((card) => {
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
          publishedAt: (nat ? national!.publishedAt : university!.publishedAt).toISOString(),
        },
      };
    });
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
        : await this.communityAward.listForUniversity(actor.organizationId || '');
    const ids = cards.map((c) => c.id);
    if (!ids.length) return [];
    return this.reports.find({
      where: { id: In(ids) },
      relations: ['student', 'opportunity', 'opportunity.organization'],
    });
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
    const payload = {
      projectId: report.id,
      packageVersion: pkg.version,
      title: pkg.title,
      university: pkg.university,
      pathway: pkg.pathway,
      lockedCii: pkg.cii,
      ciiLocked: pkg.ciiLocked,
      parts: pkg.parts,
      sections: Object.fromEntries(
        IMPACT_PACKAGE_CONTENT_SOURCES.map((src) => [
          src.id,
          src.keys.map((key) => redactPerson((report as unknown as Record<string, unknown>)[key])),
        ]),
      ),
      priorCii: {
        locked: pkg.ciiLocked,
        score: pkg.cii,
        summary:
          typeof asRecord(report.ciiV45)?.analysisSummary === 'string'
            ? asRecord(report.ciiV45)?.analysisSummary
            : '',
      },
      uploaded_evidence_files: files.map((f, i) => ({
        file_id: `E${i + 1}`,
        file_name: f.name,
        url: f.url,
        file_type: f.name.split('.').pop() || '',
      })),
    };
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
            ...unread.map((file) => `Could not read ${file.name}: ${file.reason}`),
          ],
        };
      }
      return {
        ...npeRanking,
        projectId: report.id,
        packageVersion: pkg.version,
        flags: npeRanking.flags,
      };
    } catch (err) {
      return unreadNpeEvaluation(report.id, pkg.version, [
        err instanceof Error ? err.message : 'Ranking AI call failed.',
      ]);
    }
  }

  private async serializeRun(
    runId: string,
    actor: NpeActor,
    liveResults?: NpeAiEvaluation[],
  ) {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException('Ranking run not found.');
    const reports = await this.poolReports(actor);
    const stored = await this.evaluations.find({ where: { runId } });
    const evalById = new Map(stored.map((row) => [row.reportId, row]));
    const liveById = new Map((liveResults || []).map((row) => [row.projectId, row]));

    const computed = reports.map((report) => {
      const pkg = buildNpePackageRecord(report);
      const gate = gateNpePackage(pkg);
      const live = liveById.get(report.id);
      const saved = evalById.get(report.id);
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
        reason = 'Awaiting analysis';
      }
      let score: ReturnType<typeof npeCalculate> | null = null;
      if (evaluation && status === 'Ranked' && pkg.cii != null) {
        try {
          score = npeCalculate(pkg.cii, evaluation.criteria);
        } catch {
          status = 'Review';
          reason = 'AI returned incomplete criterion scores. Held without guessing marks.';
        }
      } else if (saved?.scoreBreakdown && status === 'Ranked') {
        score = saved.scoreBreakdown as ReturnType<typeof npeCalculate>;
      }
      return {
        p: pkg,
        evaluation,
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
      package: row.p,
    }));

    const rankedRows = rows.filter((r) => r.status === 'Ranked' && r.rank != null);
    const reviewItems = this.reviewItems(rows, rankedRows, run.reviewClearances || {});

    return {
      runId: run.id,
      rubricVersion: run.rubricVersion,
      createdAt: run.createdAt.toISOString(),
      published: run.status === 'published',
      role: actor.role,
      scope: run.scope,
      criteria: NPE_CRITERIA,
      rows,
      reviewItems,
      reviewClearances: run.reviewClearances,
    };
  }

  private reviewItems(
    rows: Array<{ id: string; title: string; status: string; reason: string; rank: number | null; score: number | null }>,
    ranked: Array<{ id: string; title: string; rank: number | null; score: number | null }>,
    clearances: Record<string, boolean>,
  ) {
    const out: Array<{ id: string; title: string; reason: string; type: string; cleared: boolean }> = [];
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
          reason: 'Leading project: blinded second review required before publication.',
          type: 'Validation',
          cleared: Boolean(clearances[id]),
        });
      }
    }
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (a.score != null && b.score != null && Math.abs(a.score - b.score) <= 2) {
        const id = `${a.id}:${b.id}:close`;
        out.push({
          id,
          title: `${a.title} ↔ ${b.title}`,
          reason: 'Scores within 2 points. Validate source evidence and scoring consistency.',
          type: 'Close comparison',
          cleared: Boolean(clearances[id]),
        });
      }
    }
    return out;
  }
}

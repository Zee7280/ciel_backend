/**
 * Ranking Studio + NPE-1.2 formula, end to end through the real routes (real Nest app + scratch
 * Postgres). AI is never called: evaluations are seeded exactly as a finished analysis stores them.
 * Also proves the pre-existing flow (packages -> reviews -> official publish -> badges) and old
 * NPE-1.1 runs keep working.
 */
import request from 'supertest';
import { DeepPartial, Repository } from 'typeorm';
import { bootHarness, Harness, E2eUser, oppPayload, uniq } from './e2e/harness';
import { adminApprove } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { Opportunity } from '../src/opportunities/entities/opportunity.entity';
import { StudentReport } from '../src/reports/entities/student-report.entity';
import { NpeRankingRun } from '../src/ranking/entities/npe-ranking-run.entity';
import { NpeRankingEvaluation } from '../src/ranking/entities/npe-ranking-evaluation.entity';
import {
  npeCalculate,
  NpeCriterionJudgment,
} from '../src/ranking/npe-ranking.scoring';
import { npePackageVersion } from '../src/ranking/npe-ranking-eligibility';
import {
  NPE_CRITERIA,
  NPE_CRITERION_KEYS,
  NpeCriterionKey,
  npeCriteriaFor,
} from '../src/ranking/npe-ranking.constants';

const BASE = '/admin/community-service/ranking';

/** A supertest response whose JSON body is known to have shape `T`. */
type Res<T> = Omit<request.Response, 'body'> & { body: T };
const typed = <T>(t: request.Test): Promise<Res<T>> =>
  t.then((r) => r as Res<T>);

/** Column-level patch for `h.opps.update` (the entity's jsonb columns are `any`). */
type OppPatch = Partial<Opportunity>;
type ReportPatch = Parameters<Repository<StudentReport>['update']>[1];
type Judgments = Record<NpeCriterionKey, NpeCriterionJudgment>;

// Response shapes, limited to the fields these tests inspect.
interface PackageRow {
  id: string;
  status: string;
  score: number | null;
  scoreBreakdown: { cii: number };
}
interface StudioRow {
  id: string;
  label: string;
  rank: number | null;
  metric: number;
  projectCount?: number;
}
interface Criterion {
  weight: number;
}
interface ReviewItem {
  id: string;
  type: string;
  cleared: boolean;
}
interface PackagesRes {
  data: {
    rubricVersion: string;
    criteria: Criterion[];
    packages: unknown[];
    run: {
      runId: string;
      rubricVersion: string;
      rows: PackageRow[];
      criteria: Criterion[];
      reviewItems: ReviewItem[];
    };
  };
}
interface PreviewRes {
  message?: string;
  data: {
    scope: string;
    rubricVersion: string;
    result: { name: string; rows: StudioRow[] };
    counts: unknown;
    options: { university: string[]; skills: string[] };
    publishBlockers: string[];
  };
}
interface Publication {
  id: string;
  [k: string]: unknown;
}
interface PublishRes {
  message?: string;
  data: { status: string; publication: Publication; snapshotId?: string };
}
interface PublicationDetailRes {
  data: { rows: StudioRow[] };
}
interface HistoryRes {
  data: Array<{ id: string; revision: number }>;
}
interface ListRes {
  data: unknown[];
}
interface MessageRes {
  message?: string;
}
interface AwardCard {
  id: string;
  studioRankings?: unknown[];
  npeStanding?: unknown;
}
interface AwardCardsRes {
  data?: { cards?: AwardCard[] };
}

type Spec = {
  name: string;
  university: string;
  department: string;
  sdg: number;
  skill: string;
  city: string;
  cii: number;
  hours: number;
  reach: number;
  anchors: number; // every criterion gets this anchor (impact gets +0.0)
  impact?: number;
};

describe('Ranking Studio (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  let ngo: E2eUser;
  let org: Awaited<ReturnType<Harness['makeOrg']>>;
  const ids: Record<string, string> = {};
  const versions: Record<string, string> = {};
  let run: NpeRankingRun;

  const judgment = (anchor: number) => ({
    anchor,
    confidence: 'high',
    reason: 'seeded',
    claimIds: ['c1'],
  });

  const seedReport = async (spec: Spec, over: Partial<StudentReport> = {}) => {
    const student = await h.makeUser(UserRole.STUDENT, {
      overrides: {
        university: spec.university,
        department: spec.department,
      },
    });
    const created = await h
      .as(ngo)
      .post('/opportunities')
      .send(oppPayload({ title: `${spec.name} ${uniq()}` }));
    expect(created.status).toBe(201);
    const oppId = (created.body as { id: string }).id;
    await adminApprove(h, admin, oppId);
    await h.opps.update(oppId, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: {
        type: 'fixed',
        start_date: '2026-01-10',
        end_date: '2026-02-10',
        expected_hours: 10,
        volunteers_required: 5,
      },
      location: { city: spec.city },
    } as OppPatch);
    const reports = h.ds.getRepository(StudentReport);
    const row = await reports.save(
      reports.create({
        studentId: student.id,
        opportunityId: oppId,
        project_id: oppId,
        status: 'verified',
        faculty_status: 'approved',
        admin_status: 'approved',
        partner_status: 'not_applicable',
        reportSubmittedAt: new Date('2026-03-15T10:00:00Z'),
        submission_date: new Date('2026-03-15T10:00:00Z'),
        section1: {
          participation_type: 'individual',
          team_lead: {
            name: student.email,
            university: spec.university,
            degree: spec.department,
            hours: spec.hours,
          },
          metrics: { total_verified_hours: spec.hours },
        },
        section2: { problem_statement: 'x' },
        section3: { primary_sdg: { goal_number: spec.sdg } },
        section4: {
          project_summary: { distinct_total_beneficiaries: spec.reach },
        },
        section8: { media_visible: 'public' },
        section9: { skills_grown: [`🎯 ${spec.skill}`] },
        review_package: { packet_integrity: { ok: true } },
        ciiV45: { finalCII: spec.cii },
        ciiV45Lock: {
          locked: true,
          adminApprovedScore: spec.cii,
          scoreStatusAtLock: 'FINAL',
          finalBadge: { name: 'Advanced' },
        },
        ...over,
      } as DeepPartial<StudentReport>),
    );
    ids[spec.name] = row.id;
    versions[spec.name] = npePackageVersion(row); // a read only counts for the package version it was made from
    return row;
  };

  const seedEvaluation = async (
    runId: string,
    reportId: string,
    spec: Spec,
  ) => {
    const criteria = Object.fromEntries(
      NPE_CRITERION_KEYS.map((k) => [
        k,
        judgment(
          k === 'impact' && spec.impact != null ? spec.impact : spec.anchors,
        ),
      ]),
    );
    await h.ds.getRepository(NpeRankingEvaluation).save(
      h.ds.getRepository(NpeRankingEvaluation).create({
        runId,
        reportId,
        packageVersion: versions[spec.name],
        readComplete: true,
        flags: [],
        criteria,
        claims: [],
        summary: 's',
        limitations: 'l',
      } as DeepPartial<NpeRankingEvaluation>),
    );
  };

  const specs: Spec[] = [
    {
      name: 'Alpha',
      university: 'Uni A',
      department: 'CS',
      sdg: 4,
      skill: 'Leadership',
      city: 'Lahore',
      cii: 90,
      hours: 40,
      reach: 300,
      anchors: 4.5,
    },
    {
      name: 'Bravo',
      university: 'Uni A',
      department: 'CS',
      sdg: 4,
      skill: 'Teamwork',
      city: 'Lahore',
      cii: 70,
      hours: 25,
      reach: 100,
      anchors: 3.5,
    },
    {
      name: 'Charlie',
      university: 'Uni B',
      department: 'Arts',
      sdg: 6,
      skill: 'Leadership',
      city: 'Karachi',
      cii: 80,
      hours: 60,
      reach: 50,
      anchors: 4,
    },
    {
      name: 'Delta',
      university: 'Uni B',
      department: 'Arts',
      sdg: 4,
      skill: 'Empathy',
      city: 'Karachi',
      cii: 60,
      hours: 15,
      reach: 700,
      anchors: 2.5,
    },
  ];

  beforeAll(async () => {
    h = await bootHarness();
    // the national pool is global: start from no reports so only this file's projects exist
    await h.ds.query(
      'TRUNCATE student_reports, npe_ranking_evaluations, npe_ranking_snapshots, npe_studio_publications, npe_ranking_runs CASCADE',
    );
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    org = await h.makeOrg(`Studio NGO ${uniq()}`);
    ngo = await h.makeUser(UserRole.NGO, { org });
    for (const s of specs) await seedReport(s);
    run = await h.ds.getRepository(NpeRankingRun).save(
      h.ds.getRepository(NpeRankingRun).create({
        rubricVersion: 'NPE-1.2',
        scope: 'national',
        role: 'ciel_admin',
        status: 'draft',
        createdByUserId: admin.id,
        packageVersions: {},
        reviewClearances: {},
        meta: {},
      } as DeepPartial<NpeRankingRun>),
    );
    for (const s of specs) await seedEvaluation(run.id, ids[s.name], s);
  });
  afterAll(async () => {
    await h.ds.query(
      'TRUNCATE student_reports, npe_ranking_evaluations, npe_ranking_snapshots, npe_studio_publications, npe_ranking_runs CASCADE',
    );
    await h.app.close();
  });

  const preview = (
    body: Record<string, unknown> = {},
    user: E2eUser | null = admin,
  ) => typed<PreviewRes>(h.as(user).post(`${BASE}/studio/preview`).send(body));
  const publish = (body: Record<string, unknown>) =>
    typed<PublishRes>(h.as(admin).post(`${BASE}/studio/publish`).send(body));
  const packages = () =>
    typed<PackagesRes>(h.as(admin).get(`${BASE}/packages`));
  const expectedTotal = (s: Spec) =>
    npeCalculate(
      s.cii,
      Object.fromEntries(
        NPE_CRITERION_KEYS.map((k) => [
          k,
          judgment(k === 'impact' && s.impact != null ? s.impact : s.anchors),
        ]),
      ) as Judgments,
      'NPE-1.2',
    ).total;

  // ---------------------------------------------------------------- access
  it('only the CIEL PK admin may use the studio: students, NGOs, faculty and anonymous callers are refused', async () => {
    const student = await h.makeUser(UserRole.STUDENT);
    const faculty = await h.makeUser(UserRole.FACULTY);
    for (const u of [student, ngo, faculty]) {
      expect((await preview({}, u)).status).toBe(403);
      expect(
        (await h.as(u).post(`${BASE}/studio/publish`).send({})).status,
      ).toBe(403);
      expect((await h.as(u).get(`${BASE}/studio/history`)).status).toBe(403);
    }
    expect((await preview({}, null)).status).toBe(401);
  });

  // ---------------------------------------------------------------- the NPE-1.2 formula
  it('the packages route reports NPE-1.2 with weights that sum to 100 (90 criteria + 10 CII)', async () => {
    const res = await packages();
    expect(res.status).toBe(200);
    expect(res.body.data.rubricVersion).toBe('NPE-1.2');
    const total = res.body.data.criteria.reduce((s, c) => s + c.weight, 0);
    expect(total).toBe(90);
    expect(res.body.data.packages).toHaveLength(4);
    expect(res.body.data.run.rubricVersion).toBe('NPE-1.2');
    // every ranked row carries the NPE-1.2 score, recomputed from the stored judgments
    for (const row of res.body.data.run.rows) {
      const spec = specs.find((s) => ids[s.name] === row.id)!;
      expect(row.status).toBe('Ranked');
      expect(row.score).toBe(expectedTotal(spec));
      expect(row.scoreBreakdown.cii).toBeCloseTo(
        Math.min(100, spec.cii) * 0.1,
        10,
      );
    }
  });

  // ---------------------------------------------------------------- preview
  it('overall excellence ranks every eligible project by the NPE-1.2 score', async () => {
    const res = await preview({ lens: 'excellence', groupBy: 'project' });
    expect(res.status).toBe(201);
    const { result } = res.body.data;
    const expected = [...specs]
      .sort((a, b) => expectedTotal(b) - expectedTotal(a))
      .map((s) => ids[s.name]);
    expect(result.rows.map((r) => r.id)).toEqual(expected);
    expect(result.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(result.name).toBe(
      'Overall Project Excellence — All eligible projects',
    );
    expect(res.body.data.counts).toMatchObject({
      packages: 4,
      eligible: 4,
      held: 0,
      inRanking: 4,
    });
    expect(res.body.data.options.university).toEqual(['Uni A', 'Uni B']);
    expect(res.body.data.options.skills).toEqual([
      'Empathy',
      'Leadership',
      'Teamwork',
    ]);
  });

  it('each angle ranks by its own measure, and filters narrow the audience first', async () => {
    const top = async (body: Record<string, unknown>) =>
      (await preview(body)).body.data.result.rows.map((r) =>
        r.label.replace(/ [0-9a-f]{8}$/, ''),
      );
    expect(await top({ lens: 'cii' })).toEqual([
      'Alpha',
      'Charlie',
      'Bravo',
      'Delta',
    ]);
    expect(await top({ lens: 'hours' })).toEqual([
      'Charlie',
      'Alpha',
      'Bravo',
      'Delta',
    ]);
    expect(await top({ lens: 'reach' })).toEqual([
      'Delta',
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(await top({ lens: 'impact' })).toEqual([
      'Alpha',
      'Charlie',
      'Bravo',
      'Delta',
    ]);
    expect(
      await top({ lens: 'excellence', filters: { university: 'Uni B' } }),
    ).toEqual(['Charlie', 'Delta']);
    expect(
      await top({
        lens: 'excellence',
        filters: { sdg: 'SDG 4', skills: 'Leadership' },
      }),
    ).toEqual(['Alpha']);
    expect(
      await top({ lens: 'excellence', filters: { year: '2026', month: '03' } }),
    ).toHaveLength(4);
    expect(
      await top({ lens: 'excellence', filters: { year: '2025' } }),
    ).toEqual([]);
    expect(
      await top({ lens: 'excellence', filters: { minHours: 30 } }),
    ).toEqual(['Alpha', 'Charlie']);
    expect(
      await top({
        lens: 'excellence',
        filters: { city: 'Karachi', minCii: 70 },
      }),
    ).toEqual(['Charlie']);
  });

  it('comparing universities uses the mean of project scores and shows sample sizes', async () => {
    const res = await preview({ lens: 'excellence', groupBy: 'university' });
    const rows = res.body.data.result.rows;
    const mean = (names: string[]) =>
      names
        .map((n) => expectedTotal(specs.find((s) => s.name === n)!))
        .reduce((a, b) => a + b, 0) / names.length;
    expect(rows.map((r) => [r.id, r.projectCount])).toEqual([
      ['Uni A', 2],
      ['Uni B', 2],
    ]);
    expect(rows[0].metric).toBeCloseTo(mean(['Alpha', 'Bravo']), 1);
    expect(rows[1].metric).toBeCloseTo(mean(['Charlie', 'Delta']), 1);
    expect(res.body.data.result.name).toBe(
      'Top Universities · Overall Project Excellence — All eligible projects',
    );
    const skills = (await preview({ lens: 'cii', groupBy: 'skill' })).body.data
      .result.rows;
    expect(skills.find((r) => r.id === 'Leadership')!.projectCount).toBe(2);
  });

  it('custom weighting blends impact, sustainability, learning and locked CII, and is scale-free', async () => {
    const a = await preview({
      lens: 'custom',
      weights: { impact: 100, sustain: 0, learning: 0, cii: 0 },
    });
    expect(a.body.data.result.rows[0].metric).toBe(90); // Alpha impact anchor 4.5 -> 90%
    const w1 = await preview({
      lens: 'custom',
      weights: { impact: 35, sustain: 20, learning: 25, cii: 20 },
    });
    const w2 = await preview({
      lens: 'custom',
      weights: { impact: 70, sustain: 40, learning: 50, cii: 40 },
    });
    expect(w1.body.data.result.rows.map((r) => r.metric)).toEqual(
      w2.body.data.result.rows.map((r) => r.metric),
    );
  });

  it('bad input is a 400 with a reason; junk filters are ignored; nothing is a 500', async () => {
    expect((await preview({ lens: 'nonsense' })).status).toBe(400);
    expect((await preview({ groupBy: 'nonsense' })).status).toBe(400);
    expect(
      (
        await preview({
          filters: { dateFrom: '2026-12-31', dateTo: '2026-01-01' },
        })
      ).status,
    ).toBe(400);
    const junk = await preview({
      filters: {
        evil: 'x',
        university: 123,
        minHours: 'abc',
        skills: ['array'],
      },
      weights: 'nope',
    });
    expect(junk.status).toBe(201);
    expect(junk.body.data.result.rows).toHaveLength(4);
    expect(
      (await preview({ runId: '00000000-0000-4000-8000-000000000000' })).status,
    ).toBeLessThan(500);
    expect((await preview({ runId: 'not-a-uuid' })).status).toBeLessThan(500);
  });

  // ---------------------------------------------------------------- publishing
  it('an evidence-based ranking cannot be published until the required reviews are cleared; then it can', async () => {
    const body = { lens: 'excellence', groupBy: 'project' };
    const blocked = await publish(body);
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/review/i);
    expect((await preview(body)).body.data.publishBlockers.join(' ')).toMatch(
      /review/i,
    );

    // clear the review queue through the existing route, exactly as the admin does
    const pk = await packages();
    const items = pk.body.data.run.reviewItems.filter(
      (i) =>
        (i.type === 'Validation' || i.type === 'Close comparison') &&
        !i.cleared,
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const cleared = await h
        .as(admin)
        .post(`${BASE}/reviews`)
        .send({ runId: run.id, itemId: item.id });
      expect(cleared.status).toBe(201);
    }
    expect((await preview(body)).body.data.publishBlockers).toEqual([]);
  });

  it('publishes a named ranking once, recognises an unchanged re-publish, and records revisions with movement', async () => {
    const body = {
      lens: 'hours',
      groupBy: 'university',
      filters: { year: '2026' },
    };
    const first = await publish(body);
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('published');
    const pub = first.body.data.publication;
    expect(pub).toMatchObject({
      revision: 1,
      lens: 'hours',
      groupBy: 'university',
      cohortComparable: false,
      name: 'Top Universities · Verified Service Hours — 2026',
    });

    // double click / retry: nothing new is created
    const again = await publish(body);
    expect(again.body.data.status).toBe('unchanged');
    expect(again.body.data.publication.id).toBe(pub.id);

    // one project logs far more hours -> standings change -> revision 2, same cohort, movement recorded
    // (written as the live rows look: team_lead.hours is a number here, not as the entity types it)
    await h.ds.getRepository(StudentReport).update(ids['Alpha'], {
      section1: {
        participation_type: 'individual',
        team_lead: { name: 'a', university: 'Uni A', degree: 'CS', hours: 500 },
        metrics: { total_verified_hours: 500 },
      },
    } as unknown as ReportPatch);
    const second = await publish({ ...body, name: 'Hours champions 2026' });
    expect(second.body.data.status).toBe('published');
    expect(second.body.data.publication).toMatchObject({
      revision: 2,
      cohortComparable: true,
      name: 'Hours champions 2026',
    });

    const detail = await h
      .as(admin)
      .get(`${BASE}/studio/publications/${second.body.data.publication.id}`);
    expect(detail.status).toBe(200);
    const rows = (detail.body as PublicationDetailRes).data.rows;
    // revision 1: Uni B (mean 37.5h) ahead of Uni A (32.5h); revision 2: Alpha's 500h lifts Uni A
    expect(rows.find((r) => r.id === 'Uni A')).toMatchObject({
      rank: 1,
      previousRank: 2,
      movement: 'up',
    });
    expect(rows.find((r) => r.id === 'Uni B')).toMatchObject({
      rank: 2,
      previousRank: 1,
      movement: 'down',
    });

    const history = await h.as(admin).get(`${BASE}/studio/history`);
    expect(history.status).toBe(200);
    const historyBody = history.body as HistoryRes;
    expect(historyBody.data.map((p) => p.revision).sort()).toEqual([1, 2]);
    expect(historyBody.data[0]).toHaveProperty('top');
  });

  it('a project sees every ranking it belongs to (label, filters, position, revision) on its Impact Wall', async () => {
    const res = await h
      .as(admin)
      .get(`${BASE}/studio/project/${ids['Charlie']}`);
    expect(res.status).toBe(200);
    const list = (res.body as ListRes).data;
    expect(list).toHaveLength(1); // the latest revision of the one published ranking, not both
    expect(list[0]).toMatchObject({
      name: 'Hours champions 2026',
      rank: 2,
      of: 2,
      revision: 2,
      groupBy: 'university',
      label: 'Uni B',
      scope: 'national',
      movement: 'down',
      previousRank: 1,
    });
    expect(
      (
        (
          await h
            .as(admin)
            .get(`${BASE}/studio/project/00000000-0000-4000-8000-000000000000`)
        ).body as ListRes
      ).data,
    ).toEqual([]);
    expect(
      (await h.as(admin).get(`${BASE}/studio/project/not-a-uuid`)).status,
    ).toBe(400);
    expect(
      (await h.as(admin).get(`${BASE}/studio/publications/not-a-uuid`)).status,
    ).toBe(400);
    expect(
      (
        await h
          .as(admin)
          .get(
            `${BASE}/studio/publications/00000000-0000-4000-8000-000000000000`,
          )
      ).status,
    ).toBe(404);
  });

  it('award cards carry the published studio rankings (additive field) and keep their existing fields', async () => {
    const res = await h.as(admin).get('/admin/community-service/award-cards');
    expect(res.status).toBe(200);
    const data = (res.body as AwardCardsRes).data;
    const cards = (data?.cards ?? data) as AwardCard[];
    const card = cards.find((c) => c.id === ids['Alpha']);
    expect(card).toBeTruthy();
    expect(card).toHaveProperty('project_title');
    expect(card).toHaveProperty('cii');
    expect(card!.studioRankings?.[0]).toMatchObject({
      name: 'Hours champions 2026',
      groupBy: 'university',
    });
  });

  // ---------------------------------------------------------------- existing flow is untouched
  it('the existing official publish still works end to end and stores the NPE-1.2 snapshot', async () => {
    const res = await typed<PublishRes>(
      h
        .as(admin)
        .post(`${BASE}/publish`)
        .send({ runId: run.id, rubricVersion: 'NPE-1.1' }), // an older client may still send 1.1
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('published');
    const again = await typed<PublishRes>(
      h.as(admin).post(`${BASE}/publish`).send({ runId: run.id }),
    );
    expect(again.body.data.snapshotId).toBe(res.body.data.snapshotId);
    const snap = await h.ds.query<Array<Record<string, unknown>>>(
      'select rubric_version, jsonb_array_length(standings) as n from npe_ranking_snapshots where id = $1',
      [res.body.data.snapshotId],
    );
    expect(snap[0]).toMatchObject({ rubric_version: 'NPE-1.2', n: 4 });
    const cards = await h.as(admin).get('/admin/community-service/award-cards');
    const data = (cards.body as AwardCardsRes).data;
    const list = (data?.cards ?? data) as AwardCard[];
    expect(list.find((c) => c.id === ids['Alpha'])!.npeStanding).toMatchObject({
      nationalRank: 1,
    });
  });

  it('an older NPE-1.1 run keeps its original weights and is never silently re-scored', async () => {
    const legacy = await h.ds.getRepository(NpeRankingRun).save(
      h.ds.getRepository(NpeRankingRun).create({
        rubricVersion: 'NPE-1.1',
        scope: 'national',
        role: 'ciel_admin',
        status: 'draft',
        createdByUserId: admin.id,
        packageVersions: {},
        reviewClearances: {},
        meta: {},
      } as DeepPartial<NpeRankingRun>),
    );
    for (const s of specs) await seedEvaluation(legacy.id, ids[s.name], s);
    const res = await packages();
    expect(res.body.data.run.runId).toBe(legacy.id); // latest run of the scope
    expect(res.body.data.run.rubricVersion).toBe('NPE-1.1');
    expect(res.body.data.run.criteria.reduce((s, c) => s + c.weight, 0)).toBe(
      85,
    );
    // (Delta: its anchors and CII differ in proportion, so the two weightings give different totals)
    const alpha = res.body.data.run.rows.find((r) => r.id === ids['Delta'])!;
    const spec = specs[3];
    const legacyScore = npeCalculate(
      spec.cii,
      Object.fromEntries(
        NPE_CRITERION_KEYS.map((k) => [k, judgment(spec.anchors)]),
      ) as Judgments,
      'NPE-1.1',
    ).total;
    expect(alpha.score).toBe(legacyScore);
    expect(alpha.score).not.toBe(expectedTotal(spec));
    expect(alpha.scoreBreakdown.cii).toBeCloseTo(
      Math.min(100, spec.cii) * 0.15,
      10,
    );
    // the studio reads the same run under the same version
    const studio = await preview({ runId: legacy.id, lens: 'excellence' });
    expect(studio.body.data.rubricVersion).toBe('NPE-1.1');
    expect(
      studio.body.data.result.rows.find((r) => r.id === ids['Delta'])!.metric,
    ).toBe(legacyScore);
  });

  it('the analyze route accepts any supported rubric version from an older client and rejects unknown ones', async () => {
    const unknown = await h
      .as(admin)
      .post(`${BASE}/analyze`)
      .send({
        rubricVersion: 'NPE-9.9',
        projects: [{ id: ids['Alpha'], version: 'x' }],
      });
    expect(unknown.status).toBe(400);
    expect((unknown.body as MessageRes).message).toMatch(
      /Unsupported ranking rubric/,
    );
    const old = await h
      .as(admin)
      .post(`${BASE}/analyze`)
      .send({ rubricVersion: 'NPE-1.1', projects: [] });
    expect(old.status).toBe(400);
    expect((old.body as MessageRes).message).toMatch(/No projects submitted/); // got past the version check
  });

  it('a university uses the same studio for its own cohort only and cannot read another cohort or project', async () => {
    const uniOrg = await h.makeOrg('Uni A', 'UNIVERSITY');
    const uni = await h.makeUser(UserRole.UNIVERSITY, { org: uniOrg });
    const mine = await typed<PreviewRes>(
      h
        .as(uni)
        .post('/partners/community-service/ranking/studio/preview')
        .send({ lens: 'cii' }),
    );
    expect(mine.status).toBe(201);
    expect(mine.body.data.scope).toBe(`university:${uniOrg.id}`);
    expect(mine.body.data.result.rows.length).toBeLessThanOrEqual(2); // only Uni A's reports can ever appear
    for (const row of mine.body.data.result.rows)
      expect(['Alpha', 'Bravo']).toContain(
        row.label.replace(/ [0-9a-f]{8}$/, ''),
      );
    // a project of another university is outside this cohort
    const other = await h
      .as(uni)
      .get(
        `/partners/community-service/ranking/studio/project/${ids['Charlie']}`,
      );
    expect(other.status).toBe(403);
    // the university cannot open the national publications
    const natHistory = await h.as(admin).get(`${BASE}/studio/history`);
    const natId = (natHistory.body as HistoryRes).data[0].id;
    expect(
      (
        await h
          .as(uni)
          .get(
            `/partners/community-service/ranking/studio/publications/${natId}`,
          )
      ).status,
    ).toBe(403);
    expect(
      (
        (
          await h
            .as(uni)
            .get('/partners/community-service/ranking/studio/history')
        ).body as ListRes
      ).data,
    ).toEqual([]);
    // university publishing without analysis: evidence-free angle works, evidence-based angle is blocked
    expect(
      (
        await h
          .as(uni)
          .post('/partners/community-service/ranking/studio/publish')
          .send({ lens: 'excellence' })
      ).status,
    ).toBe(400);
  });

  it('two simultaneous publishes of the same ranking create exactly one revision (no database error for the loser)', async () => {
    const body = { lens: 'reach', groupBy: 'project', name: 'Race ranking' };
    const [a, b] = await Promise.all([publish(body), publish(body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.data.status, b.body.data.status].sort()).toEqual([
      'published',
      'unchanged',
    ]);
    expect(a.body.data.publication.id).toBe(b.body.data.publication.id);
    const count = await h.ds.query<Array<{ n: number }>>(
      "select count(*)::int as n from npe_studio_publications where name = 'Race ranking'",
    );
    expect(count[0].n).toBe(1);
  });

  it('a run of another scope cannot be read through the studio', async () => {
    const uniOrg = await h.makeOrg('Uni Z', 'UNIVERSITY');
    const uni = await h.makeUser(UserRole.UNIVERSITY, { org: uniOrg });
    const res = await h
      .as(uni)
      .post('/partners/community-service/ranking/studio/preview')
      .send({ runId: run.id, lens: 'cii' });
    expect(res.status).toBe(403); // the national run is outside this university's scope
  });

  it('criteria metadata for both versions is complete', () => {
    expect(NPE_CRITERIA).toHaveLength(8);
    expect(npeCriteriaFor('NPE-1.2').map((c) => c.weight)).toEqual([
      22, 13, 9, 9, 9, 9, 9, 10,
    ]);
    expect(npeCriteriaFor('NPE-1.1').map((c) => c.weight)).toEqual([
      25, 12, 12, 10, 8, 6, 6, 6,
    ]);
  });
});

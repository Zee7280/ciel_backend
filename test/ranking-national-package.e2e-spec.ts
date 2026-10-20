/**
 * National (and university) ranking: does the COMPLETE report package reach the AI, for every
 * approved project, through the real analyze route? Real Nest app + scratch Postgres; the AI is a
 * recording stub (e2e never reaches OpenAI), so what the model would receive is asserted exactly.
 */
import { bootHarness, Harness, E2eUser, oppPayload, uniq } from './e2e/harness';
import { adminApprove } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { StudentReport } from '../src/reports/entities/student-report.entity';
import {
  NPE_CRITERION_KEYS,
  NPE_PAYLOAD_VERSION,
} from '../src/ranking/npe-ranking.constants';
import { NpeRankingRun } from '../src/ranking/entities/npe-ranking-run.entity';
import { NpeRankingEvaluation } from '../src/ranking/entities/npe-ranking-evaluation.entity';
import { npeCalculate } from '../src/ranking/npe-ranking.scoring';

const BASE = '/admin/community-service/ranking';
const UNI = '/partners/community-service/ranking';

type Seed = {
  name: string;
  university: string;
  cnic: string;
  mobile: string;
  email: string;
};
const seeds: Seed[] = [
  {
    name: 'Alpha',
    university: 'Uni A',
    cnic: '35202-1111111-1',
    mobile: '0300-1111111',
    email: 'alpha.lead@mail.pk',
  },
  {
    name: 'Bravo',
    university: 'Uni A',
    cnic: '35202-2222222-2',
    mobile: '0300-2222222',
    email: 'bravo.lead@mail.pk',
  },
  {
    name: 'Charlie',
    university: 'Uni B',
    cnic: '35202-3333333-3',
    mobile: '0300-3333333',
    email: 'charlie.lead@mail.pk',
  },
  {
    name: 'Delta',
    university: 'Uni B',
    cnic: '35202-4444444-4',
    mobile: '0300-4444444',
    email: 'delta.lead@mail.pk',
  },
];

describe('National ranking sends the complete package to the AI (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  let ngo: E2eUser;
  const ids: Record<string, string> = {};
  const received: any[] = [];
  /** per-report override of what the (stub) evidence pass could not show the model */
  const notInspected = new Map<
    string,
    Array<{ id: string; name: string; reason: string }>
  >();
  let aiCalls = 0;

  const evaluation = (projectId: string, packageVersion: string) => {
    const criteria = Object.fromEntries(
      NPE_CRITERION_KEYS.map((k) => [
        k,
        { anchor: 4, confidence: 'high', reason: 'ok', claimIds: [`${k}-1`] },
      ]),
    );
    const claims = NPE_CRITERION_KEYS.map((k) => ({
      id: `${k}-1`,
      criterion: k,
      statement: 's',
      source: 'report',
      locator: 'S4',
      support: 'high',
      limitation: 'l',
    }));
    return {
      projectId,
      packageVersion,
      readComplete: true,
      flags: [],
      summary: 'stub',
      limitations: 'stub',
      criteria,
      claims,
    };
  };

  const aiStub = {
    summarize: async (section: string, payload: any) => {
      if (section !== 'npe_ranking_evaluation') return { summary: '' };
      aiCalls += 1;
      received.push(payload);
      const files = (payload.uploaded_evidence_files ?? []) as Array<{
        file_id: string;
        file_name: string;
      }>;
      const extra = notInspected.get(payload.projectId) ?? [];
      return {
        summary: 'stub',
        npeRanking: evaluation(payload.projectId, payload.packageVersion),
        evidenceInspection: {
          inspected: files
            .filter((f) => !extra.some((e) => e.id === f.file_id))
            .map((f) => ({ id: f.file_id, name: f.file_name })),
          notInspected: extra,
        },
      };
    },
  } as any;

  beforeAll(async () => {
    h = await bootHarness({ ai: aiStub });
    // the national pool is global: start from no reports so only this file's projects exist
    await h.ds.query(
      'TRUNCATE student_reports, npe_ranking_evaluations, npe_ranking_snapshots, npe_studio_publications, npe_ranking_runs CASCADE',
    );
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    ngo = await h.makeUser(UserRole.NGO, {
      org: await h.makeOrg(`Pkg NGO ${uniq()}`),
    });
    const reports = h.ds.getRepository(StudentReport);
    for (const s of seeds) {
      const student = await h.makeUser(UserRole.STUDENT, {
        overrides: { university: s.university, department: 'CS' } as any,
      });
      const opp = await h
        .as(ngo)
        .post('/opportunities')
        .send(oppPayload({ title: `${s.name} Project ${uniq()}` }));
      expect(opp.status).toBe(201);
      await adminApprove(h, admin, opp.body.id);
      await h.opps.update(opp.body.id, {
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
        location: { city: 'Lahore' },
      } as any);
      const row: any = await reports.save(
        reports.create({
          studentId: student.id,
          opportunityId: opp.body.id,
          project_id: opp.body.id,
          status: 'verified',
          faculty_status: 'approved',
          admin_status: 'approved',
          partner_status: 'not_applicable',
          reportSubmittedAt: new Date('2026-03-15T10:00:00Z'),
          submission_date: new Date('2026-03-15T10:00:00Z'),
          primary_sdg_goal: 4,
          problem_category: 'Education',
          section1: {
            participation_type: 'team',
            team_lead: {
              name: `${s.name} Lead`,
              cnic: s.cnic,
              mobile: s.mobile,
              email: s.email,
              university: s.university,
              degree: 'CS',
              hours: 30,
            },
            team_members: [
              {
                name: `${s.name} Mate`,
                cnic: '35202-9999999-9',
                phone: '0301-9999999',
                email: `${s.name}.mate@mail.pk`,
                hours: 30,
              },
            ],
            attendance_logs: [
              {
                id: 'l1',
                date: '2026-02-01',
                hours: 30,
                description: `${s.name} taught reading`,
              },
            ],
            metrics: { total_verified_hours: 60 },
          },
          section2: {
            problem_statement: `${s.name}: children cannot read; contact ${s.email}`,
          },
          section3: { primary_sdg: { goal_number: 4 } },
          section4: {
            activity_blocks: [{ title: `${s.name} tutoring` }],
            project_summary: { distinct_total_beneficiaries: 100 },
          },
          section5: {
            observed_change: `${s.name} reading scores improved`,
            measurable_outcomes: [{ baseline: 10, endline: 40 }],
          },
          section6: {
            use_resources: 'yes',
            resources: [{ amount: 5000, unit: 'PKR' }],
          },
          section7: {
            has_partners: 'yes',
            partners: [{ name: 'Local Trust' }],
          },
          section8: {
            media_visible: 'public',
            evidence_files: [
              {
                url: `https://bkt.s3.eu.amazonaws.com/${s.name}/receipt.pdf`,
                name: 'receipt.pdf',
              },
              {
                url: `https://bkt.s3.eu.amazonaws.com/${s.name}/photo1.jpg`,
                name: 'photo1.jpg',
              },
              {
                url: `https://bkt.s3.eu.amazonaws.com/${s.name}/clip.mp4`,
                name: 'clip.mp4',
              },
            ],
          },
          section9: {
            skills_grown: ['🎯 Leadership'],
            personal_learning: `${s.name} learned`,
          },
          section10: {
            continuation_status: 'yes',
            continuation_details: `${s.name} continues`,
          },
          section11: {
            final_declaration: [true],
            signature_name: s.name,
            ai_generated_impact_score: 77,
          },
          review_package: { packet_integrity: { ok: true } },
          ciiV45: {
            finalCII: 85,
            analysisSummary: `${s.name} system analysis`,
            strengths: ['Clear baseline'],
            developmentPriorities: ['Follow-up'],
            evidenceSummary: 'Consistent',
            finalBadge: { name: 'Advanced' },
          },
          ciiV45Lock: {
            locked: true,
            adminApprovedScore: 85,
            lockedAt: '2026-04-01T00:00:00Z',
            hash: 'deadbeefcafe0000',
            scoreStatusAtLock: 'FINAL',
            finalBadge: { name: 'Advanced' },
          },
        } as any) as any,
      );
      ids[s.name] = row.id;
    }
  });
  afterAll(async () => {
    await h.ds.query(
      'TRUNCATE student_reports, npe_ranking_evaluations, npe_ranking_snapshots, npe_studio_publications, npe_ranking_runs CASCADE',
    );
    await h.app.close();
  });
  beforeEach(async () => {
    // every test starts with no earlier reads, otherwise the (intended) cross-run reuse hides the AI call
    await h.ds.query(
      'TRUNCATE npe_ranking_evaluations, npe_ranking_snapshots, npe_studio_publications, npe_ranking_runs CASCADE',
    );
    received.length = 0;
    notInspected.clear();
    aiCalls = 0;
  });

  const packages = async (base = BASE, user: E2eUser = admin) => {
    const res = await h.as(user).get(`${base}/packages`);
    expect(res.status).toBe(200);
    return res.body.data as {
      packages: Array<{ id: string; version: string }>;
      run: any;
    };
  };
  const analyzeAll = async (
    base = BASE,
    user: E2eUser = admin,
    runId?: string,
  ) => {
    const pk = await packages(base, user);
    return h
      .as(user)
      .post(`${base}/analyze`)
      .send({
        ...(runId ? { runId } : {}),
        projects: pk.packages.map((p) => ({ id: p.id, version: p.version })),
      });
  };

  it('national: every approved package of EVERY university is read, one AI request each', async () => {
    const res = await analyzeAll();
    expect(res.status).toBe(201);
    expect(res.body.data.progress).toMatchObject({
      total: 4,
      analyzed: 4,
      remaining: 0,
    });
    expect(aiCalls).toBe(4);
    expect(received.map((p) => p.projectId).sort()).toEqual(
      Object.values(ids).sort(),
    );
    expect(new Set(received.map((p) => p.university))).toEqual(
      new Set(['Uni A', 'Uni B']),
    );
    const rows = res.body.data.rows as any[];
    expect(rows.every((r) => r.status === 'Ranked')).toBe(true);
    expect(res.body.data.rubricVersion).toBe('NPE-1.2');
  });

  it('each request carries all four parts of the package: flashcard, 9 report sections, system analysis, evidence manifest', async () => {
    await analyzeAll();
    expect(received).toHaveLength(4);
    for (const p of received) {
      const name = seeds.find((s) => ids[s.name] === p.projectId)!.name;
      // 1 flashcard
      expect(p.flashcard).toMatchObject({
        university: expect.any(String),
        sdg: 'SDG 4',
        city: 'Lahore',
        teamSize: 2,
        approvedCii: 85,
        ciiBadge: 'Advanced',
        evidenceClassification: 'Public',
      });
      expect(p.flashcard.title).toContain(name);
      // 2 detailed report: all nine content sections, with this project's own words
      expect(Object.keys(p.sections)).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
      ]);
      const text = JSON.stringify(p.sections);
      for (const own of [
        `${name}: children cannot read`,
        `${name} tutoring`,
        `${name} reading scores improved`,
        'Local Trust',
        `${name} learned`,
        `${name} continues`,
        `${name} taught reading`,
      ]) {
        expect({ own, present: text.includes(own) }).toEqual({
          own,
          present: true,
        });
      }
      // 3 system analysis
      expect(p.systemAnalysis).toMatchObject({
        locked: true,
        approvedScore: 85,
        badge: 'Advanced',
        summary: `${name} system analysis`,
        strengths: ['Clear baseline'],
        developmentPriorities: ['Follow-up'],
        approvalRef: 'deadbeefcafe',
      });
      // 4 evidence manifest: every attached original
      expect(
        p.uploaded_evidence_files.map((f: any) => f.file_name).sort(),
      ).toEqual(['clip.mp4', 'photo1.jpg', 'receipt.pdf']);
      expect(p.lockedCii).toBe(85);
    }
  });

  it('no identifying data leaves the platform: nested CNIC / phone / e-mail are gone, section 11 and AI scores are never sent', async () => {
    await analyzeAll();
    const all = JSON.stringify(received);
    for (const s of seeds)
      for (const leak of [s.cnic, s.mobile, s.email, `${s.name}.mate@mail.pk`])
        expect({ leak, found: all.includes(leak) }).toEqual({
          leak,
          found: false,
        });
    for (const leak of [
      '35202-9999999-9',
      '0301-9999999',
      'ai_generated_impact_score',
      'signature_name',
    ])
      expect({ leak, found: all.includes(leak) }).toEqual({
        leak,
        found: false,
      });
    // people and hours the model needs are still there
    expect(all).toContain('Alpha Lead');
    expect(all).toContain('Alpha Mate');
  });

  it('what the analyzer could and could not show the model is recorded and visible to the admin', async () => {
    notInspected.set(ids['Alpha'], [
      {
        id: 'E3',
        name: 'clip.mp4',
        reason:
          'file type cannot be read by the analyzer (video / office document / other)',
      },
    ]);
    const res = await analyzeAll();
    const alpha = (res.body.data.rows as any[]).find(
      (r) => r.id === ids['Alpha'],
    );
    expect(alpha.status).toBe('Ranked'); // a video that cannot be read is supporting material, not a reason to hold
    expect(alpha.evidenceRead.notInspected).toEqual([
      expect.objectContaining({ name: 'clip.mp4' }),
    ]);
    expect(alpha.evidenceRead.inspected.map((f: any) => f.name).sort()).toEqual(
      ['photo1.jpg', 'receipt.pdf'],
    );
    const bravo = (res.body.data.rows as any[]).find(
      (r) => r.id === ids['Bravo'],
    );
    expect(bravo.evidenceRead.notInspected).toEqual([]);
    // survives a reload: it is stored with the evaluation, not just in the response
    const again = await packages();
    expect(
      (again.run.rows as any[]).find((r) => r.id === ids['Alpha']).evidenceRead
        .notInspected,
    ).toHaveLength(1);
  });

  it('a file that could not be LOADED holds the project for verification (never a low rank); the others still rank', async () => {
    notInspected.set(ids['Charlie'], [
      {
        id: 'E1',
        name: 'receipt.pdf',
        reason: 'could not be loaded from storage',
      },
    ]);
    const res = await analyzeAll();
    const rows = res.body.data.rows as any[];
    const charlie = rows.find((r) => r.id === ids['Charlie']);
    expect(charlie.status).toBe('Review');
    expect(charlie.rank).toBeNull();
    expect(charlie.score).toBeNull();
    expect(charlie.reason).toMatch(/Could not read receipt\.pdf/);
    expect(rows.filter((r) => r.status === 'Ranked')).toHaveLength(3);
    // and the studio reports it as held, not as a low score
    const studio = await h
      .as(admin)
      .post(`${BASE}/studio/preview`)
      .send({ lens: 'excellence' });
    expect(studio.body.data.result.rows.map((r: any) => r.id)).not.toContain(
      ids['Charlie'],
    );
    expect(studio.body.data.result.heldIds).toContain(ids['Charlie']);
  });

  it('a second run re-uses the earlier read of an unchanged package (no second AI call, no paid re-read)', async () => {
    const first = await analyzeAll();
    expect(aiCalls).toBe(4);
    const second = await analyzeAll();
    expect(second.status).toBe(201);
    expect(second.body.data.runId).not.toBe(first.body.data.runId);
    expect(aiCalls).toBe(4);
    expect(
      (second.body.data.rows as any[]).every((r) => r.status === 'Ranked'),
    ).toBe(true);
    // a CHANGED package (new version) is read again
    await h.ds
      .getRepository(StudentReport)
      .update(ids['Delta'], {
        reportSubmittedAt: new Date('2026-05-01T00:00:00Z'),
      } as any);
    await analyzeAll();
    expect(aiCalls).toBe(5);
    expect(received[received.length - 1].projectId).toBe(ids['Delta']);
  });

  it('reads made under the older NPE-1.1 rubric are re-scored under NPE-1.2, never re-read (no AI cost on a rubric upgrade)', async () => {
    const pk = await packages();
    const legacy: any = await h.ds
      .getRepository(NpeRankingRun)
      .save(
        h.ds
          .getRepository(NpeRankingRun)
          .create({
            rubricVersion: 'NPE-1.1',
            scope: 'national',
            role: 'ciel_admin',
            status: 'published',
            createdByUserId: admin.id,
            packageVersions: {},
            reviewClearances: {},
            meta: {},
          } as any) as any,
      );
    const criteria = Object.fromEntries(
      NPE_CRITERION_KEYS.map((k) => [
        k,
        {
          anchor: 3.5,
          confidence: 'high',
          reason: 'old read',
          claimIds: [`${k}-1`],
        },
      ]),
    );
    for (const p of pk.packages) {
      await h.ds
        .getRepository(NpeRankingEvaluation)
        .save(
          h.ds
            .getRepository(NpeRankingEvaluation)
            .create({
              runId: legacy.id,
              reportId: p.id,
              packageVersion: p.version,
              readComplete: true,
              flags: [],
              criteria,
              claims: [],
              summary: 'old',
              limitations: 'old',
              audit: {
                model: 'npe_ranking_evaluation',
                payloadVersion: NPE_PAYLOAD_VERSION,
              },
            } as any) as any,
        );
    }
    const res = await analyzeAll();
    expect(res.status).toBe(201);
    expect(aiCalls).toBe(0); // every package was already read from the complete package; the judgment does not depend on the weights
    expect(res.body.data.rubricVersion).toBe('NPE-1.2');
    const alpha = (res.body.data.rows as any[]).find(
      (r) => r.id === ids['Alpha'],
    );
    const expected = npeCalculate(85, criteria as any, 'NPE-1.2').total;
    expect(alpha.score).toBe(expected);
    expect(alpha.score).not.toBe(
      npeCalculate(85, criteria as any, 'NPE-1.1').total,
    );
  });

  it('reads made from the OLD, thinner package are not trusted: every package is read once more from the complete package', async () => {
    const pk = await packages();
    const legacy: any = await h.ds
      .getRepository(NpeRankingRun)
      .save(
        h.ds
          .getRepository(NpeRankingRun)
          .create({
            rubricVersion: 'NPE-1.1',
            scope: 'national',
            role: 'ciel_admin',
            status: 'published',
            createdByUserId: admin.id,
            packageVersions: {},
            reviewClearances: {},
            meta: {},
          } as any) as any,
      );
    const criteria = Object.fromEntries(
      NPE_CRITERION_KEYS.map((k) => [
        k,
        {
          anchor: 1,
          confidence: 'high',
          reason: 'thin read',
          claimIds: [`${k}-1`],
        },
      ]),
    );
    for (const p of pk.packages) {
      await h.ds
        .getRepository(NpeRankingEvaluation)
        .save(
          h.ds
            .getRepository(NpeRankingEvaluation)
            .create({
              runId: legacy.id,
              reportId: p.id,
              packageVersion: p.version,
              readComplete: true,
              flags: [],
              criteria,
              claims: [],
              summary: 'thin',
              limitations: 'thin',
              audit: { model: 'npe_ranking_evaluation' },
            } as any) as any,
        );
    }
    const res = await analyzeAll();
    expect(aiCalls).toBe(4); // none of the unmarked reads was re-used
    expect(
      received.every(
        (p) =>
          p.flashcard &&
          p.systemAnalysis &&
          Object.keys(p.sections).length === 9,
      ),
    ).toBe(true);
    const alpha = (res.body.data.rows as any[]).find(
      (r) => r.id === ids['Alpha'],
    );
    expect(alpha.evaluation.summary).toBe('stub'); // the new, full-package read replaced the thin one
  });

  it('a package that changed after it was read is NOT ranked on its old read, and nothing can be published until it is read again', async () => {
    const first = await analyzeAll();
    expect(
      (first.body.data.rows as any[]).every((r) => r.status === 'Ranked'),
    ).toBe(true);
    // Delta's report is re-submitted / re-approved: its package version changes
    await h.ds
      .getRepository(StudentReport)
      .update(ids['Delta'], {
        reportSubmittedAt: new Date('2026-06-01T00:00:00Z'),
      } as any);
    const pk = await packages();
    const rows = pk.run.rows as any[];
    const delta = rows.find((r) => r.id === ids['Delta']);
    expect(delta.status).toBe('Ready');
    expect(delta.rank).toBeNull();
    expect(delta.score).toBeNull();
    expect(delta.reason).toMatch(/changed since it was read/);
    expect(rows.filter((r) => r.status === 'Ranked')).toHaveLength(3);
    // official snapshot: refused while an eligible package is unread
    const publish = await h
      .as(admin)
      .post(`${BASE}/publish`)
      .send({ runId: first.body.data.runId });
    expect(publish.status).toBe(400);
    expect(publish.body.message).toMatch(/have not been read yet/);
    // studio: the selection is reported as not ready to publish, and the project is not silently dropped
    const studio = await h
      .as(admin)
      .post(`${BASE}/studio/preview`)
      .send({ lens: 'excellence' });
    expect(studio.body.data.result.unreadIds).toEqual([ids['Delta']]);
    expect(studio.body.data.publishBlockers.join(' ')).toMatch(
      /have not been read yet/,
    );
    expect(
      (
        await h
          .as(admin)
          .post(`${BASE}/studio/publish`)
          .send({ lens: 'excellence' })
      ).status,
    ).toBe(400);
    // an evaluation-free angle is unaffected
    expect(
      (await h.as(admin).post(`${BASE}/studio/preview`).send({ lens: 'cii' }))
        .body.data.publishBlockers,
    ).toEqual([]);
    // reading it again fixes it
    const second = await analyzeAll();
    expect(
      (second.body.data.rows as any[]).every((r) => r.status === 'Ranked'),
    ).toBe(true);
    expect(aiCalls).toBe(5);
  });

  it('a stale package version is refused instead of silently ranking old content', async () => {
    const pk = await packages();
    const res = await h
      .as(admin)
      .post(`${BASE}/analyze`)
      .send({
        projects: pk.packages.map((p, i) => ({
          id: p.id,
          version: i === 0 ? 'old-version' : p.version,
        })),
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Stale package version/);
    expect(aiCalls).toBe(0);
  });

  it('a national run is not capped at 200 packages: a large list is accepted and handled (not a validation error)', async () => {
    const fake = Array.from({ length: 250 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      version: 'v',
    }));
    const res = await h
      .as(admin)
      .post(`${BASE}/analyze`)
      .send({ projects: fake });
    expect(res.status).toBe(403); // reached the scope check; before the fix this was a 400 "no more than 200 elements"
    expect(res.body.message).toMatch(/outside this ranking scope/);
    const tooMany = await h
      .as(admin)
      .post(`${BASE}/analyze`)
      .send({
        projects: Array.from({ length: 5001 }, () => ({
          id: 'x',
          version: 'v',
        })),
      });
    expect([400, 413]).toContain(tooMany.status); // refused (the e2e app keeps express' small default body limit; production allows 50 MB)
  });

  it("a university run reads only its own packages; another university's package is refused", async () => {
    const uniOrg = await h.makeOrg('Uni A', 'UNIVERSITY');
    const uni = await h.makeUser(UserRole.UNIVERSITY, { org: uniOrg });
    const pk = await packages(UNI, uni);
    expect(pk.packages).toHaveLength(2); // Alpha + Bravo only
    const res = await analyzeAll(UNI, uni);
    expect(res.status).toBe(201);
    expect(received.map((p) => p.projectId).sort()).toEqual(
      [ids['Alpha'], ids['Bravo']].sort(),
    );
    expect(received.every((p) => p.university === 'Uni A')).toBe(true);
    const foreign = await h
      .as(uni)
      .post(`${UNI}/analyze`)
      .send({ projects: [{ id: ids['Charlie'], version: 'x' }] });
    expect(foreign.status).toBe(403);
  });

  it('only the CIEL PK admin can start the national analysis', async () => {
    const student = await h.makeUser(UserRole.STUDENT);
    expect(
      (await h.as(student).post(`${BASE}/analyze`).send({ projects: [] }))
        .status,
    ).toBe(403);
    expect(
      (await h.as(ngo).post(`${BASE}/analyze`).send({ projects: [] })).status,
    ).toBe(403);
    expect(
      (await h.as(null).post(`${BASE}/analyze`).send({ projects: [] })).status,
    ).toBe(401);
  });
});

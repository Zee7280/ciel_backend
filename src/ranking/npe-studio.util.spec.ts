import {
  DEFAULT_CUSTOM_WEIGHTS,
  applyStudioMovement,
  buildStudioFacets,
  cleanSkillName,
  computeStudioRanking,
  normalizeCustomWeights,
  sanitizeStudioFilters,
  studioMetric,
  studioRankingName,
  studioSignature,
  type StudioCandidate,
  type StudioFacets,
} from './npe-studio.util';

const facets = (over: Partial<StudioFacets> = {}): StudioFacets => ({
  university: 'Uni A',
  department: 'CS',
  instructor: 'Dr X',
  sdg: 'SDG 4',
  skills: ['Leadership'],
  date: '2026-03-10',
  year: '2026',
  month: '03',
  semester: 'Spring',
  city: 'Lahore',
  partner: 'Partner A',
  activity: 'Teaching',
  theme: 'Education',
  ciiBadge: 'Advanced',
  privacy: 'Public',
  teamSize: 4,
  verifiedHours: 40,
  reach: 100,
  funds: 5000,
  ...over,
});

const judged = (anchor: number, confidence: 'high' | 'moderate' | 'low' | 'unsupported' = 'high') => ({ anchor, confidence });

function cand(id: string, over: Partial<StudioCandidate> & { f?: Partial<StudioFacets>; total?: number; impact?: number; sustain?: number } = {}): StudioCandidate {
  const total = over.total ?? 80;
  return {
    id,
    title: `Project ${id}`,
    gateOk: true,
    evaluated: true,
    reason: '',
    cii: 80,
    criteria: {
      impact: judged(over.impact ?? 4),
      need: judged(4),
      sustain: judged(over.sustain ?? 3),
      partner: judged(3),
      efficiency: judged(3),
      sdg: judged(4),
      scale: judged(3),
      learning: judged(4),
    },
    excellence: { total, criteria: { impact: 17.6, sustain: 5.4 } },
    facets: facets(over.f),
    ...over,
  };
}

const base = { lens: 'excellence' as const, groupBy: 'project' as const, filters: {}, weights: DEFAULT_CUSTOM_WEIGHTS };

describe('npe-studio.util', () => {
  describe('input hygiene', () => {
    it('sanitizes filters: whitelist, trim, numbers, dates; unknown and empty keys are dropped', () => {
      const f = sanitizeStudioFilters({
        university: '  Uni A ', sdg: '', evil: 'x', minHours: '12', minCii: 'abc', dateFrom: '2026-01-01', dateTo: 'tomorrow', __proto__: { polluted: 1 },
      });
      expect(f).toEqual({ university: 'Uni A', minHours: 12, dateFrom: '2026-01-01' });
      expect(sanitizeStudioFilters(null)).toEqual({});
      expect(sanitizeStudioFilters('x')).toEqual({});
    });

    it('custom weights default sensibly and never become all-zero / negative / NaN', () => {
      expect(normalizeCustomWeights(undefined)).toEqual(DEFAULT_CUSTOM_WEIGHTS);
      expect(normalizeCustomWeights({ impact: -5, sustain: 'x', learning: 10, cii: 10 })).toEqual({ impact: 35, sustain: 20, learning: 10, cii: 10 });
      expect(normalizeCustomWeights({ impact: 0, sustain: 0, learning: 0, cii: 0 })).toEqual(DEFAULT_CUSTOM_WEIGHTS);
    });

    it('strips the emoji the wizard prefixes to skill names', () => {
      expect(cleanSkillName('💬 Communication')).toBe('Communication');
      expect(cleanSkillName('  Teamwork ')).toBe('Teamwork');
      expect(cleanSkillName(null)).toBe('');
    });
  });

  describe('facets from a stored report', () => {
    it('reads every filterable attribute and survives a nearly empty report', () => {
      const full = buildStudioFacets({
        reportSubmittedAt: new Date('2026-09-05T10:00:00Z'),
        primary_sdg_goal: 4,
        section1: { team_lead: { university: 'Uni A', degree: 'BS CS' }, team_members: [{}, {}], faculty_supervisor_name: 'Dr X', metrics: { total_verified_hours: 42 } },
        section3: { primary_sdg: { goal_number: 6 } },
        section4: { project_summary: { distinct_total_beneficiaries: 120 } },
        section6: { use_resources: 'yes', resources: [{ amount: '1,000', unit: 'PKR' }, { amount: 5, unit: 'kg' }, { amount: 500, unit: 'Rs' }] },
        section8: { media_visible: 'public' },
        section9: { skills_grown: ['💬 Communication', 'Other', '🤝 Teamwork'] },
        opportunity: { types: ['Other: Tree planting'], location: { city: 'Lahore' } },
        problem_category: 'Environment',
        ciiV45Lock: { finalBadge: { name: 'Advanced' } },
      } as never);
      expect(full).toMatchObject({
        university: 'Uni A', department: 'BS CS', instructor: 'Dr X', sdg: 'SDG 6',
        skills: ['Communication', 'Teamwork'], date: '2026-09-05', year: '2026', month: '09', semester: 'Fall',
        city: 'Lahore', activity: 'Tree planting', theme: 'Environment', ciiBadge: 'Advanced', privacy: 'Public',
        teamSize: 3, reach: 120, funds: 1500,
      });
      expect(() => buildStudioFacets({} as never)).not.toThrow();
      expect(buildStudioFacets({} as never).skills).toEqual([]);
    });
  });

  describe('metrics', () => {
    it('evidence-based criterion lenses honour the confidence factor (unsupported earns nothing)', () => {
      const c = cand('a');
      c.criteria!.impact = judged(5, 'high');
      c.criteria!.sustain = judged(5, 'unsupported');
      c.criteria!.learning = judged(5, 'moderate');
      expect(studioMetric(c, 'impact', DEFAULT_CUSTOM_WEIGHTS)).toBe(100);
      expect(studioMetric(c, 'sustain', DEFAULT_CUSTOM_WEIGHTS)).toBe(0);
      expect(studioMetric(c, 'learning', DEFAULT_CUSTOM_WEIGHTS)).toBe(90);
    });

    it('non-evaluation lenses read the report, never the AI', () => {
      const c = cand('a', { criteria: null, excellence: null, evaluated: false, f: { verifiedHours: 33, reach: 77, funds: 9000 }, cii: 91 });
      expect(studioMetric(c, 'hours', DEFAULT_CUSTOM_WEIGHTS)).toBe(33);
      expect(studioMetric(c, 'reach', DEFAULT_CUSTOM_WEIGHTS)).toBe(77);
      expect(studioMetric(c, 'funds', DEFAULT_CUSTOM_WEIGHTS)).toBe(9000);
      expect(studioMetric(c, 'cii', DEFAULT_CUSTOM_WEIGHTS)).toBe(91);
      expect(studioMetric(c, 'excellence', DEFAULT_CUSTOM_WEIGHTS)).toBeNull();
      expect(studioMetric(c, 'impact', DEFAULT_CUSTOM_WEIGHTS)).toBeNull();
    });

    it('custom weighting is the normalized blend of impact, sustainability, learning and locked CII', () => {
      const c = cand('a', { cii: 80 });
      c.criteria!.impact = judged(5);
      c.criteria!.sustain = judged(0);
      c.criteria!.learning = judged(2.5);
      const w = { impact: 50, sustain: 10, learning: 20, cii: 20 };
      expect(studioMetric(c, 'custom', w)).toBeCloseTo((50 * 100 + 10 * 0 + 20 * 50 + 20 * 80) / 100, 10);
      // scale-free: doubling every weight does not change the result
      expect(studioMetric(c, 'custom', { impact: 100, sustain: 20, learning: 40, cii: 40 })).toBeCloseTo(studioMetric(c, 'custom', w)!, 10);
      // CII above 100 (bonus scale) is capped like everywhere else
      expect(studioMetric({ ...c, cii: 110 }, 'custom', { impact: 0, sustain: 0, learning: 0, cii: 1 })).toBe(100);
    });
  });

  describe('ranking', () => {
    it('ranks projects by excellence, breaks ties on impact then sustainability, shares rank only when everything ties', () => {
      const r = computeStudioRanking({
        ...base,
        candidates: [
          cand('low', { total: 70 }),
          cand('tieB', { total: 85, impact: 4 }),
          cand('tieA', { total: 85, impact: 4 }),
          cand('top', { total: 90 }),
        ],
      });
      expect(r.rows.map((x) => [x.id, x.rank])).toEqual([['top', 1], ['tieA', 2], ['tieB', 2], ['low', 4]]);
      const tieBreak = computeStudioRanking({
        ...base,
        candidates: [
          cand('lowerImpact', { total: 85 }),
          { ...cand('higherImpact', { total: 85 }), excellence: { total: 85, criteria: { impact: 20, sustain: 5 } } },
        ],
      });
      expect(tieBreak.rows.map((x) => x.id)).toEqual(['higherImpact', 'lowerImpact']);
    });

    it('holds (never down-ranks) packages that failed the gate or are not yet read', () => {
      const r = computeStudioRanking({
        ...base,
        candidates: [
          cand('ok'),
          cand('held', { gateOk: false, reason: 'Evidence access incomplete' }),
          cand('unread', { evaluated: false, excellence: null, criteria: null }),
        ],
      });
      expect(r.rows.map((x) => x.id)).toEqual(['ok']);
      expect(r.heldIds.sort()).toEqual(['held', 'unread']);
      expect(r.unreadIds).toEqual(['unread']); // only the unread one can be fixed by running the analyzer
      expect(r.heldReasons.find((h) => h.id === 'held')!.reason).toBe('Evidence access incomplete');
      expect(r.heldReasons.find((h) => h.id === 'unread')!.reason).toMatch(/not yet read/i);
      // an evaluation-free lens still ranks the unread package, but never the gate-failed one
      const byHours = computeStudioRanking({ ...base, lens: 'hours', candidates: [cand('ok'), cand('held', { gateOk: false }), cand('unread', { evaluated: false, excellence: null, criteria: null })] });
      expect(byHours.rows.map((x) => x.id).sort()).toEqual(['ok', 'unread']);
    });

    it('applies every filter to the population before ranking', () => {
      const candidates = [
        cand('a', { f: { university: 'Uni A', sdg: 'SDG 4', skills: ['Leadership'], verifiedHours: 50 }, cii: 90 }),
        cand('b', { f: { university: 'Uni B', sdg: 'SDG 4', skills: ['Teamwork'], verifiedHours: 10 }, cii: 60 }),
        cand('c', { f: { university: 'Uni A', sdg: 'SDG 6', skills: ['Leadership', 'Teamwork'], verifiedHours: 30, date: '2025-01-01', year: '2025' }, cii: 75 }),
      ];
      const ids = (filters: object) => computeStudioRanking({ ...base, filters, candidates }).rows.map((r) => r.id).sort();
      expect(ids({})).toEqual(['a', 'b', 'c']);
      expect(ids({ university: 'Uni A' })).toEqual(['a', 'c']);
      expect(ids({ sdg: 'SDG 4', skills: 'Leadership' })).toEqual(['a']);
      expect(ids({ skills: 'Teamwork' })).toEqual(['b', 'c']);
      expect(ids({ minHours: 30 })).toEqual(['a', 'c']);
      expect(ids({ minCii: 70 })).toEqual(['a', 'c']);
      expect(ids({ year: '2026' })).toEqual(['a', 'b']);
      expect(ids({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })).toEqual(['a', 'b']);
      expect(ids({ teamSize: '5-9' })).toEqual([]);
      expect(ids({ university: 'Nobody' })).toEqual([]);
    });

    it('groups by the mean of eligible project scores and reports sample sizes (more projects never help)', () => {
      const r = computeStudioRanking({
        ...base,
        groupBy: 'university',
        candidates: [
          cand('a1', { total: 90, f: { university: 'Uni A' } }),
          cand('a2', { total: 70, f: { university: 'Uni A' } }),
          cand('a3', { total: 50, f: { university: 'Uni A' } }),
          cand('b1', { total: 75, f: { university: 'Uni B' } }),
        ],
      });
      expect(r.rows.map((x) => [x.id, x.metric, x.projectCount, x.rank])).toEqual([
        ['Uni B', 75, 1, 1],
        ['Uni A', 70, 3, 2],
      ]);
    });

    it('a project can belong to several skill groups; thin groups can be excluded by a minimum size', () => {
      const candidates = [
        cand('p1', { total: 80, f: { skills: ['Leadership', 'Teamwork'] } }),
        cand('p2', { total: 60, f: { skills: ['Leadership'] } }),
      ];
      const all = computeStudioRanking({ ...base, groupBy: 'skill', candidates });
      expect(all.rows.map((x) => [x.id, x.projectCount])).toEqual([['Teamwork', 1], ['Leadership', 2]].sort(() => 0) as never);
      const min2 = computeStudioRanking({ ...base, groupBy: 'skill', candidates, minGroupSize: 2 });
      expect(min2.rows.map((x) => x.id)).toEqual(['Leadership']);
      expect(min2.thinGroups).toEqual([{ id: 'Teamwork', projectCount: 1 }]);
    });

    it('is deterministic: same input, same standings, same signature', () => {
      const candidates = [cand('a', { total: 80 }), cand('b', { total: 82 })];
      const x = computeStudioRanking({ ...base, candidates });
      const y = computeStudioRanking({ ...base, candidates: [...candidates].reverse() });
      expect(x.rows).toEqual(y.rows);
      expect(x.signature).toBe(y.signature);
    });
  });

  describe('naming and identity', () => {
    it('names rankings the way the design does', () => {
      expect(studioRankingName('excellence', 'project', {})).toBe('Overall Project Excellence — All eligible projects');
      expect(studioRankingName('impact', 'university', { sdg: 'SDG 4', city: 'Lahore', year: '2026' })).toBe(
        'Top Universities · Community Impact — SDG 4 · Lahore · 2026',
      );
      expect(studioRankingName('hours', 'project', { month: '03' })).toBe('Verified Service Hours — March');
    });

    it('signature changes with lens / group / filters / weights(custom only) / method, not with key order', () => {
      const s = (lens: never, g: never, f: object, w: object | null, v = 'NPE-1.2') => studioSignature(lens, g, f as never, w as never, v);
      expect(s('excellence' as never, 'project' as never, { year: '2026', sdg: 'SDG 4' }, null)).toBe(
        s('excellence' as never, 'project' as never, { sdg: 'SDG 4', year: '2026' }, null),
      );
      expect(s('excellence' as never, 'project' as never, {}, null)).not.toBe(s('cii' as never, 'project' as never, {}, null));
      expect(s('excellence' as never, 'project' as never, {}, null)).not.toBe(s('excellence' as never, 'university' as never, {}, null));
      expect(s('excellence' as never, 'project' as never, {}, null)).not.toBe(s('excellence' as never, 'project' as never, {}, null, 'NPE-1.1'));
      expect(s('custom' as never, 'project' as never, {}, { impact: 1 })).not.toBe(s('custom' as never, 'project' as never, {}, { impact: 2 }));
      expect(s('excellence' as never, 'project' as never, {}, { impact: 1 })).toBe(s('excellence' as never, 'project' as never, {}, { impact: 99 }));
    });
  });

  describe('publication movement', () => {
    const rows = (...ids: string[]) => ids.map((id, i) => ({ rank: i + 1, id, label: id, projectCount: 1, projectIds: [id], metric: 90 - i, cii: 80 }));

    it('first publication: everything is new', () => {
      const out = applyStudioMovement(rows('a', 'b'), ['a', 'b'], null);
      expect(out.cohortComparable).toBe(false);
      expect(out.rows.map((r) => r.movement)).toEqual(['new', 'new']);
    });

    it('same cohort: up / down / same with the previous rank', () => {
      const out = applyStudioMovement(rows('b', 'a', 'c'), ['a', 'b', 'c'], { rows: rows('a', 'b', 'c'), eligibleReportIds: ['c', 'b', 'a'] });
      expect(out.cohortComparable).toBe(true);
      expect(out.rows.map((r) => [r.id, r.movement, r.previousRank])).toEqual([
        ['b', 'up', 2], ['a', 'down', 1], ['c', 'same', 3],
      ]);
    });

    it('different cohort: movement is declared not comparable instead of inventing a trend', () => {
      const out = applyStudioMovement(rows('a', 'b'), ['a', 'b'], { rows: rows('a', 'b', 'c'), eligibleReportIds: ['a', 'b', 'c'] });
      expect(out.cohortComparable).toBe(false);
      expect(out.rows.every((r) => r.movement === 'cohort' && r.previousRank === null)).toBe(true);
    });
  });
});

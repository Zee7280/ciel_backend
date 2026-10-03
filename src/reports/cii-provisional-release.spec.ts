import { redactCiiV2Fields } from './cii-v2-redaction.util';
import {
  buildSystemIntegrityChecks,
  mergeIntegrityChecks,
} from './cii-integrity-checks.util';

const AI_RUN = {
  final: 72.4,
  level: { level: 4, name: 'Sustained' },
  sections: [{ id: 1, title: 'T', weight: 10, score: 7, criteria: [{ anchor: 3 }] }],
  bonus: { effort: 1, resources: 0, partners: 0, total: 1 },
  integrityPenalty: 0,
  redFlags: ['x'],
  studentFeedback: { opening_praise: 'private' },
  integrityChecks: [{ level: 'hold', title: 'a', detail: 'b', source: 'system' }],
};

describe('provisional CII release', () => {
  it('stays hidden for default viewers (student) until locked', () => {
    expect(redactCiiV2Fields(AI_RUN, null).ciiV2).toBeNull();
  });

  it('releases score to partner/university as provisional without private fields', () => {
    const { ciiV2, ciiV2Lock } = redactCiiV2Fields(AI_RUN, null, {
      releaseProvisional: true,
    });
    expect(ciiV2?.final).toBe(72.4);
    expect(ciiV2?.provisional).toBe(true);
    expect(ciiV2Lock).toBeNull();
    expect(ciiV2?.redFlags).toBeUndefined();
    expect(ciiV2?.studentFeedback).toBeUndefined();
    expect(JSON.stringify(ciiV2)).not.toContain('integrityChecks');
    expect(JSON.stringify(ciiV2)).not.toContain('anchor');
  });

  it('releases nothing before the analyser has run', () => {
    expect(
      redactCiiV2Fields(null, null, { releaseProvisional: true }).ciiV2,
    ).toBeNull();
  });
});

describe('integrity checks', () => {
  it('flags hours below minimum and missing evidence, merges AI checks without duplicates', () => {
    const sys = buildSystemIntegrityChecks({
      section1_participation_identity_attendance: {
        attendance_summary: {
          required_hours_met: false,
          minimum_required_hours_per_student: 16,
          students_below_required_hours: ['s2'],
        },
      },
      uploaded_evidence_files: [],
      system_validation: { validation_warnings: [] },
    } as never);
    expect(sys.map((c) => c.title)).toEqual([
      'Team hours incomplete',
      'No evidence files attached',
    ]);
    const merged = mergeIntegrityChecks(sys, [
      { level: 'review', title: 'SDG mismatch', detail: 'd' },
      { level: 'hold', title: sys[0].title, detail: sys[0].detail },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[2].source).toBe('ai');
  });
});

import { redactIndependentAnalysesForExternal } from './cii-v2-redaction.util';

describe('independent AI analyses for external viewers', () => {
  const runs = [
    {
      id: 'a1',
      runAt: '2026-05-01T00:00:00Z',
      runByUserId: 'secret-user-id',
      runByRole: 'ciel_admin',
      runByName: 'Admin',
      score: 81,
      level: { level: 5, name: 'High Impact', quality: 'x' },
      sections: [{ id: 1, score: 9, good: 'g', limit: 'l' }],
      bonus: { total: 2 },
      integrityPenalty: 1,
      feedback: { opening_praise: 'private feedback text' },
      note: 'n',
    },
  ];

  it('is hidden until the CII is locked', () => {
    expect(redactIndependentAnalysesForExternal(runs, null)).toBeNull();
    expect(redactIndependentAnalysesForExternal(runs, { locked: false })).toBeNull();
  });

  it('after lock, exposes only the trend fields', () => {
    const out = redactIndependentAnalysesForExternal(runs, { locked: true }) as any[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a1', score: 81, level: { name: 'High Impact' }, runByRole: 'ciel_admin' });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/secret-user-id|private feedback|sections|bonus|integrityPenalty/);
  });

  it('is safe for non-arrays', () => {
    expect(redactIndependentAnalysesForExternal(undefined, { locked: true })).toBeNull();
  });
});

import {
  buildNpePackageRecord,
  gateNpePackage,
  type NpePackageRecord,
} from './npe-ranking-eligibility';
import { NPE_CII_SCALE } from './npe-ranking.constants';
import { reportIndividualHoursMet } from '../reports/build-ciel-pk-ai-evaluation-payload.util';
import type { StudentReport } from '../reports/entities/student-report.entity';

function pkg(over: Partial<NpePackageRecord> = {}): NpePackageRecord {
  return {
    id: 'r1',
    title: 'Demo',
    university: 'Uni',
    pathway: 'Education',
    version: '3.0:stamp',
    approval: 'approved',
    cii: 90,
    ciiLocked: true,
    ciiSource: 'v45',
    ciiScale: NPE_CII_SCALE,
    packageComplete: true,
    hoursMet: true,
    consentComplete: true,
    evidenceAccessible: true,
    integrity: 'clear',
    parts: ['Flashcard'],
    ...over,
  };
}

describe('gateNpePackage', () => {
  it('marks a complete locked package Eligible', () => {
    expect(gateNpePackage(pkg()).status).toBe('Eligible');
  });

  it('HOLDs unverified individual hours without guessing marks', () => {
    const g = gateNpePackage(pkg({ hoursMet: false }));
    expect(g.status).toBe('Review');
    expect(g.reason).toMatch(/hours/i);
  });

  it('excludes rejected reports', () => {
    expect(gateNpePackage(pkg({ approval: 'rejected' })).status).toBe(
      'Excluded',
    );
  });

  it('HOLDs an unlocked CII', () => {
    const g = gateNpePackage(pkg({ ciiLocked: false }));
    expect(g.status).toBe('Review');
  });
});

describe('legacy CII (approved before CII v4.5 locking)', () => {
  const base = {
    id: 'old',
    status: 'verified',
    faculty_status: 'approved',
    admin_status: 'approved',
    opportunity: { title: 'Older project' },
    review_package: { schema_version: '3.0', packet_integrity: { ok: true } },
    reportSubmittedAt: new Date('2025-06-01T00:00:00.000Z'),
    section8: { evidence_files: [] },
  };

  it('uses the approved section11 CII when the report has no v4.5 lock', () => {
    const rec = buildNpePackageRecord({
      ...base,
      ciiV45Lock: null,
      section11: { cii_index: { totalScore: 88 } },
    } as unknown as StudentReport);
    expect(rec.ciiSource).toBe('legacy');
    expect(rec.ciiLocked).toBe(true);
    expect(rec.cii).toBe(88);
    expect(gateNpePackage(rec).reason).not.toMatch(/CII/);
  });

  it('flags a legacy report with no CII instead of guessing one', () => {
    const rec = buildNpePackageRecord({
      ...base,
      ciiV45Lock: null,
      section11: null,
    } as unknown as StudentReport);
    expect(rec.ciiSource).toBeNull();
    const g = gateNpePackage(rec);
    expect(g.status).toBe('Review');
    expect(g.reason).toMatch(/No approved CII/);
  });

  it('never treats an in-flight (unlocked) v4.5 approval as legacy', () => {
    const rec = buildNpePackageRecord({
      ...base,
      ciiV45Lock: { locked: false },
      section11: { cii_index: { totalScore: 88 } },
    } as unknown as StudentReport);
    expect(rec.ciiSource).toBeNull();
    expect(rec.ciiLocked).toBe(false);
  });

  it('never ranks a legacy CII on a report that is not approved', () => {
    const rec = buildNpePackageRecord({
      ...base,
      admin_status: 'pending',
      status: 'submitted',
      ciiV45Lock: null,
      section11: { cii_index: { totalScore: 88 } },
    } as unknown as StudentReport);
    expect(rec.ciiSource).toBeNull();
    expect(gateNpePackage(rec).status).toBe('Review');
  });
});

describe('buildNpePackageRecord parts', () => {
  it('never labels the detailed report as V13', () => {
    const rec = buildNpePackageRecord({
      id: 'r1',
      status: 'verified',
      faculty_status: 'not_applicable',
      admin_status: 'approved',
      opportunity: { title: 'Aabpashi' },
      ciiV45Lock: { locked: true },
      review_package: {
        schema_version: '3.0',
        packet_integrity: { ok: true },
      },
      reportSubmittedAt: new Date('2026-01-01T00:00:00.000Z'),
      section8: { evidence_files: [] },
    } as unknown as StudentReport);
    expect(rec.parts.join(' ')).not.toMatch(/V13/i);
    expect(rec.parts).toEqual([
      'Flashcard',
      'Detailed report',
      'Original evidence',
      'CII analysis',
      'Locked CII',
    ]);
  });
});

describe('required hours: the ranking gate uses the same bar as the submit gate', () => {
  const solo = (hours: number, opportunity: Record<string, unknown>) =>
    ({
      id: 'r',
      opportunity,
      section1: {
        participation_type: 'individual',
        team_lead: { hours },
        metrics: { total_verified_hours: hours },
      },
    }) as never;

  it('uses the opportunity required-hours column when the timeline has none (previously fell back to 16)', () => {
    expect(reportIndividualHoursMet(solo(10, { requiredHours: 8 }))).toBe(true); // submit passed at 10h >= 8
    expect(reportIndividualHoursMet(solo(20, { requiredHours: 40 }))).toBe(
      false,
    ); // 16h would have passed it wrongly
  });

  it('timeline hours still win, then timeline required_hours, then the default of 16', () => {
    expect(
      reportIndividualHoursMet(
        solo(5, { timeline: { expected_hours: 5 }, requiredHours: 40 }),
      ),
    ).toBe(true);
    expect(
      reportIndividualHoursMet(solo(12, { timeline: { required_hours: 12 } })),
    ).toBe(true);
    expect(reportIndividualHoursMet(solo(15, {}))).toBe(false);
    expect(reportIndividualHoursMet(solo(16, {}))).toBe(true);
  });
});

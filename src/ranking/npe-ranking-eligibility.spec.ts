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

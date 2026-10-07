import {
  buildNpePackageRecord,
  gateNpePackage,
  type NpePackageRecord,
} from './npe-ranking-eligibility';
import { NPE_CII_SCALE } from './npe-ranking.constants';

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
    expect(gateNpePackage(pkg({ approval: 'rejected' })).status).toBe('Excluded');
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
    } as any);
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

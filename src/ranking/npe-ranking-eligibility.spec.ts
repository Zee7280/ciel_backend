import { gateNpePackage, type NpePackageRecord } from './npe-ranking-eligibility';
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

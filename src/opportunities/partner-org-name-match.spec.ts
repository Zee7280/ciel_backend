import { OpportunitiesService } from './opportunities.service';

function svc() {
  return Object.create(OpportunitiesService.prototype) as any;
}

describe('partnerOrgNameMatchParams', () => {
  it('never sends a NUL byte (Postgres rejects it) — short org names like "NGO"', () => {
    const s = svc();
    s.facultyUniversityScope = { normalizeOrgName: (n: string) => n.toLowerCase() };
    for (const name of ['ngo', 'ab', 'sos', 'door of awareness']) {
      const params = s.partnerOrgNameMatchParams(name);
      for (const value of Object.values(params)) expect(String(value)).not.toContain('\u0000');
    }
  });

  it('short names stay exact-only; longer names get prefix/suffix/middle patterns', () => {
    const s = svc();
    s.facultyUniversityScope = { normalizeOrgName: (n: string) => n.toLowerCase() };
    const short = s.partnerOrgNameMatchParams('ngo');
    expect(short.orgName).toBe('ngo');
    expect(short.orgNamePrefix).toBe('#');
    const long = s.partnerOrgNameMatchParams('fellah');
    expect(long.orgNamePrefix).toBe('fellah %');
    expect(long.orgNameSuffix).toBe('% fellah');
    expect(long.orgNameMiddle).toBe('% fellah %');
  });
});

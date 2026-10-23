import {
  facultyMayRepresentUniversity,
  isAffiliatedWithUniversity,
  isListedUniversityName,
} from './university-affiliation.util';

const BNU = { id: 'org-bnu', name: 'Beaconhouse National University (BNU)' };

describe('isAffiliatedWithUniversity', () => {
  it('accepts the organization link, the full profile name and its abbreviation', () => {
    expect(isAffiliatedWithUniversity({ organizationId: BNU.id }, BNU)).toBe(
      true,
    );
    expect(
      isAffiliatedWithUniversity(
        { university: 'Beaconhouse National University (BNU)' },
        BNU,
      ),
    ).toBe(true);
    expect(isAffiliatedWithUniversity({ institution: 'BNU' }, BNU)).toBe(true);
  });

  it('a profile at another listed university is authoritative over seat / entry claims', () => {
    expect(
      isAffiliatedWithUniversity(
        { university: 'Aga Khan University', claims: [BNU.name] },
        BNU,
      ),
    ).toBe(false);
  });

  it('a blank or free-text profile is completed by a seat / entry claim', () => {
    expect(isAffiliatedWithUniversity({ claims: [BNU.name] }, BNU)).toBe(true);
    expect(
      isAffiliatedWithUniversity(
        { university: 'beaconhouse', claims: ['BNU'] },
        BNU,
      ),
    ).toBe(true);
    expect(isAffiliatedWithUniversity({ claims: ['University'] }, BNU)).toBe(
      false,
    );
  });

  it('an organization named outside the list (e.g. "uni") matches nobody by name', () => {
    const uni = { id: 'org-uni', name: 'uni' };
    expect(isListedUniversityName(uni.name)).toBe(false);
    expect(
      isAffiliatedWithUniversity(
        { university: BNU.name, claims: ['uni'] },
        uni,
      ),
    ).toBe(false);
  });
});

describe('facultyMayRepresentUniversity', () => {
  it('allows a matching or unknown profile, refuses another listed university', () => {
    expect(facultyMayRepresentUniversity({ university: 'BNU' }, BNU)).toBe(
      true,
    );
    expect(facultyMayRepresentUniversity({}, BNU)).toBe(true);
    expect(
      facultyMayRepresentUniversity({ university: 'Aga Khan University' }, BNU),
    ).toBe(false);
  });
});

import {
  collectOpportunityUniversityAllowlist,
  universityNamesMatch,
  universityScopeError,
} from './university-scope.util';

describe('universityNamesMatch', () => {
  it('ignores case, punctuation and whitespace', () => {
    expect(
      universityNamesMatch(
        'Beaconhouse National University (BNU)',
        'beaconhouse  national university bnu',
      ),
    ).toBe(true);
  });
  it('accepts the parenthesised abbreviation of a full name, but not a free-text prefix', () => {
    expect(universityNamesMatch('UET', 'UET Taxila')).toBe(false);
    expect(
      universityNamesMatch('Air University', 'Air University Islamabad'),
    ).toBe(false);
    expect(
      universityNamesMatch('BNU', 'Beaconhouse National University (BNU)'),
    ).toBe(true);
  });
  it('rejects different institutions and empty names', () => {
    expect(
      universityNamesMatch('LUMS', 'Beaconhouse National University (BNU)'),
    ).toBe(false);
    expect(universityNamesMatch('', 'BNU')).toBe(false);
  });
});

describe('collectOpportunityUniversityAllowlist', () => {
  it('is empty for open listings even when stale names linger', () => {
    expect(
      collectOpportunityUniversityAllowlist({
        participation_scope: {
          rule: 'open_all_universities',
          university_names: ['BNU'],
        },
        visibility_and_academic_linkage: {
          restricted_university_names: ['LUMS'],
        },
      }),
    ).toEqual([]);
  });
  it('uses the creator university for own-university rules and dedupes spellings', () => {
    expect(
      collectOpportunityUniversityAllowlist({
        restricted_universities: ['BNU'],
        participation_scope: {
          rule: 'own_university_only',
          creator_university_name: 'Beaconhouse National University (BNU)',
        },
      }),
    ).toEqual(['BNU']);
  });
  it('uses university_names for multi-university rules', () => {
    expect(
      collectOpportunityUniversityAllowlist({
        participation_scope: {
          rule: 'restricted_specific_universities',
          university_names: ['LUMS', 'NUST'],
        },
      }),
    ).toEqual(['LUMS', 'NUST']);
  });
});

describe('universityScopeError', () => {
  const opp = {
    participation_scope: {
      rule: 'own_university_only',
      creator_university_name: 'Beaconhouse National University (BNU)',
    },
  };
  it('passes an in-scope university, including the short spelling', () => {
    expect(universityScopeError('BNU', opp)).toBeNull();
    expect(
      universityScopeError('Beaconhouse National University (BNU)', opp),
    ).toBeNull();
  });
  it('names the blocked person and the allowed list', () => {
    expect(universityScopeError('LUMS', opp, 'Ali')).toMatch(
      /Ali is at LUMS, but this opportunity is open to Beaconhouse National University \(BNU\) students only/,
    );
    expect(universityScopeError('', opp, 'Ali')).toMatch(
      /Ali has no university set/,
    );
  });
  it('never blocks on an unscoped listing', () => {
    expect(universityScopeError('', { participation_scope: null })).toBeNull();
  });
});

import {
  collectOpportunityDepartmentAllowlist,
  participationScopeError,
} from './university-scope.util';

describe('participationScopeError (university + department)', () => {
  const deptOpp = {
    restricted_universities: ['Beaconhouse National University (BNU)'],
    participation_scope: {
      rule: 'departments_across_universities',
      university_names: ['Beaconhouse National University (BNU)'],
      department_restriction: {
        scope: 'specific',
        departments: ['Computer Science'],
      },
    },
  };
  it('lists departments only for department-specific scopes', () => {
    expect(collectOpportunityDepartmentAllowlist(deptOpp)).toEqual([
      'Computer Science',
    ]);
    expect(
      collectOpportunityDepartmentAllowlist({
        participation_scope: {
          rule: 'open_all_universities',
          department_restriction: { scope: 'all', departments: ['X'] },
        },
      }),
    ).toEqual([]);
    expect(collectOpportunityDepartmentAllowlist(null)).toEqual([]);
  });
  it('accepts a profile programme that belongs to the listed department', () => {
    expect(
      participationScopeError(
        { university: 'BNU', department: 'BS Computer Science' },
        deptOpp,
        'Ali',
      ),
    ).toBeNull();
    expect(
      participationScopeError(
        { university: 'BNU', department: 'Computer Science' },
        deptOpp,
        'Ali',
      ),
    ).toBeNull();
  });
  it('blocks the wrong department, a missing department, and the wrong university (university first)', () => {
    expect(
      participationScopeError(
        { university: 'BNU', department: 'BS Psychology' },
        deptOpp,
        'Ali',
      ),
    ).toMatch(
      /Ali is in BS Psychology, but this opportunity is open to Computer Science students only/,
    );
    expect(
      participationScopeError(
        { university: 'BNU', department: '' },
        deptOpp,
        'Ali',
      ),
    ).toMatch(/has no department/);
    expect(
      participationScopeError(
        { university: 'LUMS', department: 'BS Computer Science' },
        deptOpp,
        'Ali',
      ),
    ).toMatch(/Ali is at LUMS/);
  });
  it('can defer a blank department to a later account check', () => {
    expect(
      participationScopeError(
        { university: 'BNU', department: '' },
        deptOpp,
        'Ali',
        { requireDepartment: false },
      ),
    ).toBeNull();
    expect(
      participationScopeError(
        { university: 'BNU', department: 'BS Psychology' },
        deptOpp,
        'Ali',
        { requireDepartment: false },
      ),
    ).toMatch(/is in BS Psychology/);
  });
  it('never blocks on department when the listing has no department restriction', () => {
    expect(
      participationScopeError(
        { university: 'BNU', department: '' },
        {
          participation_scope: {
            rule: 'own_university_only',
            creator_university_name: 'BNU',
          },
        },
      ),
    ).toBeNull();
  });
});

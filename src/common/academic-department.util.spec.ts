import {
  departmentFromDegreeProgram,
  sanitizeReportAcademicDepartment,
  stripSchoolWrapperFromAcademicUnit,
} from './academic-department.util';

describe('academic-department.util', () => {
  it('strips school names from report academic Department', () => {
    const cases: Array<[string, string, string]> = [
      [
        'School of Computer & Information Technology',
        'BS Computer Science',
        'Computer Science',
      ],
      [
        'School of Computer & Information Technology / BS Computer Science',
        'BS Computer Science',
        'Computer Science',
      ],
      [
        'Mariam Dawood School of Visual Arts & Design',
        'BFA Visual Arts',
        'Visual Arts',
      ],
      [
        'Institute of Psychology',
        'BS Applied Psychology',
        'Applied Psychology',
      ],
      ['SMS', 'BBA (Hons)', 'Management Sciences'],
      ['Computer Science', 'BS Computer Science', 'Computer Science'],
      ['', 'BS Software Engineering', 'Software Engineering'],
      ['School of Education', 'Bachelor of Education (B.Ed)', 'Education'],
    ];
    for (const [dept, prog, expected] of cases) {
      expect(sanitizeReportAcademicDepartment(dept, prog)).toBe(expected);
    }
  });

  it('maps named schools and empty BBA leftovers without School of', () => {
    expect(
      stripSchoolWrapperFromAcademicUnit('Razia Hassan School of Architecture'),
    ).toBe('Architecture');
    expect(departmentFromDegreeProgram('BBA (Hons)')).toBe(
      'Management Sciences',
    );
  });
});

import {
  academicDepartmentsMatch,
  academicUnitMatchKeys,
} from './academic-department.util';

describe('academicDepartmentsMatch (apply eligibility: profile programme vs listing department)', () => {
  it('matches an HEC programme on the profile to the listing department', () => {
    expect(
      academicDepartmentsMatch('Computer Science', 'BS Computer Science'),
    ).toBe(true);
    expect(
      academicDepartmentsMatch('BS Computer Science', 'Computer Science'),
    ).toBe(true);
    expect(academicDepartmentsMatch('Economics', 'MPhil Economics')).toBe(true);
    expect(
      academicDepartmentsMatch('computer science', 'BS COMPUTER SCIENCE'),
    ).toBe(true);
  });
  it('matches a BNU school to its programmes and to the department-only spelling', () => {
    expect(
      academicDepartmentsMatch(
        'School of Computer & Information Technology',
        'BS Computer Science',
      ),
    ).toBe(true);
    expect(
      academicDepartmentsMatch(
        'Computer and Information Technology',
        'School of Computer & Information Technology',
      ),
    ).toBe(true);
    expect(
      academicDepartmentsMatch('School of Management Sciences (SMS)', 'SMS'),
    ).toBe(true);
    expect(academicDepartmentsMatch('Management Sciences', 'BBA (Hons)')).toBe(
      true,
    );
    expect(
      academicDepartmentsMatch(
        'Institute of Psychology',
        'BS Applied Psychology',
      ),
    ).toBe(true);
    // BNU's Institute of Psychology hosts Applied Psychology, so a 'Psychology' listing accepts it.
    expect(
      academicDepartmentsMatch('Psychology', 'BS Applied Psychology'),
    ).toBe(true);
  });
  it('does not match different units', () => {
    expect(academicDepartmentsMatch('Computer Science', 'BS Psychology')).toBe(
      false,
    );
    expect(academicDepartmentsMatch('Economics', 'BS Home Economics')).toBe(
      false,
    );
    expect(academicDepartmentsMatch('Computer Science', '')).toBe(false);
    expect(academicDepartmentsMatch('', '')).toBe(false);
  });
  it('exposes stable keys', () => {
    expect(academicUnitMatchKeys('BS Computer Science')).toEqual(
      expect.arrayContaining([
        'bs computer science',
        'computer science',
        'school of computer and information technology',
      ]),
    );
  });
});

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
      ['Institute of Psychology', 'BS Applied Psychology', 'Applied Psychology'],
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
      stripSchoolWrapperFromAcademicUnit(
        'Razia Hassan School of Architecture',
      ),
    ).toBe('Architecture');
    expect(departmentFromDegreeProgram('BBA (Hons)')).toBe('Management Sciences');
  });
});

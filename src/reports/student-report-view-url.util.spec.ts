import {
  buildStudentReportPagePath,
  buildStudentReportPageUrl,
} from './student-report-view-url.util';

describe('buildStudentReportPageUrl', () => {
  it('builds relative paths for certificate, print dossier, and V17 package', () => {
    expect(buildStudentReportPagePath('abc-1', 'certificate')).toBe(
      '/dashboard/student/report?projectId=abc-1&view=certificate',
    );
    expect(buildStudentReportPagePath('abc-1', 'print')).toBe(
      '/dashboard/student/report?projectId=abc-1&view=print',
    );
    expect(buildStudentReportPagePath('abc-1', 'v17')).toBe(
      '/dashboard/student/report?projectId=abc-1&view=v17',
    );
    expect(buildStudentReportPagePath('abc-1', 'evidence')).toBe(
      '/dashboard/student/report?projectId=abc-1&view=evidence',
    );
    expect(buildStudentReportPagePath('abc-1', 'flash')).toBe(
      '/dashboard/student/report?projectId=abc-1&view=flash',
    );
    expect(buildStudentReportPagePath('abc-1', 'package')).toBe(
      '/dashboard/student/report?projectId=abc-1&view=package',
    );
  });

  it('prefixes FRONTEND_URL when provided and skips blank project ids', () => {
    expect(
      buildStudentReportPageUrl('opp-9', 'v17', 'https://cielpk.com/'),
    ).toBe(
      'https://cielpk.com/dashboard/student/report?projectId=opp-9&view=v17',
    );
    expect(buildStudentReportPageUrl('  ', 'v17', 'https://cielpk.com')).toBeNull();
    expect(buildStudentReportPageUrl(null, 'print')).toBeNull();
  });
});

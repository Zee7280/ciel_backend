import { partnerReportListQuery } from './partners.controller';

describe('partnerReportListQuery', () => {
  it('keeps the listing filters and drops the admin-only switches', () => {
    expect(
      partnerReportListQuery({
        limit: '200',
        page: '2',
        status: 'submitted',
        q: 'clean',
        studentId: 'victim',
        includeHidden: 'true',
        organizationId: 'other-org',
      }),
    ).toEqual({ limit: '200', page: '2', status: 'submitted', q: 'clean' });
  });
});

import {
  namedSupervisorEmail,
  opportunitySupervisorEmails,
  supervisionRequiredForReport,
} from './report-supervision.util';

describe('report supervision rules', () => {
  it('reads the named supervisor from the seat, primary first, normalised', () => {
    expect(
      namedSupervisorEmail({
        primaryFacultyEmail: ' Dr.Sana@BNU.edu.pk ',
        facultySupervisorEmail: 'other@bnu.edu.pk',
      }),
    ).toBe('dr.sana@bnu.edu.pk');
    expect(
      namedSupervisorEmail({
        primaryFacultyEmail: null,
        facultySupervisorEmail: 'Legacy@BNU.edu.pk',
      }),
    ).toBe('legacy@bnu.edu.pk');
    expect(namedSupervisorEmail(null)).toBe('');
  });

  it('collects the opportunity’s own faculty emails', () => {
    expect(
      opportunitySupervisorEmails(
        { supervision: { contact: 'A@x.pk', official_email: ' b@x.pk' } },
        'C@x.pk',
      ),
    ).toEqual(['c@x.pk', 'a@x.pk', 'b@x.pk']);
    expect(opportunitySupervisorEmails(null)).toEqual([]);
  });

  it('requires confirmation only for a named faculty outside the opportunity', () => {
    const base = {
      isStudentCreated: false,
      namedEmail: 'sana@bnu.edu.pk',
      opportunityFacultyEmails: ['owner@bnu.edu.pk'],
    };
    expect(supervisionRequiredForReport(base)).toBe(true);
    expect(
      supervisionRequiredForReport({ ...base, isStudentCreated: true }),
    ).toBe(false);
    expect(supervisionRequiredForReport({ ...base, namedEmail: '' })).toBe(
      false,
    );
    expect(
      supervisionRequiredForReport({
        ...base,
        opportunityFacultyEmails: ['sana@bnu.edu.pk'],
      }),
    ).toBe(false);
  });
});

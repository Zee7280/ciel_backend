import { composeFacultyReportRemarks } from './faculty-report-remarks.util';

describe('composeFacultyReportRemarks', () => {
  it('keeps a remarks-only string unchanged so current Faculty action tests still match', () => {
    expect(
      composeFacultyReportRemarks({ remarks: 'Please add baseline evidence.' }),
    ).toBe('Please add baseline evidence.');
  });

  it('appends section and required correction when Faculty sends the extra fields', () => {
    expect(
      composeFacultyReportRemarks({
        remarks: 'Hours look thin.',
        revision_section: 'Section 4',
        required_correction: 'Add session dates.',
      }),
    ).toBe(
      'Section(s): Section 4\nReason: Hours look thin.\nRequired Correction: Add session dates.',
    );
  });
});

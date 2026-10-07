import {
  BROWSE_PATH_LABEL,
  buildPublicExploreStats,
  buildStudentBrowseListingFields,
  classifyBrowseCreator,
  classifyBrowsePath,
  countBrowsePaths,
  pickBrowseCoverUrl,
} from './student-browse-listing.util';

describe('student browse listing fields', () => {
  it('maps activity types onto the four marketplace paths', () => {
    expect(classifyBrowsePath(['Community Service'])).toBe('community_service');
    expect(classifyBrowsePath(['Sustainability-Linked Coursework'])).toBe(
      'coursework',
    );
    expect(classifyBrowsePath(['Research / Survey Support'])).toBe('fyp');
    expect(classifyBrowsePath(['Startup / Venture'])).toBe('startup');
  });

  it('counts paths for filter chips before pagination', () => {
    expect(
      countBrowsePaths([
        { types: ['Community Service'] },
        { types: ['Community Service'] },
        { types: ['Research'] },
        { types: ['Course Project'] },
      ]),
    ).toEqual({
      all: 4,
      community_service: 2,
      coursework: 1,
      fyp: 1,
      startup: 0,
    });
  });

  it('exposes deadline, hours, partner, and seat-full flags for cards', () => {
    const fields = buildStudentBrowseListingFields(
      {
        types: ['Volunteer Activity'],
        mode: 'On site',
        requiredHours: 16,
        timeline: {
          expected_hours: 16,
          start_date: '2026-10-01',
          end_date: '2026-10-30',
          volunteers_required: 25,
        },
        sdg_info: { sdg_id: '4' },
        secondary_sdgs: [{ sdg_id: '11' }],
        partner_organization: { organization_name: 'SOS Children\'s Villages' },
        supervision: { faculty_department: 'CS' },
      },
      { remaining_seats: 25, organization_name: 'Fallback Org' },
    );

    expect(fields).toMatchObject({
      path_key: 'community_service',
      path_label: BROWSE_PATH_LABEL.community_service,
      hours: 16,
      start_date: '2026-10-01',
      end_date: '2026-10-30',
      partner_name: "SOS Children's Villages",
      department: 'CS',
      sdg_ids: ['4', '11'],
      is_full: false,
      is_virtual: false,
      category: 'Volunteer Activity',
    });
  });

  it('hides student-opportunity bookkeeping names from partner_name', () => {
    const fields = buildStudentBrowseListingFields(
      { types: ['Volunteer Activity'] },
      {
        remaining_seats: 5,
        organization_name: 'Student opportunity — Aabpashi — 9f84bc1f',
      },
    );
    expect(fields.partner_name).toBe('');
  });

  it('marks a listing full and virtual from seats + remote mode', () => {
    const fields = buildStudentBrowseListingFields(
      {
        types: ['Training / Teaching'],
        mode: 'Remote',
        timeline: { volunteers_required: 10, end_date: '2099-01-01' },
      },
      { remaining_seats: 0, organization_name: 'Org' },
    );
    expect(fields.is_full).toBe(true);
    expect(fields.is_virtual).toBe(true);
  });

    it('counts public explore stats from live listing rows', () => {
      expect(
        buildPublicExploreStats([
          {
            organization_name: 'SOS',
            participant_count: 12,
            admin_approved: true,
          },
          {
            partner_name: 'BNU Innovation Hub',
            participant_count: 8,
            faculty_verified: true,
          },
        ]),
      ).toEqual({
        total: 2,
        verified: 2,
        partners: 2,
        students_impacted: 20,
      });
    });

    it('maps faculty-created rows without an Organization to faculty', () => {
      expect(
        classifyBrowseCreator({
          isStudentCreated: false,
          facultyId: 'fac-1',
          organizationId: null,
        }),
      ).toBe('faculty');
    });

    it('does not label a student-created row as partner', () => {
      expect(
        classifyBrowseCreator({
          isStudentCreated: true,
          created_by_role: 'student',
        }),
      ).toBe('student');
    });

  it('picks the first https cover URL when present', () => {
    expect(
      pickBrowseCoverUrl({
        activity_details: {
          images: [{ url: 'https://cdn.example.com/cover.jpg' }],
        },
      }),
    ).toBe('https://cdn.example.com/cover.jpg');
  });
});

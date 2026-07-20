import {
  filterSection1AnalyticsForStakeholder,
  sanitizeRestrictedValuesForStakeholder,
} from './section1-analytics.visibility';
import { Section1AnalyticsStakeholder } from './section1-analytics.types';

describe('Section1 analytics visibility', () => {
  const sampleValues = {
    project_title: 'Clean Campus Drive',
    cnic_completion: { count: 10, masked_last4: '1234' },
    duplicate_cnic_check: { duplicate_groups: 2 },
    hours_status_in_header: {
      verified_hours: 12,
      required_hours: 16,
      percent: 75,
    },
    team_member_count: 4,
    section_1_red_flag_count: { count: 1 },
    verify_identity_link_record_button_status: { enabled: false },
  };

  it('returns all CIEL-visible fields for admin stakeholder', () => {
    const { fields } = filterSection1AnalyticsForStakeholder(
      'ciel',
      sampleValues,
    );
    expect(fields.project_title).toBe('Clean Campus Drive');
    expect(fields.cnic_completion).toBeDefined();
    expect(fields.duplicate_cnic_check).toBeDefined();
  });

  it('hides restricted admin-only fields from partner stakeholder', () => {
    const sanitized = sanitizeRestrictedValuesForStakeholder(
      'partner',
      sampleValues,
    );
    const { fields } = filterSection1AnalyticsForStakeholder(
      'partner',
      sanitized,
    );
    expect(fields.project_title).toBe('Clean Campus Drive');
    expect(fields.team_member_count).toBe(4);
    expect(fields.cnic_completion).toBeUndefined();
    expect(fields.duplicate_cnic_check).toBeUndefined();
    expect(fields.section_1_red_flag_count).toBeUndefined();
  });

  it('hides personal identity fields from UN/Government stakeholder', () => {
    const sanitized = sanitizeRestrictedValuesForStakeholder(
      'un_government',
      sampleValues,
    );
    const { fields, meta, fields_by_category, category_counts } =
      filterSection1AnalyticsForStakeholder('un_government', sanitized);
    expect(fields.hours_status_in_header).toBeDefined();
    expect(fields.team_member_count).toBeDefined();
    expect(fields.cnic_completion).toBeUndefined();
    expect(meta.hours_status_in_header?.category).toBe('basic');
    expect(fields_by_category.basic.hours_status_in_header).toBeDefined();
    expect(fields_by_category.restricted.cnic_completion).toBeUndefined();
    expect(category_counts.basic).toBeGreaterThan(0);
  });

  it('groups filtered fields by category without dropping flat fields', () => {
    const { fields, meta, fields_by_category, category_counts } =
      filterSection1AnalyticsForStakeholder('ciel', sampleValues);
    expect(fields.project_title).toBe('Clean Campus Drive');
    expect(fields_by_category.basic.project_title).toBe('Clean Campus Drive');
    expect(fields_by_category.restricted.cnic_completion).toBeDefined();
    expect(category_counts.restricted).toBeGreaterThan(0);
    expect(
      category_counts.basic +
        category_counts.premium +
        category_counts.restricted,
    ).toBe(Object.keys(fields).length);
    expect(meta.cnic_completion?.category).toBe('restricted');
  });

  it('allows student-only operational button state for student stakeholder', () => {
    const { fields } = filterSection1AnalyticsForStakeholder(
      'student',
      sampleValues,
    );
    expect(fields.verify_identity_link_record_button_status).toEqual({
      enabled: false,
    });
  });

  const stakeholders: Section1AnalyticsStakeholder[] = [
    'ciel',
    'student',
    'partner',
    'university',
    'un_government',
  ];

  it.each(stakeholders)(
    'never leaks CNIC completion to %s unless allowed',
    (stakeholder) => {
      const sanitized = sanitizeRestrictedValuesForStakeholder(
        stakeholder,
        sampleValues,
      );
      const { fields } = filterSection1AnalyticsForStakeholder(
        stakeholder,
        sanitized,
      );
      if (stakeholder === 'ciel') {
        expect(fields.cnic_completion).toBeDefined();
      } else {
        expect(fields.cnic_completion).toBeUndefined();
      }
    },
  );
});

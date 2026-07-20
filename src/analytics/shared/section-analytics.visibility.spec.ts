import {
  filterFieldsForStakeholder,
  groupFieldsByCategory,
} from './section-analytics.visibility';

describe('groupFieldsByCategory', () => {
  it('splits fields by meta category and counts them', () => {
    const fields = {
      section_completion_rate: { percent: 80 },
      avg_credibility_score: { score: 70 },
      red_flag_count: { count: 2 },
    };
    const meta = {
      section_completion_rate: {
        category: 'basic' as const,
        presentation: 'KPI',
      },
      avg_credibility_score: {
        category: 'premium' as const,
        presentation: 'Score',
      },
      red_flag_count: {
        category: 'restricted' as const,
        presentation: 'Flags',
      },
    };
    const { fields_by_category, category_counts } = groupFieldsByCategory(
      fields,
      meta,
    );
    expect(fields_by_category.basic.section_completion_rate).toEqual({
      percent: 80,
    });
    expect(fields_by_category.premium.avg_credibility_score).toEqual({
      score: 70,
    });
    expect(fields_by_category.restricted.red_flag_count).toEqual({ count: 2 });
    expect(category_counts).toEqual({ basic: 1, premium: 1, restricted: 1 });
  });

  it('defaults unknown meta to basic without mutating flat fields map', () => {
    const fields = { mystery: 1 };
    const { fields_by_category, category_counts } = groupFieldsByCategory(
      fields,
      {},
    );
    expect(fields_by_category.basic.mystery).toBe(1);
    expect(category_counts.basic).toBe(1);
    expect(fields.mystery).toBe(1);
  });
});

describe('filterFieldsForStakeholder category grouping', () => {
  it('returns fields_by_category for section 8 ciel stakeholder', () => {
    const { fields, fields_by_category, category_counts, meta } =
      filterFieldsForStakeholder(8, 'ciel', {
        project_title: 'Demo',
        section_completion_rate: { percent: 50 },
        avg_credibility_score: { score: 61 },
        red_flag_count: { count: 1 },
        consent_risk_count: { count: 0 },
      });
    expect(fields.project_title).toBe('Demo');
    expect(meta.avg_credibility_score?.category).toBe('premium');
    expect(fields_by_category.premium.avg_credibility_score).toBeDefined();
    expect(fields_by_category.restricted.red_flag_count).toBeDefined();
    expect(
      category_counts.basic +
        category_counts.premium +
        category_counts.restricted,
    ).toBe(Object.keys(fields).length);
  });
});

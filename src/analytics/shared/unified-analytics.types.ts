import {
  AnalyticsScope,
  AnalyticsStakeholder,
  SummaryAnalyticsResponse,
} from './section-analytics.types';

export interface UnifiedAnalyticsKpi {
  key: string;
  label: string;
  value: number;
  unit?: 'count' | 'percent' | 'hours';
  description: string;
}

export interface UnifiedAnalyticsSeries {
  key: string;
  title: string;
  type: 'bar' | 'line' | 'donut';
  data: Array<{
    label: string;
    value: number;
    color?: string;
  }>;
}

export interface UnifiedAnalyticsResponse {
  success: true;
  data: {
    stakeholder: AnalyticsStakeholder;
    scope: AnalyticsScope;
    project_id?: string;
    organization_id?: string;
    generated_at: string;
    kpis: UnifiedAnalyticsKpi[];
    charts: UnifiedAnalyticsSeries[];
    sections: SummaryAnalyticsResponse['data']['sections'];
    composite: SummaryAnalyticsResponse['data']['composite'];
  };
}

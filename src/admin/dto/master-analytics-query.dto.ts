import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

/** Scalar piece of a query param after flattening arrays / trimming (objects ignored). */
function coerceMasterAnalyticsQueryScalar(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t === '' ? undefined : t;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return undefined;
}

/** GET query values may repeat (arrays) or be empty strings; normalize before validators (esp. @IsOptional + @IsUUID). */
function MasterAnalyticsQueryScalar() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null) return undefined;
    const candidate: unknown = Array.isArray(value)
      ? (value as readonly unknown[])[0]
      : value;
    return coerceMasterAnalyticsQueryScalar(candidate);
  });
}

/**
 * Optional filters for {@link AdminService.getMasterAnalytics}.
 * Omit all fields for platform-wide aggregates (legacy behavior).
 */
export class MasterAnalyticsQueryDto {
  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsString()
  university?: string;

  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsString()
  degree_program?: string;

  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsString()
  year_of_study?: string;

  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsString()
  academic_integration_type?: string;

  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsIn(['individual', 'team'])
  participation_type?: 'individual' | 'team';

  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsUUID()
  project_id?: string;

  /** Matches primary, supervisor, or secondary faculty email on the participation row (case-insensitive). */
  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsString()
  faculty_email?: string;

  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsUUID()
  partner_organization_id?: string;

  /** Student profile + identity verification on linked user. */
  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsIn(['verified', 'unverified'])
  verification_status?: 'verified' | 'unverified';

  /** Inclusive lower bound on participation enrollment (`createdAt`), ISO date or datetime. */
  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsDateString()
  period_start?: string;

  /** Inclusive upper bound on participation enrollment (`createdAt`), ISO date or datetime (end of UTC day if date-only). */
  @MasterAnalyticsQueryScalar()
  @IsOptional()
  @IsDateString()
  period_end?: string;
}

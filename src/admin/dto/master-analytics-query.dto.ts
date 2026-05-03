import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Optional filters for {@link AdminService.getMasterAnalytics}.
 * Omit all fields for platform-wide aggregates (legacy behavior).
 */
export class MasterAnalyticsQueryDto {
    @IsOptional()
    @IsString()
    university?: string;

    @IsOptional()
    @IsString()
    degree_program?: string;

    @IsOptional()
    @IsString()
    year_of_study?: string;

    @IsOptional()
    @IsString()
    academic_integration_type?: string;

    @IsOptional()
    @IsIn(['individual', 'team'])
    participation_type?: 'individual' | 'team';

    @IsOptional()
    @IsUUID()
    project_id?: string;

    /** Matches primary, supervisor, or secondary faculty email on the participation row (case-insensitive). */
    @IsOptional()
    @IsString()
    faculty_email?: string;

    @IsOptional()
    @IsUUID()
    partner_organization_id?: string;

    /** Student profile + identity verification on linked user. */
    @IsOptional()
    @IsIn(['verified', 'unverified'])
    verification_status?: 'verified' | 'unverified';

    /** Inclusive lower bound on participation enrollment (`createdAt`), ISO date or datetime. */
    @IsOptional()
    @IsDateString()
    period_start?: string;

    /** Inclusive upper bound on participation enrollment (`createdAt`), ISO date or datetime (end of UTC day if date-only). */
    @IsOptional()
    @IsDateString()
    period_end?: string;
}

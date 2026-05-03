import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Optional filters for {@link FacultyService.getImpactAnalytics}.
 * Scope is always limited to this faculty’s assigned opportunities; filters narrow further (AND).
 */
export class FacultyAnalyticsQueryDto {
    @IsOptional()
    @IsUUID()
    project_id?: string;

    /** Matches course code, semester/term, or project title (case-insensitive substring). Ignored if `project_id` is set. */
    @IsOptional()
    @IsString()
    course_section?: string;

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
    @IsIn(['verified', 'unverified'])
    verification_status?: 'verified' | 'unverified';

    @IsOptional()
    @IsDateString()
    period_start?: string;

    @IsOptional()
    @IsDateString()
    period_end?: string;
}

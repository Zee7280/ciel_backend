import { IsIn, IsOptional, IsString } from 'class-validator';

/** Query params for GET paths/course-projects/merit-model — which of these are actually honored
 * depends on the caller's role (faculty/university/CIEL scope), enforced in PathsService. */
export class MeritModelQueryDto {
    /** CIEL scope only — organizationId of the university to filter to. */
    @IsOptional() @IsString() university?: string;
    @IsOptional() @IsString() discipline?: string;
    /** Faculty email to filter to. */
    @IsOptional() @IsString() faculty?: string;
    @IsOptional() @IsString() year?: string;
    @IsOptional() @IsIn(['interdisciplinary', 'single']) teamType?: 'interdisciplinary' | 'single';
    @IsOptional() @IsString() semesterFrom?: string;
    @IsOptional() @IsString() semesterTo?: string;
    @IsOptional() @IsIn(['overall', 'discipline']) mode?: 'overall' | 'discipline';
}

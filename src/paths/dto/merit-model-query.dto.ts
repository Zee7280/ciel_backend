import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

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

export class MeritRankPickDto {
    @IsString()
    entryId: string;
    @Type(() => Number)
    @IsInt()
    @Min(1)
    rank: number;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) of?: number;
    @IsOptional() @Type(() => Number) @IsNumber() total?: number;
}

export class NotifyMeritRanksDto {
    /** Preferred — ranks match what the analyzer UI actually showed (filtered pool). */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(3)
    @ValidateNested({ each: true })
    @Type(() => MeritRankPickDto)
    picks?: MeritRankPickDto[];
    /** Fallback if an older client still posts ids only. */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(3)
    @IsString({ each: true })
    entryIds?: string[];
    @IsOptional() @IsString() scopeLabel?: string;
}

import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateCourseProjectDto {
    @IsOptional()
    @IsString()
    course?: string;

    @IsOptional()
    @IsString()
    projectTitle?: string;

    @IsOptional()
    @IsString()
    projectDescription?: string;

    @IsOptional()
    @IsArray()
    sdgs?: number[];

    @IsOptional()
    @IsArray()
    evidenceUrls?: string[];

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(4)
    stepCompleted?: number;

    @IsOptional()
    @IsIn(['draft', 'submitted'])
    status?: 'draft' | 'submitted';
}

import { IsOptional, IsString, IsUUID } from 'class-validator';

export class Section1AnalyticsQueryDto {
    @IsOptional()
    @IsUUID()
    project_id?: string;

    @IsOptional()
    @IsUUID()
    student_id?: string;

    @IsOptional()
    @IsString()
    university?: string;

    @IsOptional()
    @IsString()
    scope?: 'project' | 'aggregate';
}

export class Section1StakeholderAnalyticsQueryDto {
    @IsOptional()
    @IsString()
    slice?: 'hec' | 'government' | 'un';
}

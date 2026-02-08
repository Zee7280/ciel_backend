import { IsString, IsArray, IsOptional, IsObject, IsEnum } from 'class-validator';

export class CreateOpportunityDto {
    @IsString()
    title: string;

    @IsArray()
    @IsString({ each: true })
    types: string[];

    @IsString()
    mode: string;

    @IsObject()
    location: any;

    @IsObject()
    timeline: any;

    @IsObject()
    sdg_info: any;

    @IsObject()
    objectives: any;

    @IsObject()
    activity_details: any;

    @IsObject()
    supervision: any;

    @IsArray()
    @IsString({ each: true })
    verification_method: string[];

    @IsString()
    @IsOptional()
    visibility?: string;
}

export class UpdateOpportunityDto {
    @IsString()
    id: string;

    @IsString()
    @IsOptional()
    title?: string;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    types?: string[];

    @IsString()
    @IsOptional()
    mode?: string;

    @IsObject()
    @IsOptional()
    location?: any;

    @IsObject()
    @IsOptional()
    timeline?: any;

    @IsObject()
    @IsOptional()
    sdg_info?: any;

    @IsObject()
    @IsOptional()
    objectives?: any;

    @IsObject()
    @IsOptional()
    activity_details?: any;

    @IsObject()
    @IsOptional()
    supervision?: any;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    verification_method?: string[];

    @IsString()
    @IsOptional()
    visibility?: string;

    @IsString()
    @IsOptional()
    status?: string; // active, closed, draft
}

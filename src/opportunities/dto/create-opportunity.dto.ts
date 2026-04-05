import { IsString, IsArray, IsOptional, IsObject, IsEnum, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SupervisionDto {
    @IsString()
    @IsOptional()
    supervisor_name?: string;

    @IsString()
    @IsOptional()
    role?: string;

    @IsString()
    @IsOptional()
    contact?: string;

    @IsBoolean()
    @IsOptional()
    safe_environment?: boolean;

    @IsBoolean()
    @IsOptional()
    supervised?: boolean;

    @IsString()
    @IsOptional()
    partner_org_name?: string;

    @IsString()
    @IsOptional()
    partner_contact_person?: string;

    @IsString()
    @IsOptional()
    partner_email?: string;

    @IsBoolean()
    @IsOptional()
    information_accurate?: boolean;
}

export class CreateOpportunityDto {
    @IsString()
    title: string;

    @IsArray()
    @IsString({ each: true })
    types: string[];

    @IsString()
    mode: string;

    @IsObject()
    @IsOptional()
    location?: any;

    @IsObject()
    @IsOptional()
    timeline?: any;

    @IsObject()
    @IsOptional()
    sdg_info?: any;

    @IsArray()
    @IsOptional()
    secondary_sdgs?: { sdg_id: string, target_id: string, indicator_id: string, justification: string }[];

    @IsObject()
    @IsOptional()
    objectives?: any;

    @IsObject()
    @IsOptional()
    activity_details?: any;

    @ValidateNested()
    @Type(() => SupervisionDto)
    @IsOptional()
    supervision?: SupervisionDto;

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

    @IsArray()
    @IsOptional()
    secondary_sdgs?: { sdg_id: string, target_id: string, indicator_id: string, justification: string }[];

    @IsObject()
    @IsOptional()
    objectives?: any;

    @IsObject()
    @IsOptional()
    activity_details?: any;

    @ValidateNested()
    @Type(() => SupervisionDto)
    @IsOptional()
    supervision?: SupervisionDto;

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

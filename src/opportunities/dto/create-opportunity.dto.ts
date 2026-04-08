import { IsString, IsArray, IsOptional, IsObject, IsEnum, IsBoolean, ValidateNested, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class TimelineDto {
    @IsString()
    @IsOptional()
    type?: string; // fixed | flexible | ongoing

    @IsString()
    @IsOptional()
    start_date?: string;

    @IsString()
    @IsOptional()
    end_date?: string;

    @IsString()
    @IsOptional()
    from_time?: string; // daily window start (e.g. 09:00)

    @IsString()
    @IsOptional()
    to_time?: string;   // daily window end (e.g. 13:00)

    @IsInt()
    @IsOptional()
    expected_hours?: number;

    @IsInt()
    @IsOptional()
    volunteers_required?: number;
}

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

    @IsString()
    @IsOptional()
    faculty_department?: string;

    @IsString()
    @IsOptional()
    faculty_university_name?: string;
}

export class CreateOpportunityDto {
    @IsString()
    title: string;

    @IsArray()
    @IsString({ each: true })
    types: string[];

    @IsString()
    mode: string;

    @IsString()
    @IsOptional()
    student_contact?: string;

    @IsObject()
    @IsOptional()
    location?: any;

    @ValidateNested()
    @Type(() => TimelineDto)
    @IsOptional()
    timeline?: TimelineDto;

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

    @IsArray()
    @IsOptional()
    restricted_universities?: string[];

    @IsObject()
    @IsOptional()
    executing_context?: any;

    @IsObject()
    @IsOptional()
    safety_declaration?: any;

    @IsObject()
    @IsOptional()
    submission_confirmations?: any;

    @IsObject()
    @IsOptional()
    participation_scope?: any;

    @IsObject()
    @IsOptional()
    executing_organization?: any;

    @IsObject()
    @IsOptional()
    partner_organization?: any;

    @IsObject()
    @IsOptional()
    safety_supervision_declaration?: any;

    @IsObject()
    @IsOptional()
    visibility_and_academic_linkage?: any;

    @IsBoolean()
    @IsOptional()
    admin_approval_required?: boolean;

    @IsObject()
    @IsOptional()
    external_partner_collaboration?: any;

    @IsObject()
    @IsOptional()
    academic_linkage?: any;
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

    @ValidateNested()
    @Type(() => TimelineDto)
    @IsOptional()
    timeline?: TimelineDto;

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

import {
  IsString,
  IsArray,
  IsOptional,
  IsObject,
  IsEnum,
  IsBoolean,
  ValidateIf,
  ValidateNested,
  IsInt,
  IsUUID,
  IsNotEmpty,
  ArrayNotEmpty,
  ArrayMaxSize,
  MaxLength,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Full create/submit must satisfy title/types/mode/verification. A mid-wizard `{draft:true}`
 * save is incomplete by definition — StudentController / OpportunitiesService persist it with
 * fallbacks, so those required-field validators must not reject the first "Save draft" click. */
function isFullOpportunitySubmit(dto: { draft?: boolean }) {
  return dto.draft !== true;
}

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
  to_time?: string; // daily window end (e.g. 13:00)

  /** Same bounds the create forms enforce (hours 1–500, seats 1–5000). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  expected_hours?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  @IsOptional()
  volunteers_required?: number;

  @IsString()
  @IsOptional()
  schedule_notes?: string;
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

  /** Partner site contact (student flow); distinct from faculty supervision.contact */
  @IsString()
  @IsOptional()
  external_partner_email?: string;

  @IsBoolean()
  @IsOptional()
  information_accurate?: boolean;

  @IsBoolean()
  @IsOptional()
  private_candidate?: boolean;

  @IsString()
  @IsOptional()
  faculty_department?: string;

  @IsString()
  @IsOptional()
  faculty_university_name?: string;

  /** Optional WhatsApp contact (E.164, e.g. +923001234567) for the contact listed above — the
   * faculty supervisor, or the executing-organization contact person on a partner-created opportunity. */
  @IsString()
  @IsOptional()
  whatsapp_e164?: string;

  @IsString()
  @IsOptional()
  electronic_signature?: string;

  @IsString()
  @IsOptional()
  external_partner_org_name?: string;

  @IsString()
  @IsOptional()
  external_partner_contact_person?: string;
}

export class CreateOpportunityDto {
  /** Student mid-wizard save. Not persisted — StudentController branches on this, then strips it. */
  @IsBoolean()
  @IsOptional()
  draft?: boolean;

  @ValidateIf(isFullOpportunitySubmit)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(200)
  title: string;

  @ValidateIf(isFullOpportunitySubmit)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  types: string[];

  @ValidateIf(isFullOpportunitySubmit)
  @IsString()
  @IsNotEmpty()
  mode: string;

  /** Creator mobile in E.164 (e.g. +923001234567). Private-candidate submit stores the same value on executing_context.private_candidate.phone. */
  @IsString()
  @IsOptional()
  student_contact?: string;

  @IsObject()
  @IsOptional()
  location?: any;

  @ValidateIf(isFullOpportunitySubmit)
  @ValidateNested()
  @Type(() => TimelineDto)
  @IsOptional()
  timeline?: TimelineDto;

  @IsObject()
  @IsOptional()
  sdg_info?: any;

  @IsArray()
  @IsOptional()
  secondary_sdgs?: {
    sdg_id: string;
    target_id: string;
    indicator_id: string;
    justification: string;
  }[];

  @IsObject()
  @IsOptional()
  objectives?: any;

  @IsObject()
  @IsOptional()
  activity_details?: any;

  @ValidateIf(isFullOpportunitySubmit)
  @ValidateNested()
  @Type(() => SupervisionDto)
  @IsOptional()
  supervision?: SupervisionDto;

  @ValidateIf(isFullOpportunitySubmit)
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
  @IsUUID()
  id: string;

  /** Mid-wizard save. Not a column — OpportunitiesService branches on this, then strips it. */
  @IsBoolean()
  @IsOptional()
  draft?: boolean;

  @IsString()
  @MaxLength(200)
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

  @ValidateIf(isFullOpportunitySubmit)
  @ValidateNested()
  @Type(() => TimelineDto)
  @IsOptional()
  timeline?: TimelineDto;

  @IsObject()
  @IsOptional()
  sdg_info?: any;

  @IsArray()
  @IsOptional()
  secondary_sdgs?: {
    sdg_id: string;
    target_id: string;
    indicator_id: string;
    justification: string;
  }[];

  @IsObject()
  @IsOptional()
  objectives?: any;

  @IsObject()
  @IsOptional()
  activity_details?: any;

  @ValidateIf(isFullOpportunitySubmit)
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

  // NOTE: status / sdg / admin_approval_required are intentionally NOT editable here — workflow
  // state is server-owned and sdg is derived from sdg_info.sdg_id.

  @IsObject()
  @IsOptional()
  safety_declaration?: any;

  @IsObject()
  @IsOptional()
  submission_confirmations?: any;

  @IsObject()
  @IsOptional()
  participation_scope?: any;

  @IsArray()
  @IsOptional()
  restricted_universities?: string[];

  @IsObject()
  @IsOptional()
  external_partner_collaboration?: any;

  @IsObject()
  @IsOptional()
  academic_linkage?: any;

  @IsObject()
  @IsOptional()
  executing_context?: any;

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

}

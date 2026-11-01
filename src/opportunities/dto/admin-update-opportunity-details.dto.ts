import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export const ADMIN_EDITABLE_OPPORTUNITY_MODES = [
  'On site',
  'Remote',
  'Hybrid',
] as const;

/**
 * Super Admin "fix wrong details" patch for one opportunity. Every field is optional: only the
 * keys the admin sends are written. `null` on `faculty_user_id` / `organization_id` unlinks.
 */
export class AdminUpdateOpportunityDetailsDto {
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsIn(ADMIN_EDITABLE_OPPORTUNITY_MODES)
  mode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  venue?: string;

  /** YYYY-MM-DD */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  start_date?: string;

  /** YYYY-MM-DD */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  end_date?: string;

  /** HH:mm; empty string clears */
  @IsOptional()
  @IsString()
  @MaxLength(5)
  from_time?: string;

  /** HH:mm; empty string clears */
  @IsOptional()
  @IsString()
  @MaxLength(5)
  to_time?: string;

  /** Same bounds the create forms enforce (hours 1–500, seats 1–5000). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  expected_hours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  volunteers_required?: number;

  /** Eligible departments; an empty list opens the listing to every department. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  departments?: string[];

  /** Registered FACULTY account to bind as supervisor; null removes the faculty supervisor. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  faculty_user_id?: string | null;

  /** Partner / organisation account to bind as the listing's organisation; null unlinks. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  organization_id?: string | null;

  /** With `organization_id`: also copy that account's name and contact onto the partner fields. */
  @IsOptional()
  @IsBoolean()
  copy_partner_contacts_from_organization?: boolean;
}

import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Console “View as” roles (mockup). Mapped onto analytics stakeholder lenses. */
export const ALL_FIELDS_CONSOLE_ROLES = [
  'student',
  'faculty',
  'university',
  'partner',
  'unhec',
] as const;

export type AllFieldsConsoleRole = (typeof ALL_FIELDS_CONSOLE_ROLES)[number];

export class AllFieldsConsoleViewAsQueryDto {
  @IsIn(ALL_FIELDS_CONSOLE_ROLES)
  role!: AllFieldsConsoleRole;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  section!: number;

  /** When project_id is set, scope becomes project; otherwise aggregate. */
  @IsOptional()
  @IsIn(['aggregate', 'project'])
  scope?: 'aggregate' | 'project';

  @IsOptional()
  @IsUUID()
  project_id?: string;

  /** Case-insensitive university name filter on enrolments / reports. */
  @IsOptional()
  @IsString()
  university?: string;
}

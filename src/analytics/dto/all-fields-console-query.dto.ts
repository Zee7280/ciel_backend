import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
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

  @IsOptional()
  @IsIn(['aggregate'])
  scope?: 'aggregate';
}

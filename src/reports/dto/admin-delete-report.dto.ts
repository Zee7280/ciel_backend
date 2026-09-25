import { IsBoolean, IsOptional } from 'class-validator';

/** Each flag is optional. A body with none of them still deletes only the report. */
export class AdminDeleteReportDto {
  @IsOptional()
  @IsBoolean()
  delete_report?: boolean;

  @IsOptional()
  @IsBoolean()
  delete_attendance?: boolean;

  @IsOptional()
  @IsBoolean()
  delete_payment?: boolean;
}

import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CS_REPORT_SOURCE_FILTERS,
  type CsReportSourceFilter,
} from '../cs-reporting.util';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateCsReportDto {
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be a date (YYYY-MM-DD).' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be a date (YYYY-MM-DD).' })
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  university?: string;

  @IsOptional()
  @IsIn(CS_REPORT_SOURCE_FILTERS)
  source?: CsReportSourceFilter;

  @IsOptional()
  @IsBoolean()
  includeStudents?: boolean;

  /** Who the report is for, printed on the PDF (e.g. "Higher Education Commission"). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  preparedFor?: string;
}

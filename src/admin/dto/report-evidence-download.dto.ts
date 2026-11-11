import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';

/** Files the Impact Package shows; the service keeps only URLs found in the report itself. */
export class ReportEvidenceDownloadDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  urls?: string[];
}

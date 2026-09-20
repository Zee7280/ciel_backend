import { ArrayMinSize, IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Phase 4 (batch): run an independent AI analysis across several reports at once — the "run for
 * the whole batch" action from a faculty/university/CIEL PK Community Service pool. Each report
 * still runs the same single-report engine and audit-trail append; see
 * FacultyReportsService.runIndependentAiAnalysisBatch.
 */
export class RunIndependentAnalysisBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  reportIds: string[];

  @IsOptional()
  @IsString()
  note?: string;
}

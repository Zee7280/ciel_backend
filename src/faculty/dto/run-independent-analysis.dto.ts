import { IsOptional, IsString } from 'class-validator';

/**
 * Phase 4: DTO for running independent AI analysis from My Impact Wall.
 *
 * This analysis does NOT overwrite the faculty-approved record.
 * It stores results separately for audit purposes.
 */
export class RunIndependentAnalysisDto {
  @IsOptional()
  @IsString()
  note?: string;
}

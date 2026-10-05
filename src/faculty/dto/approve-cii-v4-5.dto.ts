import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class AdminEvidenceCriterionDto {
  @IsString()
  criterion: string;

  @IsInt()
  @Min(0)
  @Max(4)
  anchor: 0 | 1 | 2 | 3 | 4;

  @IsOptional()
  @IsString()
  reasoningSummary?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidenceIds?: string[];
}

/**
 * Admin Accept & Publish for the CII v5.0 Hybrid score.
 *
 * Dimension 7 (15 evidence points) is scored here by Admin. The published CII is
 * always the generated Composite (AI /85 + Admin evidence /15). Manual final-score
 * override is not part of the standard v5.0.2 flow.
 */
export class ApproveCiiV45Dto {
  /** Optional overall note from Admin. */
  @IsOptional()
  @IsString()
  note?: string;

  /**
   * Ignored by v5.0.2 Confirm. Kept on the DTO so older clients do not 400;
   * the published score is always the generated Composite CII.
   */
  @IsOptional()
  @IsNumber()
  adminAdjustedScore?: number;

  /**
   * Ignored by v5.0.2 Confirm together with adminAdjustedScore.
   */
  @ValidateIf((o) => o.adminAdjustedScore !== undefined)
  @IsOptional()
  @IsString()
  scoreModerationReason?: string;

  /** Seven Dimension-7 evidence criteria (required for a v5.0 analysis still pending Admin D7). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => AdminEvidenceCriterionDto)
  evidenceCriteria?: AdminEvidenceCriterionDto[];

  /** Admin confirmation that an AI-nominated exceptional feature is verified (L6 gate). */
  @IsOptional()
  @IsBoolean()
  exceptionalFeatureAdminVerified?: boolean;
}

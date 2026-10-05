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

  @IsString()
  reasoningSummary: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidenceIds?: string[];
}

/**
 * Admin Accept & Publish for the CII v5.0 Hybrid score.
 *
 * Dimension 7 (15 evidence points) is scored here by Admin. Admin may also
 * accept the combined score as-is, or record a reasoned numeric moderation
 * of the published total. The system retains both: AI Recommended Score →
 * Admin Approved Score.
 */
export class ApproveCiiV45Dto {
  /** Optional overall note from Admin. */
  @IsOptional()
  @IsString()
  note?: string;

  /**
   * If Admin moderates the final score, this holds their adjusted value.
   * When provided and different from the AI-computed score, the system stores both for audit.
   */
  @IsOptional()
  @IsNumber()
  adminAdjustedScore?: number;

  /**
   * Required when adminAdjustedScore differs from the AI-computed score.
   * Creates an audit trail explaining why Admin changed the AI recommendation.
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

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
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

/** R3: the Admin's sourced L6 (sustained impact) confirmations. */
export class CiiL6QualificationDto {
  @IsBoolean()
  observedRetention: boolean;

  @IsBoolean()
  communityOwnership: boolean;

  @IsBoolean()
  externalCorroboration: boolean;

  /** Exact report / follow-up / evidence source the confirmations rest on. */
  @IsString()
  @MaxLength(300)
  sourceRef: string;
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
  @ValidateIf((o: ApproveCiiV45Dto) => o.adminAdjustedScore !== undefined)
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

  /**
   * R3 only (ignored for earlier rubrics): the sourced confirmations behind an L6 award. Without
   * them a 90+ CII is approved and kept, with L6 left pending.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => CiiL6QualificationDto)
  l6Qualification?: CiiL6QualificationDto;
}

/** R3: Admin review of one dimension's AI criterion marks. `null` restores the AI mark. */
export class ModerateCiiV45Dto {
  @IsString()
  dimension: string;

  /** criterion key -> reviewed points (0..criterion maximum, two decimals) or null to restore. */
  @IsObject()
  criterionEdits: Record<string, number | null>;

  /** Required (8+ characters) whenever a mark actually changes; checked by the service. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  sourceRef?: string;

  /** The moderation revision the editor read; a mismatch means someone else changed the marks. */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}

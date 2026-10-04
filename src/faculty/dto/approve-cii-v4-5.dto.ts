import { IsOptional, IsString, IsNumber, ValidateIf } from 'class-validator';

/**
 * Admin Accept & Publish for the CII v4.5 score.
 *
 * Admin may accept the AI-recommended score as-is, or record a reasoned numeric moderation
 * (whole-score only — v4.5 has no per-criterion override). The system retains both: AI
 * Recommended Score → Admin Approved Score.
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
}

import {
  IsOptional,
  IsString,
  IsNumber,
  IsObject,
  ValidateIf,
} from 'class-validator';

/**
 * Phase 2: Faculty Override with Audit Trail
 *
 * When faculty adjusts the AI-recommended score, they must provide a reason.
 * The system retains both: AI Recommended Score → Faculty Approved Score
 */
export class ApproveCiiV2Dto {
  /** Optional overall note from faculty */
  @IsOptional()
  @IsString()
  note?: string;

  /**
   * If faculty adjusts the final score, this holds their adjusted value.
   * When provided, the system stores both AI and Faculty scores for audit.
   */
  @IsOptional()
  @IsNumber()
  facultyAdjustedScore?: number;

  /**
   * Required when facultyAdjustedScore differs from the AI-computed score.
   * Creates an audit trail explaining why faculty changed the AI recommendation.
   */
  @ValidateIf((o) => o.facultyAdjustedScore !== undefined)
  @IsOptional()
  @IsString()
  scoreAdjustmentReason?: string;

  /**
   * Per-criterion overrides: faculty can adjust individual criterion anchors.
   * Each override must include the AI value, faculty value, and reason.
   */
  @IsOptional()
  @IsObject()
  criteriaOverrides?: Record<
    string,
    {
      aiAnchor: number;
      facultyAnchor: number;
      reason: string;
    }
  >;
}

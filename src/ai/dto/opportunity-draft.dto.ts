import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TEAM_MODES, type TeamMode } from '../../opportunities/team-mode.util';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Body of POST /ai/opportunity-draft — the student's brainstorm and their own fixed facts. */
export class OpportunityDraftDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(4000)
  idea: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title_hint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  place?: string;

  @IsOptional()
  @IsIn(TEAM_MODES)
  team_mode?: TeamMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  seats?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  hours?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  beneficiaries?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  main_partner?: string;

  @IsOptional()
  @Matches(ISO_DATE)
  start_date?: string;

  @IsOptional()
  @Matches(ISO_DATE)
  end_date?: string;

  @IsOptional()
  @IsIn(['university', 'private'])
  creator_pathway?: 'university' | 'private';
}

import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** One roster correction on an enrolled seat: move to another team, make individual, or make lead. */
export class AdminTeamOpDto {
  @IsIn(['move', 'split', 'set_lead'])
  op: 'move' | 'split' | 'set_lead';

  /** Participation row (enrolled seat) the operation applies to. */
  @IsUUID('4')
  member_participation_id: string;

  /** `move` only: the persisted team id the seat joins. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  target_team_id?: string;
}

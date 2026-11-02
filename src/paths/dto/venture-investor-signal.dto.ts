import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { VENTURE_SIGNAL_KINDS } from '../entities/venture-investor-signal.entity';

export class RecordVentureSignalDto {
  @IsIn([...VENTURE_SIGNAL_KINDS])
  kind: 'view' | 'save' | 'interest' | 'intro';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class FounderIntroDecisionDto {
  @IsIn(['accept', 'decline'])
  decision: 'accept' | 'decline';
}

export class AdminIntroScreeningDto {
  @IsIn(['screened', 'declined'])
  status: 'screened' | 'declined';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

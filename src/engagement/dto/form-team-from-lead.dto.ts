import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

export class FormTeamFromLeadDto {
  @IsUUID()
  projectId: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  memberParticipationIds?: string[];
}

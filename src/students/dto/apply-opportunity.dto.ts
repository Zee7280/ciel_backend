import { IsString, IsUUID, IsOptional } from 'class-validator';

export class ApplyOpportunityDto {
    @IsUUID()
    opportunityId: string;

    @IsOptional()
    @IsString()
    @IsOptional()
    coverLetter?: string;

    @IsString()
    @IsOptional()
    participation_type?: string;

    @IsOptional()
    team_members?: any[];
}

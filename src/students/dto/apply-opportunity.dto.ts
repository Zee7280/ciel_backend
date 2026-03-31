import { IsString, IsUUID, IsOptional, IsEmail } from 'class-validator';

export class ApplyOpportunityDto {
    @IsUUID()
    opportunityId: string;

    @IsOptional()
    @IsString()
    coverLetter?: string;

    @IsString()
    @IsOptional()
    participation_type?: string;

    @IsEmail()
    primary_faculty_email: string;

    @IsOptional()
    @IsEmail()
    secondary_faculty_email?: string;

    @IsOptional()
    @IsString()
    team_id?: string;

    @IsOptional()
    team_members?: any[];
}

import { IsString, IsUUID, IsOptional, IsEmail, IsIn } from 'class-validator';

export class ApplyOpportunityDto {
    @IsUUID()
    opportunityId: string;

    @IsOptional()
    @IsString()
    coverLetter?: string;

    @IsString()
    @IsOptional()
    participation_type?: string;

    @IsOptional()
    @IsEmail()
    primary_faculty_email?: string;

    @IsOptional()
    @IsEmail()
    secondary_faculty_email?: string;

    @IsOptional()
    @IsString()
    team_id?: string;

    @IsOptional()
    team_members?: any[];

    @IsOptional()
    @IsString()
    contact_phone_e164?: string;

    @IsOptional()
    @IsIn(['partner', 'faculty'])
    attendance_approver_type?: 'partner' | 'faculty';
}

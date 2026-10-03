import { IsString, IsUUID, IsOptional, IsEmail, IsIn, IsArray, ArrayMaxSize } from 'class-validator';

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

    /** Team lead + members may not exceed 20 (the lead is not part of this list → at most 19). */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(19, { message: 'A team can have at most 20 members including the team lead.' })
    team_members?: any[];

    @IsOptional()
    @IsString()
    contact_phone_e164?: string;

    @IsOptional()
    @IsIn(['partner', 'faculty'])
    attendance_approver_type?: 'partner' | 'faculty';
}

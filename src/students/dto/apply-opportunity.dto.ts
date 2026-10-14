import { IsString, IsUUID, IsOptional, IsEmail, IsIn, IsArray, ArrayMaxSize } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';

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

    /** Team lead + members may not exceed 20. The dialog sends the lead's own row in this list too
     * (the service drops it), so 20 rows are allowed here; the seat cap is enforced in the service. */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20, { message: 'A team can have at most 20 members including the team lead.' })
    team_members?: any[];

    @IsOptional()
    @IsString()
    contact_phone_e164?: string;

    @IsOptional()
    @IsIn(['partner', 'faculty'])
    attendance_approver_type?: 'partner' | 'faculty';
}

/** Body of POST /students/opportunities/:id/apply — the opportunity comes from the URL. */
export class ApplyOpportunityByIdDto extends OmitType(ApplyOpportunityDto, ['opportunityId'] as const) {}

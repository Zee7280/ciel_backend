import { IsString, IsOptional, IsIn } from 'class-validator';

export class ManageApplicantsDto {
    @IsString()
    id: string; // opportunity ID

    @IsString()
    @IsOptional()
    applicantId?: string;

    @IsString()
    @IsOptional()
    @IsIn(['pending', 'shortlisted', 'accepted', 'rejected'])
    status?: string;
}

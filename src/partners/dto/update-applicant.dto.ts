import { IsString, IsIn } from 'class-validator';

export class UpdateApplicantDto {
    @IsString()
    id: string; // opportunity ID

    @IsString()
    applicantId: string;

    @IsString()
    @IsIn(['pending', 'shortlisted', 'accepted', 'rejected'])
    status: string;
}

import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class PatchAttendanceApprovalDto {
    @IsIn(['approve', 'reject', 'flag'])
    action: 'approve' | 'reject' | 'flag';

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    reason?: string;
}

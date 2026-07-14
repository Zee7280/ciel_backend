import {
    IsBoolean,
    IsDateString,
    IsEmail,
    IsIn,
    IsOptional,
    IsUUID,
} from 'class-validator';

export class CreateAttendanceVerifyRequestDto {
    @IsUUID()
    projectId: string;

    @IsOptional()
    @IsUUID()
    participantId?: string;

    @IsDateString()
    requestedAt: string;

    /**
     * Student choice after the oath: who should approve attendance.
     * Optional for rolling deploys (legacy clients omit this and keep previous routing).
     */
    @IsOptional()
    @IsIn(['faculty', 'partner'])
    attendanceApproverType?: 'faculty' | 'partner';

    /**
     * When attendanceApproverType is faculty: optional specific faculty reviewer email.
     * Falls back to participation primary/secondary faculty emails when omitted.
     */
    @IsOptional()
    @IsEmail()
    facultyEmail?: string;

    /**
     * New clients send true after Step-3 oath.
     * Optional for rolling deploys — legacy clients omit this field.
     */
    @IsOptional()
    @IsBoolean()
    oathCompleted?: boolean;
}

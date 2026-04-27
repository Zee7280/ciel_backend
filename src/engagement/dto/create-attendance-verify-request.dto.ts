import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class CreateAttendanceVerifyRequestDto {
    @IsUUID()
    projectId: string;

    @IsOptional()
    @IsUUID()
    participantId?: string;

    @IsDateString()
    requestedAt: string;
}

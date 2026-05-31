import { IsString, IsDecimal, IsISO8601, MaxLength, Matches, IsOptional, IsBooleanString, IsBoolean } from 'class-validator';
import {
    ATTENDANCE_DESCRIPTION_MAX_CHARS,
    ATTENDANCE_DESCRIPTION_MAX_WORDS,
} from '../attendance-description.constants';

export class CreateAttendanceLogDto {
    @IsISO8601()
    dateOfEngagement: string;

    @IsString()
    @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'startTime must be in HH:mm format' })
    startTime: string;

    @IsString()
    @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'endTime must be in HH:mm format' })
    endTime: string;

    @IsString()
    organizationName: string;

    @IsString()
    activityType: string;

    @IsString()
    @MaxLength(ATTENDANCE_DESCRIPTION_MAX_CHARS, {
        message: `Brief description must be ${ATTENDANCE_DESCRIPTION_MAX_CHARS} characters or fewer. Keep it concise (max ${ATTENDANCE_DESCRIPTION_MAX_WORDS} words).`,
    })
    description: string;

    @IsOptional()
    evidenceUploaded?: any;
}

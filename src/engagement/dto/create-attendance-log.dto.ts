import { IsString, IsDecimal, IsISO8601, MaxLength, Matches, IsOptional, IsBooleanString, IsBoolean } from 'class-validator';

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
    @MaxLength(300)
    description: string;

    @IsOptional()
    evidenceUploaded?: any;
}

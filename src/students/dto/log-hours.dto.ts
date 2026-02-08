import { IsString, IsUUID, IsInt, IsDateString, IsOptional, IsArray } from 'class-validator';

export class LogHoursDto {
    @IsUUID()
    opportunityId: string;

    @IsInt()
    hours: number;

    @IsDateString()
    date: string;

    @IsString()
    description: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    evidence?: string[];
}

import { IsString, IsOptional, IsInt, IsArray, IsNumber } from 'class-validator';

export class CreateReportDto {
    @IsString()
    title: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsInt()
    beneficiaries?: number;

    @IsOptional()
    @IsInt()
    hoursLogged?: number;

    @IsOptional()
    @IsArray()
    @IsNumber({}, { each: true })
    sdgs?: number[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    evidence?: string[];

    @IsOptional()
    @IsString()
    opportunityId?: string;
}

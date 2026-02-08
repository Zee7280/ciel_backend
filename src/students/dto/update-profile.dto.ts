import { IsString, IsOptional, IsArray, IsNumber } from 'class-validator';

export class UpdateStudentProfileDto {
    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsString()
    university?: string;

    @IsOptional()
    @IsString()
    major?: string;

    @IsOptional()
    @IsString()
    bio?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    interests?: string[];

    @IsOptional()
    @IsArray()
    @IsNumber({}, { each: true })
    sdgPreferences?: number[];
}

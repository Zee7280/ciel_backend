import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Admin POST body for creating an FAQ entry. */
export class CreateSupportFaqDto {
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    question: string;

    @IsString()
    @MinLength(1)
    answer: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    category?: string;

    @IsOptional()
    @IsBoolean()
    isPublished?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    sortOrder?: number;
}

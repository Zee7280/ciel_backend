import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Admin PATCH body — only provided fields are updated. */
export class UpdateSupportFaqDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    question?: string;

    @IsOptional()
    @IsString()
    @MinLength(1)
    answer?: string;

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

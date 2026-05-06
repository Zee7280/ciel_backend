import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const SECTIONS_EASE = ['very_easy', 'easy', 'neutral', 'difficult', 'very_difficult'] as const;
const REFLECT = ['yes', 'partially', 'no'] as const;

export class CreateCepSurveyResponseDto {
    @IsInt()
    @Min(1)
    @Max(5)
    overallRating: number;

    @IsIn([...SECTIONS_EASE])
    sectionsEase: string;

    @IsIn([...REFLECT])
    reflectImpact: string;

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    mostUsefulText?: string;

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    improvementText?: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ApproveFypAiAnalysisDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class FypAiDimensionEditDto {
  @IsString()
  key: string;

  // Individual dimension maxes go up to 20 (Rigor) — validated precisely server-side against the
  // locked rubric in computeFypAiResult; this is just a generous outer bound.
  @IsNumber()
  @Min(0)
  @Max(20)
  score: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  rationale?: string;
}

export class EditFypAiAnalysisDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => FypAiDimensionEditDto)
  dimensions: FypAiDimensionEditDto[];
}

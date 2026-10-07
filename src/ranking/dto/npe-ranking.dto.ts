import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class NpeAnalyzeProjectDto {
  @IsString()
  id: string;

  @IsString()
  version: string;
}

export class NpeAnalyzeDto {
  @IsOptional()
  @IsString()
  rubricVersion?: string;

  @IsOptional()
  @IsString()
  scope?: string;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => NpeAnalyzeProjectDto)
  projects: NpeAnalyzeProjectDto[];
}

export class NpePublishDto {
  @IsString()
  runId: string;

  @IsOptional()
  @IsString()
  rubricVersion?: string;

  @IsOptional()
  @IsString()
  scope?: string;
}

export class NpeClearReviewDto {
  @IsString()
  runId: string;

  @IsString()
  itemId: string;
}

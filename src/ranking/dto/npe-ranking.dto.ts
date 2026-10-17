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

  /** Continue this draft run (reads only packages without an evaluation yet). */
  @IsOptional()
  @IsString()
  runId?: string;

  @IsArray()
  // A national run covers every approved package of every university; the server reads them in
  // time-boxed batches, so the list itself only has to be accepted whole.
  @ArrayMaxSize(5000)
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

/** Ranking Studio: preview and publish share one body, so what is published is what was previewed. */
export class NpeStudioDto {
  /** Ranking run to read evaluations from (defaults to the scope's latest run). */
  @IsOptional()
  @IsString()
  runId?: string;

  @IsOptional()
  @IsString()
  lens?: string;

  @IsOptional()
  @IsString()
  groupBy?: string;

  @IsOptional()
  filters?: Record<string, unknown>;

  @IsOptional()
  weights?: Record<string, unknown>;

  /** Custom label for the Impact Wall; defaults to the generated name. */
  @IsOptional()
  @IsString()
  name?: string;
}

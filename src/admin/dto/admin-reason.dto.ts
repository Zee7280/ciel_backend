import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional rejection reason: a non-string / oversized reason is a 400 instead of a 500 downstream. */
export class AdminReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

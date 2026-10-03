import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdminReportVerifyDto {
  @IsIn(['approve', 'reject', 'unlock'])
  action: 'approve' | 'reject' | 'unlock';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  feedback?: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

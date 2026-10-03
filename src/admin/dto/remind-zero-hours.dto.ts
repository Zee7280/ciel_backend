import { IsBoolean, IsOptional } from 'class-validator';

export class RemindZeroHoursDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

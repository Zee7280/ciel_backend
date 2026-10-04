import { IsBoolean, IsOptional } from 'class-validator';

export class AdminDirectoryControlDto {
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @IsBoolean()
  expired?: boolean;
}

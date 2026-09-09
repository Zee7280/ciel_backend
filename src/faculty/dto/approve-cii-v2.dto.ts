import { IsOptional, IsString } from 'class-validator';

export class ApproveCiiV2Dto {
  @IsOptional()
  @IsString()
  note?: string;
}

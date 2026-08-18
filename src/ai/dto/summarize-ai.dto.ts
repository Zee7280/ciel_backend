import { IsNotEmpty, IsString } from 'class-validator';

export class SummarizeAiDto {
  @IsString()
  @IsNotEmpty()
  section: string;

  @IsNotEmpty()
  data: unknown;
}

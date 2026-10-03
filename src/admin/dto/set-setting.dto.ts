import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SetSettingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  key: string;

  /** Booleans / numbers from JSON clients are coerced to strings; the registry validates per key. */
  @Transform(({ value }) =>
    typeof value === 'boolean' || typeof value === 'number'
      ? String(value)
      : value,
  )
  @IsString()
  @MaxLength(5000)
  value: string;
}

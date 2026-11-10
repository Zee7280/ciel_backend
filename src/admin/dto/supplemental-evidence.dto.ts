import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** R3: Admin asks for an upload URL for a supplemental evidence file. */
export class SupplementalEvidencePresignDto {
  @IsString()
  @MaxLength(255)
  filename: string;

  @IsString()
  @MaxLength(120)
  contentType: string;

  @IsOptional()
  @IsNumber()
  size?: number;
}

/** R3: registers an uploaded supplemental file against a report (always labelled). */
export class AddSupplementalEvidenceDto {
  @IsString()
  @MaxLength(2048)
  url: string;

  @IsString()
  @MaxLength(255)
  name: string;

  /** Why the file was added; shown wherever the file is listed. */
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  section?: string;

  @IsOptional()
  @IsIn(['public', 'restricted', 'private'])
  visibility?: 'public' | 'restricted' | 'private';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;
}

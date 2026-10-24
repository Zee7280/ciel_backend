import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { SSO_PROVIDERS, type SsoProvider } from '../university-sso.constants';

export class UpsertUniversitySsoDto {
  @IsIn(SSO_PROVIDERS)
  provider: SsoProvider;

  /** Generic OpenID Connect only. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  issuer?: string;

  /** Microsoft tenant id (required for Microsoft) or Google Workspace primary domain (optional). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  tenantId?: string;

  @IsString()
  @MaxLength(255)
  clientId: string;

  /** Required when first configuring; leave out to keep the stored secret. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  clientSecret?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  allowedDomains: string[];
}

export class ActivateUniversitySsoDto {
  /** Activate although no successful test sign-in is recorded. Written to the audit log. */
  @IsOptional()
  @IsBoolean()
  skipTest?: boolean;
}

export class SsoStartQuery {
  @IsUUID()
  university: string;

  /** Relative path to open after sign-in. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  next?: string;

  @IsOptional()
  @IsIn(['0', '1', 'true', 'false'])
  mobile?: string;
}

export class SsoTestQuery {
  @IsString()
  @MaxLength(4000)
  token: string;
}

export class SsoCallbackQuery {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  error?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  error_description?: string;
}

export class SsoExchangeDto {
  @IsString()
  @MaxLength(200)
  ticket: string;
}

export class SsoCompleteDto {
  @IsString()
  @MaxLength(4000)
  token: string;

  @IsString()
  @MaxLength(40)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  countryCode?: string;

  @IsString()
  @MaxLength(120)
  department: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  registrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsBoolean()
  acceptedTerms: boolean;
}

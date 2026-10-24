import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { HUB_EVENT_TYPES } from '../../intake/envelope.util';

export class CreatePlatformDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsIn(['push', 'pull', 'file'])
  integrationMode?: 'push' | 'pull' | 'file';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsIn([...HUB_EVENT_TYPES], { each: true })
  approvedEventTypes?: string[];

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  technicalContact?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  agreementReference?: string;
}

export class UpdatePlatformDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsIn(['push', 'pull', 'file'])
  integrationMode?: 'push' | 'pull' | 'file';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsIn([...HUB_EVENT_TYPES], { each: true })
  approvedEventTypes?: string[];

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  technicalContact?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  agreementReference?: string;
}

export class SetPlatformStatusDto {
  @IsIn(['sandbox', 'live', 'suspended', 'retired'])
  status: 'sandbox' | 'live' | 'suspended' | 'retired';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class IssueCredentialDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expiresInDays?: number;
}

export class ProposeConnectionDto {
  @IsUUID()
  platformId: string;

  /** Required when a Super Admin proposes; ignored for organization admins (their own org). */
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  purpose?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsIn([...HUB_EVENT_TYPES], { each: true })
  scopes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  dpaReference?: string;

  @IsOptional()
  @IsBoolean()
  personalFieldsAllowed?: boolean;

  @IsOptional()
  @IsBoolean()
  orgEvidenceOpenAllowed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  referralDomain?: string;
}

export class UpdateConnectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  purpose?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsIn([...HUB_EVENT_TYPES], { each: true })
  scopes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  dpaReference?: string;

  @IsOptional()
  @IsBoolean()
  personalFieldsAllowed?: boolean;

  @IsOptional()
  @IsBoolean()
  orgEvidenceOpenAllowed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  referralDomain?: string;

  @IsOptional()
  @IsString()
  validUntil?: string;
}

export class ConnectionDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ReviewRecordDto {
  @IsIn(['unreviewed', 'reviewed', 'disputed', 'clarification_requested'])
  reviewState:
    | 'unreviewed'
    | 'reviewed'
    | 'disputed'
    | 'clarification_requested';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class MetricDefinitionDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  code: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name: string;

  @IsString()
  @MaxLength(32)
  unit: string;

  @IsOptional()
  @IsIn(['number', 'integer'])
  dataType?: 'number' | 'integer';

  @IsOptional()
  @IsIn(['sum', 'average', 'unique_count', 'latest', 'non_additive'])
  aggregation?: 'sum' | 'average' | 'unique_count' | 'latest' | 'non_additive';

  @IsOptional()
  @IsIn([
    'observed',
    'self_reported',
    'estimated',
    'projected',
    'externally_verified',
  ])
  defaultClassification?:
    | 'observed'
    | 'self_reported'
    | 'estimated'
    | 'projected'
    | 'externally_verified';

  @IsOptional()
  minValue?: number | null;

  @IsOptional()
  maxValue?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sector?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(17)
  @IsInt({ each: true })
  sdgs?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  methodologyNotes?: string;

  @IsOptional()
  @IsObject()
  platformFieldMappings?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

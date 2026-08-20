import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// Generous caps — high enough to never bother a genuine student answer, just a ceiling
// against jsonb bloat / malformed clients. Free-text answers in this wizard are short
// (one line to a paragraph), so 2000 chars covers even a very thorough response.
const FREE_TEXT_MAX = 2000;
const LIST_MAX = 20;

export class FypMilestoneDto {
  @IsString()
  label: string;

  @IsIn(['pending', 'in_progress', 'complete'])
  status: 'pending' | 'in_progress' | 'complete';

  @IsOptional()
  @IsString()
  dueDate?: string | null;

  @IsOptional()
  @IsString()
  completedAt?: string | null;
}

export class FypCommunityLinkageDto {
  @IsOptional()
  @IsString()
  orgName?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

// ── 9-step guided wizard nested DTOs (additive) ──

export class FypProjectInfoDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) title?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) school?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) degree?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) graduationYear?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) projectType?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) studentName?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) studentEmail?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) rollNumber?: string;
  /** {name, email?, role?} per member — kept loosely typed since older clients may still send plain strings. */
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) teamMembers?: unknown[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) supervisorName?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) supervisorEmail?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) coSupervisorName?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) coSupervisorEmail?: string;
}
export class FypBackgroundInfoDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) problem?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) whyUrgent?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) whyUrgentOther?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) audience?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) audienceOther?: string;
}
export class FypObjectivesInfoDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) aim?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) objectives?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) scope?: string;
}
export class FypLiteratureInfoDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) sourcesReviewed?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) sourceTypes?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) sourceTypesOther?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) gap?: string;
}
export class FypMethodologyInfoDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) approaches?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) methods?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) methodsOther?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) sampleScale?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) tools?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) periodFrom?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) periodTo?: string;
}
export class FypFindingsInfoDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) findings?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) measurableImpact?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) limitationType?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) limitationDetail?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) evidenceStatus?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) metricName?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) metricValue?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) metricUnit?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) numberRepresents?: string;
}
export class FypRouteDetailsDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) showMonth?: string;
  @IsOptional() @IsNumber() piecesShown?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) juryExaminer?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) buildStatus?: string;
  @IsOptional() @IsNumber() testersCount?: number;
  @IsOptional() @IsNumber() iterationsCount?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) screeningMonth?: string;
  @IsOptional() @IsNumber() audienceReached?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) runtimeFormat?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) clientOrg?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) engagementBasis?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) recommendationStatus?: string;
}
export class FypSdgEntryDto {
  @IsNumber() goalNumber: number;
  @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) targets: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) how?: string;
}
export class FypSdgMappingDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => FypSdgEntryDto)
  entries?: FypSdgEntryDto[];

  @IsOptional() @IsBoolean() noSdgApplies?: boolean;
}
export class FypReflectionInfoDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) biggestLesson?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) hardestMoment?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) wrongAssumption?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) sustainabilityShift?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) skills?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) whatsNext?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) adviceForNext?: string;
}
export class FypRepositoryInfoDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) externalLinks?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) visibility?: string;
}
export class FypSectionSummariesDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) project?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) background?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) objectives?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) literature?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) methodology?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) findings?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) sdg?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) reflection?: string;
}

export class UpdateFypDto {
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  projectTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  overview?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FypMilestoneDto)
  milestones?: FypMilestoneDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => FypCommunityLinkageDto)
  communityLinkage?: FypCommunityLinkageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => FypProjectInfoDto)
  projectInfo?: FypProjectInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypBackgroundInfoDto)
  background?: FypBackgroundInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypObjectivesInfoDto)
  objectivesInfo?: FypObjectivesInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypLiteratureInfoDto)
  literature?: FypLiteratureInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypMethodologyInfoDto)
  methodology?: FypMethodologyInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypFindingsInfoDto)
  findings?: FypFindingsInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypRouteDetailsDto)
  routeDetails?: FypRouteDetailsDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypSdgMappingDto)
  sdgMapping?: FypSdgMappingDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypReflectionInfoDto)
  reflectionInfo?: FypReflectionInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypRepositoryInfoDto)
  repository?: FypRepositoryInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => FypSectionSummariesDto)
  sectionSummaries?: FypSectionSummariesDto;

  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) addedNote?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9)
  stepCompleted?: number;

  @IsOptional() @IsIn(['draft', 'submitted']) status?: 'draft' | 'submitted';
}

export class AddFypDeliverableDto {
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  label: string;

  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  fileUrl: string;
}

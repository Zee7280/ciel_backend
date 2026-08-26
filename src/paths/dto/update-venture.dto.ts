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
// against jsonb bloat / malformed clients.
const FREE_TEXT_MAX = 2000;
const LIST_MAX = 20;

export class VentureTractionRowDto {
    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    date: string;

    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    metric: string;

    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    value: string;

    @IsOptional()
    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    note?: string;
}

export class VentureTeamMemberDto {
    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    name: string;

    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    role: string;

    @IsOptional()
    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    email?: string;
}

// ── 8-step guided wizard nested DTOs (additive) ──

export class VentureAcademicSetupDto {
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) submissionType?: string;
    @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) @MaxLength(FREE_TEXT_MAX, { each: true }) submissionTypes?: string[];
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) university?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) campus?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) faculty?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) department?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) program?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) academicYear?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) semester?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) courseCode?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) groupId?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) supervisorName?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) supervisorEmail?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) coSupervisor?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) deadline?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) teamType?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) industrySponsor?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) ethicsApproval?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) confidentialityStatus?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) ipOwnership?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founderName?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founderRole?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founderCredentials?: string;
}

export class VentureIdeaInfoDto {
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) problem?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) proofFact?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) payerWho?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) userWho?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) beneficiaryWho?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) sector?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) city?: string;
    @IsOptional() @IsString() @MaxLength(120) pitch?: string;
}

export class VentureSolutionInfoDto {
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) solution?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) alternative?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) advantage?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) revenue?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) costPerSale?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) milestone12mo?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) marketWho?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) marketSize?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) marketSource?: string;
}

export class VentureSdgEntryDto {
    @IsNumber() goalNumber: number;
    @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) targets: string[];
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) how?: string;
}
export class VentureIndicatorDto {
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) indicator?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) forGoal?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) target12mo?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) verifiedBy?: string;
}
export class VentureSdgMappingDto {
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(3)
    @ValidateNested({ each: true })
    @Type(() => VentureSdgEntryDto)
    entries?: VentureSdgEntryDto[];

    @IsOptional() @IsIn(['map', 'review', 'none']) mode?: 'map' | 'review' | 'none';
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) howImpact?: string;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIST_MAX)
    @ValidateNested({ each: true })
    @Type(() => VentureIndicatorDto)
    indicators?: VentureIndicatorDto[];
}

export class VentureEvidenceInfoDto {
    @IsOptional() @IsNumber() @Min(0) interviews?: number;
    @IsOptional() @IsNumber() @Min(0) surveyResponses?: number;
    @IsOptional() @IsNumber() @Min(0) willingToTest?: number;
    @IsOptional() @IsNumber() @Min(0) testers?: number;
    @IsOptional() @IsNumber() @Min(0) pilotPartners?: number;
    @IsOptional() @IsNumber() @Min(0) preOrders?: number;
    @IsOptional() @IsNumber() @Min(0) customers?: number;
    @IsOptional() @IsNumber() @Min(0) revenueToDate?: number;
    @IsOptional() @IsNumber() monthlyGrowthPercent?: number;
    @IsOptional() @IsNumber() @Min(0) @Max(100) repeatPercent?: number;
    @IsOptional() @IsNumber() @Min(0) partnerships?: number;
    @IsOptional() @IsNumber() @Min(0) lettersOfIntent?: number;
    @IsOptional() @IsNumber() @Min(0) fundingSought?: number;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) useOfFunds?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) expectedResult?: string;
    @IsOptional() @IsArray() @ArrayMaxSize(LIST_MAX) @IsString({ each: true }) openTo?: string[];
}

export class VentureReviewPipelineDto {
    @IsOptional() @IsBoolean() declarationWork?: boolean;
    @IsOptional() @IsBoolean() declarationConsent?: boolean;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) studentDeclaredAt?: string;
    @IsOptional() @IsIn(['not_started', 'pending', 'approved', 'revisions_requested']) supervisorStatus?: 'not_started' | 'pending' | 'approved' | 'revisions_requested';
    @IsOptional() @IsIn(['not_started', 'pending', 'approved']) universityStatus?: 'not_started' | 'pending' | 'approved';
    @IsOptional() @IsIn(['not_started', 'pending', 'approved']) sdgReviewStatus?: 'not_started' | 'pending' | 'approved';
}

export class VenturePublishSettingsDto {
    @IsOptional() @IsIn(['private', 'university', 'partners', 'investors']) audience?: 'private' | 'university' | 'partners' | 'investors';
    @IsOptional() @IsBoolean() showName?: boolean;
    @IsOptional() @IsBoolean() showTeam?: boolean;
    @IsOptional() @IsBoolean() showUniversity?: boolean;
    @IsOptional() @IsBoolean() showTraction?: boolean;
    @IsOptional() @IsBoolean() showAsk?: boolean;
    @IsOptional() @IsBoolean() acceptIntros?: boolean;
}

export class VentureTeamConsentEntryDto {
    @IsString() @MaxLength(FREE_TEXT_MAX) name: string;
    @IsBoolean() consented: boolean;
}

export class VentureSectionSummariesDto {
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) opportunity?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) advantage?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) business?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) traction?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) impact?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) ask?: string;
    @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founder?: string;
}

export class VentureDocumentDto {
    @IsString() @MaxLength(FREE_TEXT_MAX) type: string;
    @IsString() @MaxLength(FREE_TEXT_MAX) fileUrl: string;
}

export class UpdateVentureDto {
    @IsOptional()
    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    ventureName?: string;

    @IsOptional()
    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    description?: string;

    @IsOptional()
    @IsString()
    @MaxLength(FREE_TEXT_MAX)
    stage?: string;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIST_MAX)
    @ValidateNested({ each: true })
    @Type(() => VentureTractionRowDto)
    tractionRows?: VentureTractionRowDto[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIST_MAX)
    @ValidateNested({ each: true })
    @Type(() => VentureTeamMemberDto)
    team?: VentureTeamMemberDto[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIST_MAX)
    materialUrls?: string[];

    @IsOptional() @ValidateNested() @Type(() => VentureAcademicSetupDto) academicSetup?: VentureAcademicSetupDto;
    @IsOptional() @ValidateNested() @Type(() => VentureIdeaInfoDto) ideaInfo?: VentureIdeaInfoDto;
    @IsOptional() @ValidateNested() @Type(() => VentureSolutionInfoDto) solutionInfo?: VentureSolutionInfoDto;
    @IsOptional() @ValidateNested() @Type(() => VentureSdgMappingDto) sdgMapping?: VentureSdgMappingDto;
    @IsOptional() @ValidateNested() @Type(() => VentureEvidenceInfoDto) evidenceInfo?: VentureEvidenceInfoDto;
    @IsOptional() @ValidateNested() @Type(() => VentureReviewPipelineDto) reviewPipeline?: VentureReviewPipelineDto;
    @IsOptional() @ValidateNested() @Type(() => VenturePublishSettingsDto) publishSettings?: VenturePublishSettingsDto;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIST_MAX)
    @ValidateNested({ each: true })
    @Type(() => VentureTeamConsentEntryDto)
    teamConsent?: VentureTeamConsentEntryDto[];

    @IsOptional() @ValidateNested() @Type(() => VentureSectionSummariesDto) sectionSummaries?: VentureSectionSummariesDto;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(8)
    stepCompleted?: number;

    @IsOptional() @IsIn(['draft', 'submitted']) status?: 'draft' | 'submitted';
}

export class SupervisorReviewVentureDto {
    @IsIn(['approve', 'reject'])
    action: 'approve' | 'reject';
    @IsOptional() @IsString() note?: string;
}

export class AddVentureDocumentDto extends VentureDocumentDto {}

export class SetVentureVisibilityDto {
    @IsBoolean()
    isVisible: boolean;
}

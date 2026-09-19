import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

// Generous caps — high enough to never bother a genuine student answer, just a ceiling
// against jsonb bloat / malformed clients.
const FREE_TEXT_MAX = 2000;
const LIST_MAX = 20;
// sectionSummaries.* are composed paragraphs stitched together from several fields at once —
// routinely well past 2000 chars for a detailed venture, unlike the single-purpose inputs
// FREE_TEXT_MAX is sized for. Matches the same fix applied to FYP's equivalent DTO, after a
// rejected save here was found to surface no usable error to the student.
const SECTION_SUMMARY_MAX = 8000;

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

export class VentureNamedRowDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) name?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) price?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) strength?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) weakness?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) category?: string;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) note?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) source?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) type?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) description?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) likelihood?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) impact?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) mitigation?: string;
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

  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) whatsappCode?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) whatsappNumber?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) commitment?: string;
}

// ── 8-step guided wizard nested DTOs (additive) ──

export class VentureAcademicSetupDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) submissionType?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  submissionTypes?: string[];
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
  /** Self-declared by the student, matched verbatim against the reviewing faculty's own login
   * email in supervisorReviewVenture — format-checked only, never verified against a roster. */
  @IsOptional()
  @ValidateIf((o) => !!o.supervisorEmail)
  @IsEmail()
  @MaxLength(FREE_TEXT_MAX)
  supervisorEmail?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) coSupervisor?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) deadline?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) teamType?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) industrySponsor?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) ethicsApproval?: string;
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  confidentialityStatus?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) ipOwnership?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founderName?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founderRole?: string;
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  founderCredentials?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) facultyRole?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) courseRef?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) origin?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founderEmail?: string;
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  founderWhatsappCode?: string;
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  founderWhatsappNumber?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) teamFit?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) founderInsight?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) legalStatus?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) ventureType?: string;
  /** v13 extras — stored in the same academicSetup jsonb blob. */
  @IsOptional() @IsInt() @Min(1) @Max(20) formVersion?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) startDate?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) hoursWeek?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) degreeLevel?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) website?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) commitment?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) priorExp?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  skills?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) skillGap?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) equitySplit?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) advisors?: string;
}

export class VentureIdeaInfoDto {
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) problem?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) proofFact?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) payerWho?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) userWho?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) beneficiaryWho?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) sector?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) city?: string;
  @IsOptional() @IsString() @MaxLength(200) pitch?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) customer?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  buyerModels?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) payerDiff?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  evidenceMethods?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) competitorType?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) whyUs?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) resistance?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) whyNow?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) customerSegment?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) frequency?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) severity?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) trigger?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) jtbd?: string;
  @IsOptional() @IsNumber() @Min(0) currentSpend?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) customerQuote?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) wtpEvidence?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) geography?: string;
  @IsOptional() @IsNumber() @Min(0) tam?: number;
  @IsOptional() @IsNumber() @Min(0) som?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) marketTrend?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) competitionLevel?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) positioning?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => VentureNamedRowDto)
  competitors?: VentureNamedRowDto[];
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
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) demoUrl?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  revenueModels?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  channels?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) numberSourceType?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) numberSourceNote?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;
  @IsOptional() @IsNumber() @Min(0) startupNeed?: number;
  @IsOptional() @IsNumber() @Min(0) monthlyRevenue?: number;
  @IsOptional() @IsNumber() @Min(0) cac?: number;
  @IsOptional() @IsNumber() @Min(0) ltv?: number;
  @IsOptional() @IsNumber() @Min(0) raised?: number;
  @IsOptional() @IsNumber() @Min(0) grossMargin?: number;
  @IsOptional() @IsNumber() @Min(0) burn?: number;
  @IsOptional() @IsNumber() @Min(0) runway?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) productStatus?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) features?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) ipStatus?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) moatType?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) techDependency?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) roadmap?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) deliveryModel?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) capacity?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) bottleneck?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) qualityControl?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) scalePlan?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) pricingStrategy?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) pricingTested?: string;
  @IsOptional() @IsNumber() @Min(0) purchaseFreq?: number;
  @IsOptional() @IsNumber() @Min(0) retentionYears?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) primaryChannel?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) salesMotion?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) salesCycle?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) referral?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) keyMessage?: string;
  @IsOptional() @IsNumber() @Min(0) mktBudget?: number;
  @IsOptional() @IsNumber() @Min(0) newCustMonth?: number;
  @IsOptional() @IsNumber() @Min(0) funnelReach?: number;
  @IsOptional() @IsNumber() @Min(0) funnelLeads?: number;
  @IsOptional() @IsNumber() @Min(0) funnelCust?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) brandAssets?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) partners?: string;
  @IsOptional() @IsNumber() @Min(0) fixedCosts?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) budgetPeriod?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) budgetStatus?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => VentureNamedRowDto)
  budgetLines?: VentureNamedRowDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => VentureNamedRowDto)
  fundSources?: VentureNamedRowDto[];
  @IsOptional() @IsNumber() @Min(0) cashOnHand?: number;
  @IsOptional() @IsNumber() @Min(0) monthlyCosts?: number;
  @IsOptional() @IsNumber() @Min(0) projCustM1?: number;
  @IsOptional() @IsNumber() @Min(0) projGrowth?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) paymentTerms?: string;
  @IsOptional() @IsNumber() @Min(0) revenueTarget12?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) profitMonth?: string;
  @IsOptional() @IsNumber() @Min(0) mrr?: number;
  @IsOptional() @IsNumber() @Min(0) gmv?: number;
  @IsOptional() @IsNumber() @Min(0) takeRate?: number;
  @IsOptional() @IsNumber() @Min(0) mau?: number;
  @IsOptional() @IsNumber() @Min(0) churn?: number;
  @IsOptional() @IsNumber() @Min(0) payingUsers?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) finAssumptions?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) accounting?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) raisePlan?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) askInstrument?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uofProduct?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uofOps?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uofMarketing?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uofTeam?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uofLegal?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uofContingency?: number;
}

export class VentureSdgEntryDto {
  @IsNumber() goalNumber: number;
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  targets: string[];
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

  @IsOptional() @IsIn(['map', 'review', 'none']) mode?:
    | 'map'
    | 'review'
    | 'none';
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) howImpact?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) helpImpact?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  responsibility?: string[];

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
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  openTo?: string[];
  @IsOptional() @IsNumber() @Min(0) mentorsConsulted?: number;
  @IsOptional() @IsNumber() @Min(0) competitionsJoined?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) risk?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) mitigation?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) assumption?: string;
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  regulatoryBarrier?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) reflection?: string;
  @IsOptional() @IsNumber() @Min(0) valuation?: number;
  @IsOptional() @IsNumber() @Min(0) equityPercent?: number;
  @IsOptional() @IsNumber() @Min(0) founderOwnership?: number;
  @IsOptional() @IsNumber() @Min(0) fundRunway?: number;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) exitStrategy?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => VentureNamedRowDto)
  riskRows?: VentureNamedRowDto[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) otherCommit?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) keyPerson?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) hiringNeed?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) paceScore?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(FREE_TEXT_MAX, { each: true })
  burnoutSigns?: string[];
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) burnoutPlan?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) plan90?: string;
  @IsOptional() @IsString() @MaxLength(FREE_TEXT_MAX) vision35?: string;
}

export class VentureReviewPipelineDto {
  @IsOptional() @IsBoolean() declarationWork?: boolean;
  @IsOptional() @IsBoolean() declarationConsent?: boolean;
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  studentDeclaredAt?: string;
  @IsOptional()
  @IsIn([
    'not_started',
    'pending',
    'approved',
    'revisions_requested',
    'rejected',
  ])
  supervisorStatus?:
    | 'not_started'
    | 'pending'
    | 'approved'
    | 'revisions_requested'
    | 'rejected';
  @IsOptional()
  @IsIn(['not_started', 'pending', 'approved'])
  universityStatus?: 'not_started' | 'pending' | 'approved';
  @IsOptional() @IsIn(['not_started', 'pending', 'approved']) sdgReviewStatus?:
    | 'not_started'
    | 'pending'
    | 'approved';
}

export class VenturePublishSettingsDto {
  @IsOptional()
  @IsIn(['private', 'university', 'partners', 'investors'])
  audience?: 'private' | 'university' | 'partners' | 'investors';
  @IsOptional() @IsBoolean() showName?: boolean;
  @IsOptional() @IsBoolean() showTeam?: boolean;
  @IsOptional() @IsBoolean() showUniversity?: boolean;
  @IsOptional() @IsBoolean() showTraction?: boolean;
  @IsOptional() @IsBoolean() showAsk?: boolean;
  @IsOptional() @IsBoolean() acceptIntros?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean;
}

export class VentureTeamConsentEntryDto {
  @IsString() @MaxLength(FREE_TEXT_MAX) name: string;
  @IsBoolean() consented: boolean;
}

export class VentureSectionSummariesDto {
  @IsOptional()
  @IsString()
  @MaxLength(SECTION_SUMMARY_MAX)
  opportunity?: string;
  @IsOptional() @IsString() @MaxLength(SECTION_SUMMARY_MAX) advantage?: string;
  @IsOptional() @IsString() @MaxLength(SECTION_SUMMARY_MAX) business?: string;
  @IsOptional() @IsString() @MaxLength(SECTION_SUMMARY_MAX) traction?: string;
  @IsOptional() @IsString() @MaxLength(SECTION_SUMMARY_MAX) impact?: string;
  @IsOptional() @IsString() @MaxLength(SECTION_SUMMARY_MAX) ask?: string;
  @IsOptional() @IsString() @MaxLength(SECTION_SUMMARY_MAX) founder?: string;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => VentureAcademicSetupDto)
  academicSetup?: VentureAcademicSetupDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => VentureIdeaInfoDto)
  ideaInfo?: VentureIdeaInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => VentureSolutionInfoDto)
  solutionInfo?: VentureSolutionInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => VentureSdgMappingDto)
  sdgMapping?: VentureSdgMappingDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => VentureEvidenceInfoDto)
  evidenceInfo?: VentureEvidenceInfoDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => VentureReviewPipelineDto)
  reviewPipeline?: VentureReviewPipelineDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => VenturePublishSettingsDto)
  publishSettings?: VenturePublishSettingsDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => VentureTeamConsentEntryDto)
  teamConsent?: VentureTeamConsentEntryDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => VentureSectionSummariesDto)
  sectionSummaries?: VentureSectionSummariesDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8)
  stepCompleted?: number;

  @IsOptional() @IsIn(['draft', 'submitted']) status?: 'draft' | 'submitted';
}

export class SupervisorReviewVentureDto {
  @IsIn(['approve', 'reject', 'revision'])
  action: 'approve' | 'reject' | 'revision';
  @IsOptional() @IsString() note?: string;
}

export class AddVentureDocumentDto extends VentureDocumentDto {}

export class SetVentureVisibilityDto {
  @IsBoolean()
  isVisible: boolean;
}

export class SetVentureSpotlightDto {
  @IsBoolean()
  featured: boolean;
}

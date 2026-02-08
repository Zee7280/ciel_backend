import { IsString, IsEmail, IsNotEmpty, MinLength, IsBoolean, IsOptional, IsNumber, IsIn, ValidateNested, IsArray, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { IsCNIC, IsPakistaniMobile } from '../../common/validators/custom-validators';

// Section 2: Team DTOs
export class TeamLeadDto {
    @IsNotEmpty()
    @IsString()
    @MinLength(3)
    name: string;

    @IsNotEmpty()
    @IsCNIC()
    cnic: string;

    @IsNotEmpty()
    @IsPakistaniMobile()
    mobile: string;

    @IsNotEmpty()
    @IsEmail()
    email: string;

    @IsNotEmpty()
    @IsString()
    university: string;

    @IsNotEmpty()
    @IsString()
    degree: string;

    @IsNotEmpty()
    @IsString()
    year: string;
}

export class TeamMemberDto {
    @IsNotEmpty()
    @IsString()
    @MinLength(3)
    name: string;

    @IsNotEmpty()
    @IsCNIC()
    cnic: string;

    @IsNotEmpty()
    @IsPakistaniMobile()
    mobile: string;

    @IsNotEmpty()
    @IsString()
    university: string;

    @IsNotEmpty()
    @IsString()
    program: string;

    @IsNotEmpty()
    @IsString()
    role: string;

    @IsNotEmpty()
    @IsNumber()
    hours: number;
}

export class Section2Dto {
    @IsNotEmpty()
    @IsIn(['individual', 'team'])
    participation_type: 'individual' | 'team';

    @ValidateNested()
    @Type(() => TeamLeadDto)
    team_lead: TeamLeadDto;

    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(19)
    @ValidateNested({ each: true })
    @Type(() => TeamMemberDto)
    team_members?: TeamMemberDto[];

    @IsBoolean()
    @IsNotEmpty()
    privacy_consent: boolean;
}

// Section 3: SDG Mapping DTOs
export class SecondarySDGDto {
    @IsNotEmpty()
    @IsString()
    sdg_id: string;

    @IsOptional()
    @IsString()
    target_id?: string;

    @IsOptional()
    @IsString()
    indicator_id?: string;

    @IsNotEmpty()
    @IsString()
    @MinLength(30)
    justification: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    evidence_files?: string[];
}

export class Section3Dto {
    @IsNotEmpty()
    @IsString()
    @MinLength(50)
    primary_sdg_explanation: string;

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => SecondarySDGDto)
    secondary_sdgs: SecondarySDGDto[];
}

// Section 4: Activities DTOs
export class Section4Dto {
    @IsNotEmpty()
    @IsString()
    @MinLength(100)
    activity_description: string;

    @IsNotEmpty()
    @IsIn(['yes', 'no'])
    has_financial_resources: 'yes' | 'no';

    @IsOptional()
    @IsNumber()
    personal_funds?: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    personal_funds_purpose?: string[];

    @IsOptional()
    @IsNumber()
    raised_funds?: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    raised_funds_source?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    evidence_files?: string[];
}

// Section 5: Outcomes DTOs
export class MetricDto {
    @IsNotEmpty()
    @IsString()
    metric: string;

    @IsNotEmpty()
    @IsString()
    baseline: string;

    @IsNotEmpty()
    @IsString()
    endline: string;

    @IsNotEmpty()
    @IsString()
    unit: string;
}

export class Section5Dto {
    @IsNotEmpty()
    @IsString()
    @MinLength(100)
    observed_change: string;

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => MetricDto)
    metrics: MetricDto[];
}

// Section 6: Resources DTOs
export class ResourceDto {
    @IsNotEmpty()
    @IsString()
    type: string;

    @IsNotEmpty()
    @IsString()
    amount: string;

    @IsNotEmpty()
    @IsString()
    source: string;

    @IsNotEmpty()
    @IsString()
    purpose: string;
}

export class Section6Dto {
    @IsNotEmpty()
    @IsIn(['yes', 'no'])
    used_resources: 'yes' | 'no';

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ResourceDto)
    resources?: ResourceDto[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    evidence_files?: string[];
}

// Section 7: Partnerships DTOs
export class PartnerDto {
    @IsNotEmpty()
    @IsString()
    name: string;

    @IsNotEmpty()
    @IsString()
    type: string;

    @IsNotEmpty()
    @IsString()
    role: string;

    @IsNotEmpty()
    @IsString()
    contribution: string;
}

export class Section7Dto {
    @IsNotEmpty()
    @IsIn(['yes', 'no'])
    has_partners: 'yes' | 'no';

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PartnerDto)
    partners?: PartnerDto[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    formalization?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    formalization_files?: string[];
}

// Section 8: Evidence DTOs
export class Section8Dto {
    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    evidence_types: string[];

    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    evidence_files: string[];

    @IsNotEmpty()
    @IsString()
    description: string;

    @IsNotEmpty()
    @IsIn(['public', 'limited', 'internal'])
    media_usage: 'public' | 'limited' | 'internal';

    @IsBoolean()
    @IsNotEmpty()
    consent_authentic: boolean;

    @IsBoolean()
    @IsNotEmpty()
    consent_informed: boolean;

    @IsBoolean()
    @IsNotEmpty()
    consent_no_harm: boolean;

    @IsBoolean()
    @IsNotEmpty()
    partner_verified: boolean;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    partner_verification_files?: string[];
}

// Section 10: Reflection DTOs
export class Section10Dto {
    @IsNotEmpty()
    @IsString()
    @MinLength(50)
    personal_learning: string;

    @IsNotEmpty()
    @IsIn(['yes', 'partially', 'no'])
    sustainability_status: 'yes' | 'partially' | 'no';

    @IsNotEmpty()
    @IsString()
    @MinLength(50)
    sustainability_plan: string;
}

// Section 12: Declaration DTOs
export class Section12Dto {
    @IsBoolean()
    @IsNotEmpty()
    student_declaration: boolean;

    @IsBoolean()
    @IsNotEmpty()
    partner_verification: boolean;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    partner_verification_files?: string[];
}

// Main Create Report DTO
export class CreateStudentReportDto {
    @IsNotEmpty()
    @IsString()
    project_id: string;

    @IsOptional()
    @IsString()
    opportunityId?: string;

    // Section 1: Context
    @IsOptional()
    @IsString()
    @MinLength(50)
    'section1.problem_statement'?: string;

    // Section 2: Team
    @IsOptional()
    @ValidateNested()
    @Type(() => Section2Dto)
    section2?: Section2Dto;

    // Section 3: SDG Mapping
    @IsOptional()
    @ValidateNested()
    @Type(() => Section3Dto)
    section3?: Section3Dto;

    // Section 4: Activities
    @IsOptional()
    @ValidateNested()
    @Type(() => Section4Dto)
    section4?: Section4Dto;

    // Section 5: Outcomes
    @IsOptional()
    @ValidateNested()
    @Type(() => Section5Dto)
    section5?: Section5Dto;

    // Section 6: Resources
    @IsOptional()
    @ValidateNested()
    @Type(() => Section6Dto)
    section6?: Section6Dto;

    // Section 7: Partnerships
    @IsOptional()
    @ValidateNested()
    @Type(() => Section7Dto)
    section7?: Section7Dto;

    // Section 8: Evidence
    @IsOptional()
    @ValidateNested()
    @Type(() => Section8Dto)
    section8?: Section8Dto;

    // Section 10: Reflection
    @IsOptional()
    @ValidateNested()
    @Type(() => Section10Dto)
    section10?: Section10Dto;

    // Section 12: Declaration
    @IsOptional()
    @ValidateNested()
    @Type(() => Section12Dto)
    section12?: Section12Dto;
}

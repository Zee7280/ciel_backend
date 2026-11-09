import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { FOLLOW_UP_CHOICES } from '../entities/follow-up-answer.entity';

export class FollowUpAnswerDto {
  @IsUUID()
  questionId: string;

  @IsIn([...FOLLOW_UP_CHOICES])
  choice: (typeof FOLLOW_UP_CHOICES)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  numericValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Body of POST /public/followups/:token/response — the partner's explicit confirmation. */
export class SubmitFollowUpResponseDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  representativeName: string;

  /** "I confirm these answers reflect what I can observe" — must be ticked. */
  @IsBoolean()
  @Equals(true, { message: 'Please confirm your answers before submitting.' })
  consent: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  generalComment?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => FollowUpAnswerDto)
  answers: FollowUpAnswerDto[];
}

export class DeclineFollowUpDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Also stop every future CIEL PK follow-up email to this address (global opt-out). */
  @IsOptional()
  @IsBoolean()
  optOut?: boolean;
}

/**
 * Body of POST /admin/reports/:id/followup/activate. Empty for a report whose student planned the
 * check (9.5 = Yes). With recipient fields, CIEL PK decides the follow-up itself (9.5 = "Not
 * decided yet", or a recipient that bounced / opted out and must be replaced).
 */
export class AdminActivateFollowUpDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  recipientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  recipientRole?: string;

  /** yyyy-mm-dd; defaults to the student's due date or today. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  dueDate?: string;
}

/**
 * Body of POST /students/followups/preview: the wizard's current (possibly unsaved) Section 4 / 5
 * / 10 answers, so the student sees on 9.5 what the partner will be asked and when. Stateless.
 */
export class FollowUpPreviewDto {
  @IsOptional()
  @IsObject()
  section4?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  section5?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  section10?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  projectTitle?: string;

  /** yyyy-mm-dd from the opportunity, as the wizard reads it. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  projectEndDate?: string;
}

export class AdminFollowUpListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4)
  limit?: string;
}

export class AdminFollowUpQuestionDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(600)
  questionText: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  activityTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  countLabel?: string;

  @IsOptional()
  @IsBoolean()
  include?: boolean;
}

/** Body of PATCH /admin/reports/:id/followup/questions — the full reviewed list. */
export class AdminFollowUpQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AdminFollowUpQuestionDto)
  questions: AdminFollowUpQuestionDto[];
}

export class AdminFollowUpActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

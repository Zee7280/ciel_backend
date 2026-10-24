import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  QUICK_WORK_EVIDENCE_TYPES,
  QUICK_WORK_MAX_EVIDENCE,
  QUICK_WORK_MAX_EVIDENCE_BYTES,
  QUICK_WORK_MAX_PARTICIPANTS,
  QUICK_WORK_REVIEW_NOTE_MAX,
  QUICK_WORK_SUMMARY_MAX,
  QUICK_WORK_VISIBILITY,
} from '../quick-work.util';

export class QuickWorkTeammateDto {
  @IsString()
  @MaxLength(120)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  studentId?: string;
}

export class QuickWorkAttendanceDto {
  @IsString()
  @MaxLength(120)
  email: string;

  @IsBoolean()
  present: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  startTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  endTime?: string | null;

  @IsInt()
  @Min(0)
  @Max(24 * 60)
  breakMinutes: number;
}

export class QuickWorkEvidenceDto {
  @IsString()
  @MaxLength(1000)
  url: string;

  @IsString()
  @MaxLength(200)
  name: string;

  @IsIn([...QUICK_WORK_EVIDENCE_TYPES])
  type: string;

  @IsInt()
  @Min(1)
  @Max(QUICK_WORK_MAX_EVIDENCE_BYTES)
  size: number;

  @IsString()
  @MaxLength(160)
  caption: string;
}

/** Draft save: every field optional, so each step can save what it has. Submit checks completeness. */
export class SaveQuickWorkLogDto {
  @IsOptional()
  @IsIn(['solo', 'team'])
  mode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  university?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  leadStudentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  facultyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  facultyEmail?: string;

  /** The full teammate list (excluding you). Omit to leave the team unchanged. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QUICK_WORK_MAX_PARTICIPANTS - 1)
  @ValidateNested({ each: true })
  @Type(() => QuickWorkTeammateDto)
  teammates?: QuickWorkTeammateDto[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  activityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  activityDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  startTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  endTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  host?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(17)
  sdg?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QUICK_WORK_MAX_PARTICIPANTS)
  @ValidateNested({ each: true })
  @Type(() => QuickWorkAttendanceDto)
  attendance?: QuickWorkAttendanceDto[];

  @IsOptional()
  @IsString()
  @MaxLength(QUICK_WORK_SUMMARY_MAX)
  summary?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  peopleReached?: number | null;

  @IsOptional()
  @IsIn([...QUICK_WORK_VISIBILITY])
  visibility?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QUICK_WORK_MAX_EVIDENCE)
  @ValidateNested({ each: true })
  @Type(() => QuickWorkEvidenceDto)
  evidence?: QuickWorkEvidenceDto[];

  @IsOptional()
  @IsBoolean()
  consent?: boolean;

  @IsOptional()
  @IsBoolean()
  honest?: boolean;
}

export class QuickWorkJoinDto {
  @IsBoolean()
  accept: boolean;
}

export class QuickWorkReviewDto {
  @IsIn(['approve', 'changes', 'reject'])
  action: 'approve' | 'changes' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(QUICK_WORK_REVIEW_NOTE_MAX)
  note?: string;

  @IsOptional()
  @IsBoolean()
  verified?: boolean;
}

export class QuickWorkPresignDto {
  @IsString()
  @MaxLength(200)
  filename: string;

  @IsString()
  @MaxLength(100)
  contentType: string;

  @IsInt()
  @Min(1)
  size: number;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Admin list / export filters; every field optional. */
export class AdminQuickWorkListQuery {
  @IsOptional()
  @IsIn(['draft', 'submitted', 'changes', 'approved', 'rejected'])
  status?: 'draft' | 'submitted' | 'changes' | 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  university?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Matches(YMD, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @IsOptional()
  @Matches(YMD, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminQuickWorkReassignDto {
  @IsString()
  @MaxLength(100)
  facultyName: string;

  @IsString()
  @MaxLength(120)
  facultyEmail: string;

  @IsOptional()
  @IsString()
  @MaxLength(QUICK_WORK_REVIEW_NOTE_MAX)
  note?: string;
}

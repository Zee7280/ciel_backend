import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class CourseProjectStudentInfoDto {
    @IsOptional() @IsString() studentName?: string;
    @IsOptional() @IsString() rollNumber?: string;
    @IsOptional() @IsString() universityName?: string;
    @IsOptional() @IsString() disciplineName?: string;
    @IsOptional() @IsString() semester?: string;
    @IsOptional() @IsString() teamMode?: string;
    @IsOptional() @IsArray() groupMembers?: string[];
    @IsOptional() @IsString() teacherName?: string;
    @IsOptional() @IsString() teacherEmail?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectAssignmentInfoDto {
    @IsOptional() @IsString() format?: string;
    @IsOptional() @IsString() formatOther?: string;
    @IsOptional() @IsString() whatAsked?: string;
    @IsOptional() @IsString() realWorldIssue?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectAimsInfoDto {
    @IsOptional() @IsString() aimStatement?: string;
    @IsOptional() @IsArray() objectives?: string[];
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectProcessInfoDto {
    @IsOptional() @IsArray() activities?: string[];
    @IsOptional() @IsString() activitiesOther?: string;
    @IsOptional() @IsArray() methods?: string[];
    @IsOptional() @IsString() methodsOther?: string;
    @IsOptional() @IsString() sampleScale?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectResultsInfoDto {
    @IsOptional() @IsArray() outputs?: string[];
    @IsOptional() @IsString() outputsOther?: string;
    @IsOptional() @IsString() outputDescription?: string;
    @IsOptional() @IsArray() findings?: string[];
    @IsOptional() @IsString() measurableImpact?: string;
    @IsOptional() @IsString() limitationType?: string;
    @IsOptional() @IsString() limitationOther?: string;
    @IsOptional() @IsString() limitationDetail?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectSdgEntryDto {
    @IsInt() goalNumber: number;
    @IsArray() targets: string[];
    @IsOptional() @IsString() how?: string;
}

export class CourseProjectSdgMappingDto {
    @IsOptional() @IsString() origin?: string;
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CourseProjectSdgEntryDto)
    entries?: CourseProjectSdgEntryDto[];
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectReflectionInfoDto {
    @IsOptional() @IsString() lessonLearned?: string;
    @IsOptional() @IsString() sdgLinkHonesty?: string;
    @IsOptional() @IsArray() skills?: string[];
    @IsOptional() @IsString() skillsOther?: string;
    @IsOptional() @IsString() whatsNext?: string;
    @IsOptional() @IsString() adviceNextSemester?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectModuleInclusionDto {
    @IsOptional() @IsBoolean() aim?: boolean;
    @IsOptional() @IsBoolean() act?: boolean;
    @IsOptional() @IsBoolean() meth?: boolean;
    @IsOptional() @IsBoolean() find?: boolean;
    @IsOptional() @IsBoolean() imp?: boolean;
    @IsOptional() @IsBoolean() lim?: boolean;
}

export class CourseProjectSectionSummariesDto {
    @IsOptional() @IsString() course?: string;
    @IsOptional() @IsString() assignment?: string;
    @IsOptional() @IsString() aims?: string;
    @IsOptional() @IsString() process?: string;
    @IsOptional() @IsString() results?: string;
    @IsOptional() @IsString() sdg?: string;
    @IsOptional() @IsString() reflection?: string;
}

export class UpdateCourseProjectDto {
    // Legacy fields (kept for backward compatibility)
    @IsOptional()
    @IsString()
    course?: string;

    @IsOptional()
    @IsString()
    projectTitle?: string;

    @IsOptional()
    @IsString()
    projectDescription?: string;

    @IsOptional()
    @IsArray()
    sdgs?: number[];

    @IsOptional()
    @IsArray()
    evidenceUrls?: string[];

    // Step-grouped fields
    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectStudentInfoDto)
    studentInfo?: CourseProjectStudentInfoDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectAssignmentInfoDto)
    assignmentInfo?: CourseProjectAssignmentInfoDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectAimsInfoDto)
    aimsInfo?: CourseProjectAimsInfoDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectProcessInfoDto)
    processInfo?: CourseProjectProcessInfoDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectResultsInfoDto)
    resultsInfo?: CourseProjectResultsInfoDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectSdgMappingDto)
    sdgMapping?: CourseProjectSdgMappingDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectReflectionInfoDto)
    reflectionInfo?: CourseProjectReflectionInfoDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectModuleInclusionDto)
    moduleInclusion?: CourseProjectModuleInclusionDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CourseProjectSectionSummariesDto)
    sectionSummaries?: CourseProjectSectionSummariesDto;

    @IsOptional()
    @IsString()
    addedNote?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(8)
    stepCompleted?: number;

    @IsOptional()
    @IsIn(['draft', 'submitted'])
    status?: 'draft' | 'submitted';
}

import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class FacultyReviewCourseProjectDto {
    @IsIn(['approve', 'reject'])
    action: 'approve' | 'reject';
    @IsOptional() @IsString() note?: string;
}

export class CourseProjectStudentInfoDto {
    @IsOptional() @IsString() studentName?: string;
    @IsOptional() @IsString() rollNumber?: string;
    @IsOptional() @IsString() studentEmail?: string;
    @IsOptional() @IsString() universityName?: string;
    @IsOptional() @IsString() disciplineName?: string;
    @IsOptional() @IsString() department?: string;
    @IsOptional() @IsString() programme?: string;
    @IsOptional() @IsString() courseCode?: string;
    @IsOptional() @IsString() semester?: string;
    @IsOptional() @IsString() teamMode?: string;
    /** {name, email?} per member going forward — kept loosely typed since older clients may still send plain strings. */
    @IsOptional() @IsArray() groupMembers?: unknown[];
    @IsOptional() @IsArray() courseworkTypes?: string[];
    @IsOptional() @IsString() courseworkTypeOther?: string;
    /** @deprecated pre-multi-select shape */
    @IsOptional() @IsString() courseworkType?: string;
    @IsOptional() @IsString() teacherName?: string;
    @IsOptional() @IsString() teacherEmail?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectAssignmentInfoDto {
    @IsOptional() @IsString() format?: string;
    @IsOptional() @IsString() formatOther?: string;
    @IsOptional() @IsArray() formats?: string[];
    @IsOptional() @IsString() leadRoute?: string;
    @IsOptional() @IsString() whatAsked?: string;
    @IsOptional() @IsString() realWorldIssue?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectAimsInfoDto {
    @IsOptional() @IsString() aimStatement?: string;
    @IsOptional() @IsArray() objectives?: string[];
    @IsOptional() @IsArray() beneficiaries?: string[];
    @IsOptional() @IsString() beneficiariesOther?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectProcessInfoDto {
    @IsOptional() @IsArray() activities?: string[];
    @IsOptional() @IsString() activitiesOther?: string;
    @IsOptional() @IsArray() methods?: string[];
    @IsOptional() @IsString() methodsOther?: string;
    @IsOptional() @IsString() sampleScale?: string;
    @IsOptional() @IsArray() stakeholders?: string[];
    @IsOptional() @IsString() stakeholdersOther?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectMetricDto {
    @IsString() id: string;
    @IsOptional() @IsString() name?: string;
    @IsOptional() @IsString() type?: string;
    @IsOptional() @IsString() typeOther?: string;
    @IsOptional() @IsString() value?: string;
    @IsOptional() @IsString() unit?: string;
    @IsOptional() @IsString() unitOther?: string;
    @IsOptional() @IsString() status?: string;
    @IsOptional() @IsString() meaning?: string;
    @IsOptional() @IsString() sample?: string;
    @IsOptional() @IsString() periodFrom?: string;
    @IsOptional() @IsString() periodTo?: string;
    @IsOptional() @IsString() source?: string;
    @IsOptional() @IsString() sourceOther?: string;
    @IsOptional() @IsString() character?: string;
    @IsOptional() @IsString() verifier?: string;
    @IsOptional() @IsString() verifierOther?: string;
    @IsOptional() @IsBoolean() comparedBeforeAfter?: boolean;
    @IsOptional() @IsString() baseline?: string;
    @IsOptional() @IsBoolean() evidenceAttached?: boolean;
}

export class CourseProjectResultsInfoDto {
    @IsOptional() @IsArray() outputs?: string[];
    @IsOptional() @IsString() outputsOther?: string;
    @IsOptional() @IsString() outputDescription?: string;
    @IsOptional() @IsArray() findings?: string[];
    @IsOptional() @IsString() measured?: string;
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CourseProjectMetricDto)
    metrics?: CourseProjectMetricDto[];
    @IsOptional() @IsString() measurableImpact?: string;
    @IsOptional() @IsString() limitationType?: string;
    @IsOptional() @IsString() limitationOther?: string;
    @IsOptional() @IsString() limitationDetail?: string;
    @IsOptional() @IsString() limitationInterpretation?: string;
    @IsOptional() @IsArray() recommendations?: string[];
    @IsOptional() @IsString() resultsSummary?: string;
    @IsOptional() @IsString() notes?: string;
    /** @deprecated pre-multi-metric shape — still accepted for entries submitted before this system existed. */
    @IsOptional() @IsString() evidenceStatus?: string;
    @IsOptional() @IsString() metricName?: string;
    @IsOptional() @IsString() metricValue?: string;
    @IsOptional() @IsString() metricUnit?: string;
    @IsOptional() @IsString() numberRepresents?: string;
}

export class CourseProjectSdgEntryDto {
    @IsInt() goalNumber: number;
    @IsArray() targets: string[];
    @IsOptional() @IsString() how?: string;
    @IsOptional() @IsString() strength?: string;
}

export class CourseProjectSdgMappingDto {
    @IsOptional() @IsString() origin?: string;
    @IsOptional() @IsBoolean() notApplicable?: boolean;
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
    @IsOptional() @IsString() integrationLevel?: string;
    @IsOptional() @IsArray() skills?: string[];
    @IsOptional() @IsString() skillsOther?: string;
    @IsOptional() @IsString() nextSteps?: string;
    @IsOptional() @IsString() nextStepsOther?: string;
    @IsOptional() @IsString() whatsNext?: string;
    @IsOptional() @IsString() adviceNextSemester?: string;
    @IsOptional() @IsString() notes?: string;
}

export class CourseProjectModuleInclusionDto {
    @IsOptional() @IsBoolean() aim?: boolean;
    @IsOptional() @IsBoolean() act?: boolean;
    @IsOptional() @IsBoolean() meth?: boolean;
    @IsOptional() @IsBoolean() find?: boolean;
    /** @deprecated see res */
    @IsOptional() @IsBoolean() imp?: boolean;
    @IsOptional() @IsBoolean() res?: boolean;
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

    @IsOptional()
    @IsArray()
    evidenceTypes?: string[];

    @IsOptional()
    @IsString()
    assignmentFileUrl?: string;

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

import { IsIn, IsOptional, IsString } from 'class-validator';

export class FacultyReportActionDto {
    @IsIn(['approved', 'rejected', 'revision_requested'])
    status: 'approved' | 'rejected' | 'revision_requested';

    @IsOptional()
    @IsString()
    remarks?: string;

    /** Additive. Folded into faculty_remarks. Existing remarks-only clients stay valid. */
    @IsOptional()
    @IsString()
    revision_section?: string;

    @IsOptional()
    @IsString()
    required_correction?: string;
}

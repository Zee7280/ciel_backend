import { IsIn, IsOptional, IsString } from 'class-validator';

export class FacultyReportActionDto {
    @IsIn(['approved', 'rejected', 'revision_requested'])
    status: 'approved' | 'rejected' | 'revision_requested';

    @IsOptional()
    @IsString()
    remarks?: string;
}

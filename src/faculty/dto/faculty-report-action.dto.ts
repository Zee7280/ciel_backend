import { IsIn, IsOptional, IsString } from 'class-validator';

export class FacultyReportActionDto {
    @IsIn(['approved', 'rejected'])
    status: 'approved' | 'rejected';

    @IsOptional()
    @IsString()
    remarks?: string;
}

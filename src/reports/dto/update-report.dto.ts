import { PartialType } from '@nestjs/mapped-types';
import { CreateReportDto } from './create-report.dto';
import { IsOptional, IsString } from 'class-validator';

export class UpdateReportDto extends PartialType(CreateReportDto) {
    @IsOptional()
    @IsString()
    status?: string;
}

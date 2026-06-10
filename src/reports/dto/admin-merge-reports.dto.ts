import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class AdminMergeReportsDto {
    @IsArray()
    @ArrayMinSize(2)
    @IsUUID('4', { each: true })
    report_ids: string[];

    /** Survivor row — other selected reports are removed after shallow field merge. */
    @IsUUID('4')
    keep_report_id: string;
}

import { IsBoolean } from 'class-validator';

export class SetAttendanceEditableDto {
    @IsBoolean()
    editable: boolean;
}

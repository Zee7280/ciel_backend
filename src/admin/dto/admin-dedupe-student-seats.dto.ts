import { IsUUID } from 'class-validator';

export class AdminDedupeStudentSeatsDto {
    @IsUUID()
    student_user_id: string;
}

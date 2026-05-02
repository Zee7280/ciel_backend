import { IsUUID } from 'class-validator';

export class AssignFacultyUniversityScopeDto {
    @IsUUID()
    facultyUserId: string;

    @IsUUID()
    universityOrganizationId: string;
}

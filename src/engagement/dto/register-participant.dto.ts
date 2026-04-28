import { IsString, IsEnum, IsBoolean, IsUUID, IsEmail, Length, IsOptional } from 'class-validator';

export class RegisterParticipantDto {
    @IsUUID()
    projectId: string;

    @IsEnum(['individual', 'team'])
    participationMode: string;

    @IsBoolean()
    isTeamLead: boolean;

    @IsString()
    fullName: string;

    @IsString()
    @Length(13, 13)
    cnic: string;

    @IsString()
    mobile: string;

    @IsEmail()
    email: string;

    @IsString()
    universityId: string;

    @IsString()
    universityName: string;

    @IsString()
    academicProgram: string;

    @IsEnum(['1st Year', '2nd Year', '3rd Year', '4th Year', 'Graduate', 'Postgraduate'])
    yearOfStudy: string;

    @IsString()
    department: string;

    @IsEnum(['Voluntary', 'Course-Linked', 'Credit-Bearing', 'Capstone / Thesis', 'Research-Integrated'])
    academicIntegrationType: string;

    @IsEmail()
    @IsOptional()
    primaryFacultyEmail?: string;

    @IsEmail()
    @IsOptional()
    primary_faculty_email?: string;

    @IsEmail()
    @IsOptional()
    secondaryFacultyEmail?: string;

    @IsEmail()
    @IsOptional()
    secondary_faculty_email?: string;

    @IsUUID()
    @IsOptional()
    studentId?: string;
}

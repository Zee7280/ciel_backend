import { IsString, IsEmail, IsOptional, IsEnum } from 'class-validator';
import { UserRole } from '../enums/user-role.enum';

export class CreateUserDto {
    @IsString()
    name: string;

    @IsEmail()
    email: string;

    @IsString()
    password: string;

    @IsOptional()
    @IsString()
    institution?: string;

    @IsOptional()
    @IsString()
    university?: string;

    @IsOptional()
    @IsString()
    department?: string;

    @IsOptional()
    @IsString()
    faculty_department?: string;

    @IsOptional()
    @IsString()
    enrollmentYear?: string;

    /** Optional student ID / roll number, stored on the existing `registrationNumber` column. */
    @IsOptional()
    @IsString()
    registrationNumber?: string;

    @IsOptional()
    @IsString()
    orgName?: string;

    @IsOptional()
    @IsString()
    orgType?: string;

    @IsOptional()
    @IsString()
    organizationCategory?: string;

    @IsOptional()
    @IsString()
    legalRegistrationType?: string;

    @IsOptional()
    @IsString()
    contactPerson?: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsString()
    cnic?: string;

    @IsOptional()
    @IsString()
    countryCode?: string;

    @IsEnum(UserRole)
    role: UserRole;

    @IsOptional()
    @IsString()
    status?: string;

    organization?: any;
}

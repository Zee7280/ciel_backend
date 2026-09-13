import { IsString, IsEmail, IsOptional, IsEnum, MinLength, ValidateIf } from 'class-validator';
import { UserRole } from '../enums/user-role.enum';

const isStudentOrFaculty = (o: CreateUserDto) => o.role === UserRole.STUDENT || o.role === UserRole.FACULTY;
/** Every public-signup role collects phone + city; only an admin-created SUPER_ADMIN account
 * (via POST admin/users, which shares this DTO) is exempt. */
const isPublicSignupRole = (o: CreateUserDto) => o.role !== UserRole.SUPER_ADMIN;

export class CreateUserDto {
    @IsString()
    name: string;

    @IsEmail()
    email: string;

    @IsString()
    @MinLength(8, { message: 'Password must be at least 8 characters long.' })
    password: string;

    @ValidateIf(isStudentOrFaculty)
    @IsString()
    @MinLength(1, { message: 'Institution is required' })
    institution?: string;

    @IsOptional()
    @IsString()
    university?: string;

    @ValidateIf(isStudentOrFaculty)
    @IsString()
    @MinLength(1, { message: 'Department is required' })
    department?: string;

    @IsOptional()
    @IsString()
    faculty_department?: string;

    @ValidateIf(isPublicSignupRole)
    @IsString()
    @MinLength(1, { message: 'City is required' })
    city?: string;

    @ValidateIf((o: CreateUserDto) => o.role === UserRole.STUDENT)
    @IsString()
    @MinLength(1, { message: 'Enrollment year is required' })
    enrollmentYear?: string;

    /** Optional student ID / faculty-employee ID, stored on the existing `registrationNumber` column. */
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

    @ValidateIf(isPublicSignupRole)
    @IsString()
    @MinLength(10, { message: 'Phone number must be at least 10 digits' })
    phone?: string;

    @IsOptional()
    @IsString()
    cnic?: string;

    @IsOptional()
    @IsString()
    countryCode?: string;

    /** Public verification link or uploaded-proof URL from institution signup. Not stored on the user. */
    @IsOptional()
    @IsString()
    affiliationProofUrl?: string;

    @IsOptional()
    @IsString()
    affiliationProofKind?: string;

    @IsOptional()
    @IsString()
    affiliationProofLabel?: string;

    @IsEnum(UserRole)
    role: UserRole;

    @IsOptional()
    @IsString()
    status?: string;

    organization?: any;
}

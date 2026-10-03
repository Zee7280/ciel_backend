import { Transform, Type } from 'class-transformer';
import { IsString, IsEmail, IsOptional, IsEnum, MinLength, ValidateIf, IsArray, ValidateNested, IsNotEmpty, Matches } from 'class-validator';
import { IsAcceptablePassword } from '../../auth/password-policy.util';

/** Trim surrounding whitespace so "  " can never satisfy a required text field. */
const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
import { UserRole } from '../enums/user-role.enum';

/** Mandate / KYC extras for Investor / VC signup — stored on `users.settings.investor`. */
export class InvestorSignupProfileDto {
    @IsOptional() @IsString() linkedin?: string;
    @IsOptional() @IsString() website?: string;
    @IsOptional() @IsString() investorType?: string;
    @IsOptional() @IsString() country?: string;
    @IsOptional() @IsString() hearAbout?: string;
    @IsOptional() @IsString() referralCode?: string;
    @IsOptional() @IsArray() @IsString({ each: true }) preferredRounds?: string[];
    @IsOptional() @IsArray() @IsString({ each: true }) preferredStages?: string[];
    @IsOptional() @IsArray() @IsString({ each: true }) sectors?: string[];
    @IsOptional() @IsString() typicalTicket?: string;
    @IsOptional() @IsString() geographicFocus?: string;
    @IsOptional() @IsString() dealsPerYear?: string;
    @IsOptional() @IsString() decisionTimeline?: string;
    @IsOptional() @IsString() leadFollow?: string;
    @IsOptional() @IsString() sdgInterests?: string;
    @IsOptional() @IsString() valueAdd?: string;
    @IsOptional() @IsString() plan?: string;
    @IsOptional() @IsString() professionalReference?: string;
    @IsOptional() @IsString() proofOrgLabel?: string;
    @IsOptional() @IsString() proofRoleLabel?: string;
}

const isStudentOrFaculty = (o: CreateUserDto) => o.role === UserRole.STUDENT || o.role === UserRole.FACULTY;
/** Every public-signup role collects phone + city; only an admin-created SUPER_ADMIN account
 * (via POST admin/users, which shares this DTO) is exempt. */
const isPublicSignupRole = (o: CreateUserDto) => o.role !== UserRole.SUPER_ADMIN;

export class CreateUserDto {
    @Transform(trimString)
    @IsString()
    @IsNotEmpty({ message: 'Name is required' })
    name: string;

    @Transform(trimString)
    @IsEmail()
    email: string;

    @IsString()
    @IsAcceptablePassword()
    password: string;

    @ValidateIf(isStudentOrFaculty)
    @Transform(trimString)
    @IsString()
    @IsNotEmpty({ message: 'Institution is required' })
    institution?: string;

    @IsOptional()
    @IsString()
    university?: string;

    @ValidateIf(isStudentOrFaculty)
    @Transform(trimString)
    @IsString()
    @IsNotEmpty({ message: 'Department is required' })
    department?: string;

    @IsOptional()
    @IsString()
    faculty_department?: string;

    @ValidateIf(isPublicSignupRole)
    @Transform(trimString)
    @IsString()
    @IsNotEmpty({ message: 'City is required' })
    city?: string;

    @ValidateIf((o: CreateUserDto) => o.role === UserRole.STUDENT)
    @Transform(trimString)
    @IsString()
    @IsNotEmpty({ message: 'Enrollment year is required' })
    enrollmentYear?: string;

    /** Optional student ID / faculty-employee ID, stored on the existing `registrationNumber` column. */
    @IsOptional()
    @Transform(trimString)
    @IsString()
    @Matches(/^[\w\-/. ]{0,40}$/, { message: 'Student / employee ID may only contain letters, numbers, spaces and - / . _ (max 40).' })
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

    @IsOptional()
    @ValidateNested()
    @Type(() => InvestorSignupProfileDto)
    investorProfile?: InvestorSignupProfileDto;

    @IsEnum(UserRole)
    role: UserRole;

    @IsOptional()
    @IsString()
    status?: string;

    organization?: any;
}

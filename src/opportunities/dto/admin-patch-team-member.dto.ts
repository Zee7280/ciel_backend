import { IsCNIC } from '../../common/validators/custom-validators';
import { IsOptional, IsString, Length, Matches, IsEnum, MaxLength } from 'class-validator';

const YEAR_OPTS = ['1st Year', '2nd Year', '3rd Year', '4th Year', 'Graduate', 'Postgraduate'] as const;
const ACADEMIC_INTEGRATION_OPTS = [
    'Voluntary',
    'Course-Linked',
    'Credit-Bearing',
    'Capstone / Thesis',
    'Research-Integrated',
] as const;

export type YearOfStudyOption = (typeof YEAR_OPTS)[number];
export type AcademicIntegrationTypeOption = (typeof ACADEMIC_INTEGRATION_OPTS)[number];

export class AdminPatchTeamMemberDto {
    /** Seat / profile display name for this enrollment */
    @IsOptional()
    @IsString()
    @Length(1, 320)
    full_name?: string;

    /**
     * Mobile as stored on the participation seat (typically full national number digits or local Pakistani format).
     * Kept permissive so admins can correct international numbers (+92…) or stored legacy shapes.
     */
    @IsOptional()
    @IsString()
    @Length(6, 40)
    @Matches(/^[\d+\-\s().]+$/, { message: 'Phone may only contain digits and + - spaces ( ) .' })
    mobile?: string;

    @IsOptional()
    @IsCNIC()
    cnic?: string;

    @IsOptional()
    @IsString()
    @MaxLength(512)
    university_id?: string;

    @IsOptional()
    @IsString()
    @MaxLength(512)
    university_name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(512)
    academic_program?: string;

    @IsOptional()
    @IsString()
    @MaxLength(320)
    department?: string;

    @IsOptional()
    @IsEnum(YEAR_OPTS)
    year_of_study?: YearOfStudyOption;

    @IsOptional()
    @IsEnum(ACADEMIC_INTEGRATION_OPTS)
    academic_integration_type?: AcademicIntegrationTypeOption;

    /** When true, patched fields are mirrored onto the linked `users` row (student account). Defaults true. */
    @IsOptional()
    sync_linked_user_profile?: boolean;
}

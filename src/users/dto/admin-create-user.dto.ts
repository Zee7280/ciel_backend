import { Transform } from 'class-transformer';
import { IsString, IsEmail, IsOptional, IsEnum, MinLength } from 'class-validator';
import { normalizeUserRoleInput } from '../user-role-input.util';
import { UserRole } from '../enums/user-role.enum';
import { IsAcceptablePassword } from '../../auth/password-policy.util';

/**
 * Relaxed DTO for POST admin/users. Unlike CreateUserDto (public signup) it does not
 * force city/phone/institution/department/enrollmentYear — admins create accounts for any role.
 */
export class AdminCreateUserDto {
    @IsString()
    @MinLength(1, { message: 'Name is required' })
    name: string;

    @IsEmail()
    email: string;

    /** Same policy as public signup and admin edit (PATCH shares CreateUserDto) — "12345678" must not pass here either. */
    @IsString()
    @IsAcceptablePassword()
    password: string;

    @Transform(({ value }) => normalizeUserRoleInput(value))
    @IsEnum(UserRole)
    role: UserRole;

    @IsOptional() @IsString() status?: string;
    @IsOptional() @IsString() city?: string;
    @IsOptional() @IsString() phone?: string;
    @IsOptional() @IsString() institution?: string;
    @IsOptional() @IsString() department?: string;
    @IsOptional() @IsString() enrollmentYear?: string;
}

import { IsString, IsEmail, IsOptional, IsEnum, MinLength } from 'class-validator';
import { UserRole } from '../enums/user-role.enum';

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

    @IsString()
    @MinLength(8, { message: 'Password must be at least 8 characters long.' })
    password: string;

    @IsEnum(UserRole)
    role: UserRole;

    @IsOptional() @IsString() status?: string;
    @IsOptional() @IsString() city?: string;
    @IsOptional() @IsString() phone?: string;
    @IsOptional() @IsString() institution?: string;
    @IsOptional() @IsString() department?: string;
    @IsOptional() @IsString() enrollmentYear?: string;
}

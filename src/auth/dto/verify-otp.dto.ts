import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class VerifyOtpDto {
    @IsEmail()
    email: string;

    @Transform(({ value }) => (value !== undefined && value !== null ? String(value).trim() : value))
    @IsString()
    @Length(6, 6)
    @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' })
    otp: string;
}

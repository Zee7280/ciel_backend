import { IsString } from 'class-validator';
import { IsAcceptablePassword } from '../password-policy.util';

export class ResetPasswordDto {
    @IsString()
    token: string;

    @IsString()
    @IsAcceptablePassword()
    newPassword: string;
}

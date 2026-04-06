import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class SendContactDto {
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name: string;

    @IsEmail()
    @MaxLength(320)
    email: string;

    @IsString()
    @MinLength(1)
    @MaxLength(200)
    subject: string;

    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    message: string;
}

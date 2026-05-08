import {
    ArrayMinSize,
    IsArray,
    IsEmail,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';

export class AdminSendEmailDto {
    @IsArray()
    @ArrayMinSize(1)
    @IsEmail({}, { each: true })
    to!: string[];

    @IsString()
    @MinLength(1)
    @MaxLength(160)
    subject!: string;

    @IsString()
    @MinLength(1)
    @MaxLength(20_000)
    messageHtml!: string;

    @IsOptional()
    @IsString()
    @MaxLength(20_000)
    messageText?: string;
}


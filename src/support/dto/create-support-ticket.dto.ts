import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSupportTicketDto {
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    category: string;

    @IsString()
    @MinLength(1)
    @MaxLength(240)
    subject: string;

    @IsString()
    @MinLength(1)
    @MaxLength(20000)
    description: string;
}

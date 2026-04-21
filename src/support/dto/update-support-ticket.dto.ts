import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Admin PATCH body — only provided fields are updated. */
export class UpdateSupportTicketDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(50)
    status?: string;
}

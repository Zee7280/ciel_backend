import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const SUPPORT_TICKET_STATUSES = [
    'open',
    'in_progress',
    'pending',
    'resolved',
    'closed',
] as const;

/** Admin PATCH body — only provided fields are updated. */
export class UpdateSupportTicketDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(50)
    @IsIn(SUPPORT_TICKET_STATUSES as unknown as string[])
    status?: string;

    /** Visible to the student; triggers an in-app notification. */
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    adminReply?: string;

    /** Staff-only. */
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    internalNote?: string;
}

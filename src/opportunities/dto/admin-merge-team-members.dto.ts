import { ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class AdminMergeTeamMembersDto {
    /** Participation row UUIDs (enrolled members only — not pending:… synthetic ids). */
    @IsArray()
    @ArrayMinSize(2)
    @IsUUID('4', { each: true })
    member_participation_ids: string[];

    /** Must be one of member_participation_ids — becomes the sole team lead. */
    @IsUUID('4')
    lead_participation_id: string;

    /** Existing team slug to keep; omit to reuse a member's teamId or generate TM-YYYY-…. */
    @IsOptional()
    @IsString()
    @MaxLength(128)
    target_team_id?: string;

    @IsOptional()
    @IsBoolean()
    reassign_draft_report_to_lead?: boolean;

    @IsOptional()
    @IsBoolean()
    delete_non_lead_draft_reports?: boolean;
}

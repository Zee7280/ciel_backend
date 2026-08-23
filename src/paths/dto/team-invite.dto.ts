import { IsEmail, IsIn, IsString } from 'class-validator';
import type { TeamMemberInviteKind } from '../entities/team-member-invite.entity';

export class ResendTeamInviteDto {
    @IsIn(['course_project', 'fyp', 'venture'])
    kind: TeamMemberInviteKind;

    @IsString()
    entryId: string;

    @IsEmail()
    email: string;
}

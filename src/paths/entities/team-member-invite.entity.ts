import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type TeamMemberInviteKind = 'course_project' | 'fyp' | 'venture';
/** 'revoked' — the named email was edited/removed before acceptance; the row (and its token) is
 * kept for history but can never be accepted, and a fresh invite is issued for the corrected
 * email instead of reusing this one. See PathsService.syncTeamInvites. */
export type TeamMemberInviteStatus = 'pending' | 'accepted' | 'revoked';

/** A real, verifiable link between a report/record (Course Project, FYP, Venture) and a named
 * team member's email — the teammate must click the emailed token link while signed in with the
 * exact matching account email before the report becomes visible on their own dashboard. Replaces
 * the old approach of trusting whatever email string the report owner typed. */
@Entity('team_member_invites')
export class TeamMemberInvite {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column()
    kind: TeamMemberInviteKind;

    @Index()
    @Column()
    entryId: string;

    @Index()
    @Column()
    email: string; // lowercased/trimmed

    @Index({ unique: true })
    @Column()
    token: string;

    @Column({ default: 'pending' })
    status: TeamMemberInviteStatus;

    @Column()
    invitedByUserId: string;

    @Column({ type: 'varchar', nullable: true })
    acceptedByUserId: string | null;

    @Column({ type: 'timestamp' })
    expiresAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    acceptedAt: Date | null;

    /** Set when a still-pending invite is revoked because the owner edited/removed the named
     * email — never set on an already-accepted invite. */
    @Column({ type: 'timestamp', nullable: true })
    revokedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}

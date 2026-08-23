import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type TeamMemberInviteKind = 'course_project' | 'fyp' | 'venture';
export type TeamMemberInviteStatus = 'pending' | 'accepted';

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

    @Column({ nullable: true })
    acceptedByUserId: string | null;

    @Column({ type: 'timestamp' })
    expiresAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    acceptedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}

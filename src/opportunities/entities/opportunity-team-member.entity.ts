import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { OpportunityParticipant } from './opportunity-participant.entity';

@Entity('opportunity_team_members')
export class OpportunityTeamMember {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ nullable: true })
    cnic: string;

    @Column({ nullable: true })
    mobile: string;

    @Column({ nullable: true })
    email: string;

    @Column({ nullable: true })
    university: string;

    @Column({ nullable: true })
    program: string;

    @Column({ nullable: true })
    role: string;

    @Column({ default: false })
    is_verified: boolean;

    @ManyToOne(() => OpportunityParticipant, (participant) => participant.teamMembers, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'participantId' })
    participant: OpportunityParticipant;

    @Column({ nullable: true })
    participantId: string;
}

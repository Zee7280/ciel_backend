import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Opportunity } from './opportunity.entity';
import { OpportunityTeamMember } from './opportunity-team-member.entity';

@Entity('opportunity_participants')
export class OpportunityParticipant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    participation_type: string; // 'individual' | 'team'

    @Column({ default: 'pending' })
    status: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'studentId' })
    student: User;

    @Column({ nullable: true })
    studentId: string;

    @ManyToOne(() => Opportunity)
    @JoinColumn({ name: 'opportunityId' })
    opportunity: Opportunity;

    @Column({ nullable: true })
    opportunityId: string;

    @OneToMany(() => OpportunityTeamMember, (member) => member.participant)
    teamMembers: OpportunityTeamMember[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

@Entity('reports')
export class Report {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    title: string;

    @Column({ type: 'text', nullable: true })
    description: string;

    @Column({ nullable: true })
    evidenceUrl: string;

    @Column({ nullable: true })
    evidenceType: string;

    @Column({ default: 'pending' })
    status: string;

    @Column({ nullable: true })
    rejectionReason: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'studentId' })
    student: User;

    @Column({ nullable: true })
    studentId: string;

    @ManyToOne(() => Opportunity, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'opportunityId' })
    opportunity: Opportunity;

    @Column({ nullable: true })
    opportunityId: string;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: 'organizationId' })
    organization: Organization;

    @Column({ nullable: true })
    organizationId: string;

    @Column({ nullable: true })
    subject: string;

    @Column({ nullable: true })
    type: string; // Content, User, etc.

    @Column({ nullable: true })
    severity: string; // low, medium, high

    @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'reporterId' })
    reporter: User;

    @Column({ nullable: true })
    reporterId: string;

    // Partner Report Fields
    @Column({ type: 'int', nullable: true })
    beneficiaries: number;

    @Column({ type: 'int', nullable: true })
    hoursLogged: number;

    @Column({ type: 'simple-array', nullable: true })
    sdgs: number[];

    @Column({ type: 'simple-array', nullable: true })
    evidence: string[];

    @Column({ type: 'timestamp', nullable: true })
    submittedDate: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

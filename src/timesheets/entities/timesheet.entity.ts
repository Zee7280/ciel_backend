import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

@Entity('timesheets')
export class Timesheet {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('float')
    hours: number;

    @Column({ nullable: true })
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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

export enum PaymentStatus {
    PENDING = 'pending',
    APPROVED = 'approved',
    REJECTED = 'rejected',
}

@Entity('payments')
export class Payment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Opportunity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'project_id' })
    opportunity: Opportunity;

    @Column({ name: 'project_id' })
    projectId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'student_id' })
    student: User;

    @Column({ name: 'student_id' })
    studentId: string;

    @Column({ default: '5,000 PKR' })
    amount: string;

    /** Amount the student paid (PKR), from submit body; legacy rows may be null. */
    @Column({ type: 'int', nullable: true })
    paid_amount: number | null;

    @Column({ type: 'text' })
    proof_url: string;

    @Column({
        type: 'enum',
        enum: PaymentStatus,
        default: PaymentStatus.PENDING,
    })
    status: PaymentStatus;

    @Column({ type: 'text', nullable: true })
    feedback: string | null;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;
}

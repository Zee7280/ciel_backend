import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Participation } from './participant.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';
import { ATTENDANCE_DESCRIPTION_MAX_CHARS } from '../attendance-description.constants';

@Entity('attendance_logs')
export class AttendanceLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Participation, (participation) => participation.attendanceLogs, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'participantId' })
    participant: Participation;

    @Column()
    participantId: string;

    @ManyToOne(() => Opportunity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'projectId' })
    project: Opportunity;

    @Column()
    projectId: string;

    @Column({ type: 'date' })
    dateOfEngagement: string;

    @Column({ type: 'time' })
    startTime: string;

    @Column({ type: 'time' })
    endTime: string;

    @Column({ type: 'decimal', precision: 4, scale: 2 })
    sessionHours: number;

    @Column()
    organizationName: string;

    @Column()
    activityType: string;

    @Column({ type: 'varchar', length: ATTENDANCE_DESCRIPTION_MAX_CHARS })
    description: string;

    @Column({ default: false })
    evidenceUploaded: boolean;

    @Column({ type: 'varchar', nullable: true })
    evidenceUrl: string;

    @Column({
        type: 'enum',
        enum: ['pending', 'verified', 'flagged'],
        default: 'pending'
    })
    entryStatus: string;

    /** New workflow: null = legacy row (treat as pre-workflow). pending | approved | rejected | flagged */
    @Column({ type: 'varchar', length: 32, nullable: true })
    approvalStatus: string | null;

    /** Server-assigned queue: faculty-only attendance approval gate. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    assignedApproverType: string | null;

    /** Preferred: mapped faculty user id from participation faculty emails. */
    @Column({ type: 'uuid', nullable: true })
    assignedApproverUserId: string | null;

    /** Audit marker for approval route origin. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    opportunityCreatorKind: string | null;

    @Column({ type: 'text', nullable: true })
    approvalActionReason: string | null;

    @Column({ type: 'uuid', nullable: true })
    approvalActorUserId: string | null;

    @Column({ type: 'timestamp', nullable: true })
    approvalActionAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

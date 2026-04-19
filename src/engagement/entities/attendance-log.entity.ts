import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Participation } from './participant.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

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

    @Column({ type: 'varchar', length: 300 })
    description: string; // Validated for max 40 words in service

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

    /** Server-assigned queue: partner (opportunity creator) or CIEL admin pool. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    assignedApproverType: string | null;

    /** When assignedApproverType is partner, matches opportunity.creatorId unless reassigned later. */
    @Column({ type: 'uuid', nullable: true })
    assignedApproverUserId: string | null;

    /** NGO vs corporate vs faculty/student host — audit / UI. */
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

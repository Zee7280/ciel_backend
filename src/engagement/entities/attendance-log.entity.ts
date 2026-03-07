import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Participant } from './participant.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

@Entity('attendance_logs')
export class AttendanceLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Participant, (participant) => participant.attendanceLogs, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'participantId' })
    participant: Participant;

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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

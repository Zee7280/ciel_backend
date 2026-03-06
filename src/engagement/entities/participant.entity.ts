import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';
import { AttendanceLog } from './attendance-log.entity';

@Entity('participants')
export class Participant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Opportunity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'projectId' })
    project: Opportunity;

    @Column()
    projectId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column()
    userId: string;

    @Column({
        type: 'enum',
        enum: ['individual', 'team'],
        default: 'individual'
    })
    participationMode: string;

    @Column({ default: false })
    isTeamLead: boolean;

    @Column()
    fullName: string;

    @Column({ unique: true })
    cnicHash: string; // SHA-256 hash for duplicate checking

    @Column({ nullable: true })
    cnic: string; // AES-256 encrypted CNIC

    @Column()
    cnicLast4: string; // For searching/displaying last 4 digits

    @Column()
    mobile: string;

    @Column({ default: false })
    mobileVerified: boolean;

    @Column()
    email: string;

    @Column({ default: false })
    emailVerified: boolean;

    @Column()
    universityId: string;

    @Column()
    universityName: string;

    @Column()
    academicProgram: string;

    @Column({
        type: 'enum',
        enum: ['1st Year', '2nd Year', '3rd Year', '4th Year', 'Graduate', 'Postgraduate']
    })
    yearOfStudy: string;

    @Column()
    department: string;

    @Column({
        type: 'enum',
        enum: ['Voluntary', 'Course-Linked', 'Credit-Bearing', 'Capstone / Thesis', 'Research-Integrated']
    })
    academicIntegrationType: string;

    @Column({
        type: 'enum',
        enum: ['draft', 'submitted', 'verified', 'finalized'],
        default: 'draft'
    })
    status: string;

    @Column({ type: 'float', nullable: true })
    eisScore: number;

    @Column({ nullable: true })
    hecStatus: string;

    @Column({ type: 'timestamp', nullable: true })
    finalizedAt: Date;

    @OneToMany(() => AttendanceLog, (log) => log.participant)
    attendanceLogs: AttendanceLog[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';
import { AttendanceLog } from './attendance-log.entity';

@Entity('participations')
export class Participation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Opportunity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'project_id' })
    project: Opportunity;

    @Column({ name: 'project_id' })
    projectId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'student_id' })
    student: User;

    @Column({ name: 'student_id', nullable: true })
    studentId: string;

    @Column({ nullable: true })
    facultySupervisorEmail: string;

    @Column({ nullable: true })
    primaryFacultyEmail: string;

    @Column({ nullable: true })
    secondaryFacultyEmail: string;

    @Column({ nullable: true })
    teamId: string;

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

    @Column({ nullable: true })
    cnicHash: string; // SHA-256 hash for duplicate checking

    @Column({ nullable: true })
    cnic: string; // AES-256 encrypted CNIC

    @Column({ nullable: true })
    cnicLast4: string; // For searching/displaying last 4 digits

    @Column()
    mobile: string;

    @Column({ default: false })
    mobileVerified: boolean;

    @Column()
    email: string;

    @Column({ default: false })
    emailVerified: boolean;

    @Column({ nullable: true })
    universityId: string;

    @Column({ nullable: true })
    universityName: string;

    @Column({ nullable: true })
    academicProgram: string;

    @Column({
        type: 'enum',
        enum: ['1st Year', '2nd Year', '3rd Year', '4th Year', 'Graduate', 'Postgraduate'],
        nullable: true
    })
    yearOfStudy: string;

    @Column({ nullable: true })
    department: string;

    @Column({
        type: 'enum',
        enum: ['Voluntary', 'Course-Linked', 'Credit-Bearing', 'Capstone / Thesis', 'Research-Integrated'],
        nullable: true
    })
    academicIntegrationType: string;

    @Column({
        type: 'enum',
        enum: ['pending', 'pending_payment_approval', 'paid', 'pending_ciel_approval', 'pending_faculty_approval', 'approved', 'rejected', 'finalized', 'verified', 'accepted'],
        default: 'pending'
    })
    status: string;

    @Column({
        type: 'enum',
        enum: ['pending', 'pending_payment_approval', 'paid', 'rejected'],
        default: 'pending'
    })
    paymentStatus: string;

    @Column({ nullable: true })
    paymentProofUrl: string;

    @Column({ type: 'timestamp', nullable: true })
    paymentDate: Date;

    @Column({ type: 'float', nullable: true })
    eisScore: number;

    @Column({ nullable: true })
    hecStatus: string;

    @Column({ type: 'timestamp', nullable: true })
    finalizedAt: Date;

    @OneToMany(() => AttendanceLog, (log) => log.participant)
    attendanceLogs: AttendanceLog[];

    @Column({ nullable: true })
    applicationId: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

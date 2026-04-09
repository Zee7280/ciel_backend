import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { Organization } from '../../organizations/entities/organization.entity';
import { UserRole } from '../enums/user-role.enum';

@Entity('users')
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;

    @Column({ nullable: true })
    institution: string;

    @Column({ nullable: true })
    department: string;

    @Column({ nullable: true })
    faculty_department: string;

    @Column({ nullable: true })
    orgName: string;

    @Column({ nullable: true })
    orgType: string;

    @Column({ nullable: true })
    contactPerson: string;

    @Column({
        type: 'text', // Keeping as text/string for checking if enum constraint is strictly needed in DB, usually string is fine
        default: UserRole.STUDENT
    })
    role: UserRole;

    @Column({ default: 'active' })
    status: string;

    // Student Profile Fields
    @Column({ nullable: true })
    cnic: string;

    @Column({ nullable: true })
    countryCode: string;

    @Column({ nullable: true })
    phone: string;

    @Column({ nullable: true })
    avatar: string;

    @Column({ nullable: true })
    university: string;

    @Column({ nullable: true })
    registrationNumber: string;

    @Column({ nullable: true })
    major: string;

    @Column({ nullable: true })
    city: string;

    @Column({ type: 'text', nullable: true })
    bio: string;

    @Column({ type: 'simple-array', nullable: true })
    interests: string[];

    @Column({ type: 'simple-array', nullable: true })
    sdgPreferences: number[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @ManyToOne(() => Organization, (organization) => organization.users, { nullable: true, onDelete: 'CASCADE' })
    organization: Organization;

    @Column({ type: 'json', nullable: true })
    settings: any;

    @Column({ nullable: true })
    passwordResetToken: string;

    @Column({ nullable: true })
    passwordResetExpiry: Date;

    @Column({ default: false })
    requires_cnic: boolean;

    @Column({ default: false })
    requires_profile_verification: boolean;

    @Column({ default: false })
    profile_verified: boolean;

    @Column({ default: false })
    identity_verified: boolean;
}

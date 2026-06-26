import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

@Entity('organizations')
export class Organization {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column()
    orgType: string; // NGO, CORPORATE, UNIVERSITY

    /** Detailed sector (e.g. Healthcare Organization). Role bucket stays in `orgType`. */
    @Column({ nullable: true })
    organizationCategory: string;

    @Column({ nullable: true })
    legalRegistrationType: string;

    @Column({ type: 'text', nullable: true })
    description: string;

    @Column({ nullable: true })
    city: string;

    @Column({ nullable: true })
    region: string;

    @Column({ nullable: true }) // Added address field
    address: string;

    @Column({ default: 'Pakistan' })
    country: string;

    @Column({ default: 'PK' })
    countryCode: string;

    @Column({ nullable: true })
    websiteUrl: string;

    @Column({ nullable: true })
    logoUrl: string;

    @Column({ nullable: true })
    contactName: string;

    @Column({ nullable: true })
    contactEmail: string;

    @Column({ nullable: true })
    contactPhone: string;

    @Column({ default: 'PENDING' })
    verificationStatus: string; // PENDING, APPROVED, REJECTED

    @Column({ default: 'LOCAL' })
    verificationScope: string;

    @Column({ nullable: true })
    verifiedBy: string; // uuid of admin

    @Column({ nullable: true })
    verifiedAt: Date;

    @Column({ type: 'text', nullable: true })
    verificationNotes: string;

    @Column({ default: false })
    worksWithMinors: boolean;

    @Column({ default: false })
    safeguardingAcknowledged: boolean;

    @Column({ default: false })
    dataPolicyAcknowledged: boolean;

    @Column({ default: false })
    isBlocked: boolean; // For blocking organization

    @OneToMany(() => User, (user) => user.organization, { cascade: true, onDelete: 'CASCADE' })
    users: User[];

    @OneToMany(() => Opportunity, (opportunity) => opportunity.organization, { cascade: true, onDelete: 'CASCADE' })
    opportunities: Opportunity[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}


import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { FundingOpportunity } from './funding-opportunity.entity';
import { Organization } from '../../organizations/entities/organization.entity';

@Entity('funding_applications')
export class FundingApplication {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    fundingId: number;

    @ManyToOne(() => FundingOpportunity)
    @JoinColumn({ name: 'fundingId' })
    fundingOpportunity: FundingOpportunity;

    @Column()
    organizationId: string;

    @ManyToOne(() => Organization) // Assuming Organization entity exists and is imported correctly
    @JoinColumn({ name: 'organizationId' })
    organization: Organization;

    @Column('decimal', { precision: 10, scale: 2 })
    proposedBudget: number;

    @Column('text')
    projectDescription: string;

    @Column('int')
    expectedBeneficiaries: number;

    @Column('simple-array', { nullable: true })
    documents: string[];

    @Column({ default: 'pending' })
    status: string; // pending, approved, rejected

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

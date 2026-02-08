
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('funding_opportunities')
export class FundingOpportunity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    title: string;

    @Column('decimal', { precision: 10, scale: 2 })
    amount: number;

    @Column()
    deadline: Date;

    @Column()
    eligibility: string;

    @Column({ default: 'open' })
    status: string; // open, closed

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

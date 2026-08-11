import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export interface VentureTractionRow {
    date: string;
    metric: string;
    value: string;
    note?: string;
}

export interface VentureTeamMember {
    name: string;
    role: string;
    email?: string;
}

/** One record per student — Startup / Business path: venture profile, traction, team, materials, visibility. */
@Entity('venture_entries')
export class VentureEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column()
    userId: string;

    @Column({ nullable: true })
    ventureName: string;

    @Column({ type: 'text', nullable: true })
    description: string;

    @Column({ nullable: true })
    stage: string;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    tractionRows: VentureTractionRow[];

    @Column({ type: 'jsonb', default: () => "'[]'" })
    team: VentureTeamMember[];

    @Column({ type: 'simple-array', nullable: true })
    materialUrls: string[];

    @Column({ default: false })
    isVisible: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

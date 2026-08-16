import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export interface FypMilestone {
    label: string;
    status: 'pending' | 'in_progress' | 'complete';
    dueDate?: string | null;
    completedAt?: string | null;
}

export interface FypDeliverable {
    version: number;
    label: string;
    fileUrl: string;
    uploadedAt: string;
}

export interface FypCommunityLinkage {
    orgName?: string;
    contactName?: string;
    contactEmail?: string;
    description?: string;
}

export const DEFAULT_FYP_MILESTONES: FypMilestone[] = [
    { label: 'Proposal approved', status: 'pending', dueDate: null, completedAt: null },
    { label: 'Literature / groundwork review', status: 'pending', dueDate: null, completedAt: null },
    { label: 'Midpoint evaluation', status: 'pending', dueDate: null, completedAt: null },
    { label: 'Final implementation', status: 'pending', dueDate: null, completedAt: null },
    { label: 'Defense / submission', status: 'pending', dueDate: null, completedAt: null },
];

/** One record per student — FYP / Thesis path: overview, 5-node milestone timeline, versioned deliverables, community linkage. */
@Entity('fyp_entries')
export class FypEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** One FYP/Thesis record per student (unlike Course Project's multi-entry deck) — enforced at the DB level so a race between two saves can never create a duplicate row that silently shadows the other. */
    @Index({ unique: true })
    @Column()
    userId: string;

    @Column({ nullable: true })
    projectTitle: string;

    @Column({ type: 'text', nullable: true })
    overview: string;

    @Column({ type: 'jsonb', default: () => `'${JSON.stringify(DEFAULT_FYP_MILESTONES)}'` })
    milestones: FypMilestone[];

    @Column({ type: 'jsonb', default: () => "'[]'" })
    deliverables: FypDeliverable[];

    @Column({ type: 'jsonb', nullable: true })
    communityLinkage: FypCommunityLinkage | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

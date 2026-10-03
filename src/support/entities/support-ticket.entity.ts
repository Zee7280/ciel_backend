import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    DeleteDateColumn,
} from 'typeorm';

@Entity('support_tickets')
export class SupportTicket {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    reference: string;

    @Column('uuid')
    studentUserId: string;

    @Column()
    category: string;

    @Column()
    subject: string;

    @Column({ type: 'text' })
    description: string;

    @Column({ default: 'open' })
    status: string;

    /** Reply shown to the student (additive). */
    @Column({ type: 'text', nullable: true })
    adminReply?: string | null;

    @Column({ type: 'timestamptz', nullable: true })
    adminReplyAt?: Date | null;

    /** Staff-only note; never returned to the student (additive). */
    @Column({ type: 'text', nullable: true })
    internalNote?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @DeleteDateColumn({ type: 'timestamptz' })
    deletedAt?: Date | null;
}

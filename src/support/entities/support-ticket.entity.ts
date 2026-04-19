import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

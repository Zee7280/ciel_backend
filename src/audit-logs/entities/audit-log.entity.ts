import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    action: string;

    @Column({ nullable: true })
    user: string; // Storing name or ID directly for simplicity in logs

    @Column({ nullable: true })
    target: string;

    @Column({ nullable: true })
    ip: string;

    @Column({ nullable: true })
    user_email: string;

    @Column({ nullable: true })
    target_type: string;

    @Column('simple-json', { nullable: true })
    details: any;

    @CreateDateColumn()
    created_at: Date;
}

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('otps')
export class Otp {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    email: string;

    @Column()
    otp: string;

    @Column()
    expiresAt: Date;

    /** Opportunity the code was requested for; one row per (email, project). Null for legacy rows. */
    @Column({ type: 'varchar', nullable: true })
    projectId: string | null;

    /** Set when the code was confirmed. Apply / seat registration accept the email only while this is recent. */
    @Column({ type: 'timestamp', nullable: true })
    verifiedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}

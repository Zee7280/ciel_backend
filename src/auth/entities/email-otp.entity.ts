import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

@Entity('email_otps')
@Index(['email'])
export class EmailOtp {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    email: string;

    /** Legacy rows: verify with bcrypt. New rows: plain code for debugging/support (nullable when only hash exists). */
    @Column({ type: 'varchar', length: 16, nullable: true })
    otp: string | null;

    @Column({ nullable: true })
    otpHash: string | null;

    @Column({ type: 'timestamptz' })
    expiresAt: Date;

    @Column({ default: false })
    verified: boolean;

    @CreateDateColumn()
    createdAt: Date;
}

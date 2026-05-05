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

    /** bcrypt hash ($2b$…); explicit DB type avoids TypeORM inferring "Object" for string | null. */
    @Column({ type: 'varchar', length: 72, nullable: true })
    otpHash: string | null;

    @Column({ type: 'timestamptz' })
    expiresAt: Date;

    @Column({ default: false })
    verified: boolean;

    @CreateDateColumn()
    createdAt: Date;
}

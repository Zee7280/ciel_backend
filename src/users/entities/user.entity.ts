import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  Index,
} from 'typeorm';
import { Organization } from '../../organizations/entities/organization.entity';
import { UserRole } from '../enums/user-role.enum';

@Entity('users')
// One identity-provider subject may be linked to at most one account (duplicate-identity guard).
@Index('UQ_users_sso_identity', ['ssoIssuer', 'ssoSubject'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  @Column()
  password: string;

  /** Admin-recoverable encrypted password copy. Login hash stays in `password`. */
  @Column({
    name: 'password_record',
    type: 'text',
    nullable: true,
    select: false,
  })
  passwordRecord: string | null;

  @Column({ nullable: true })
  institution: string;

  @Column({ nullable: true })
  department: string;

  @Column({ nullable: true })
  enrollmentYear: string;

  @Column({ nullable: true })
  faculty_department: string;

  @Column({ nullable: true })
  orgName: string;

  @Column({ nullable: true })
  orgType: string;

  @Column({ nullable: true })
  contactPerson: string;

  @Column({
    type: 'text', // Keeping as text/string for checking if enum constraint is strictly needed in DB, usually string is fine
    default: UserRole.STUDENT,
  })
  role: UserRole;

  @Column({ default: 'active' })
  status: string;

  // Student Profile Fields
  @Column({ nullable: true })
  cnic: string;

  @Column({ nullable: true })
  countryCode: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true })
  avatar: string;

  @Column({ nullable: true })
  university: string;

  /**
   * Faculty only: the university CIEL PK admin set on this profile (Admin → Users). A faculty account
   * may approve Quick Community Impact for that university's students without a university scope,
   * as long as its profile still names it. Null until an admin sets it. Nullable ADD COLUMN only.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  universityConfirmedByAdmin: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  universityConfirmedAt: Date | null;

  @Column({ nullable: true })
  registrationNumber: string;

  @Column({ nullable: true })
  major: string;

  @Column({ nullable: true })
  city: string;

  @Column({ type: 'text', nullable: true })
  bio: string;

  @Column({ type: 'simple-array', nullable: true })
  interests: string[];

  @Column({ type: 'simple-array', nullable: true })
  sdgPreferences: number[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, (organization) => organization.users, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  organization: Organization;

  @Column({ type: 'json', nullable: true })
  settings: any;

  @Column({ nullable: true })
  passwordResetToken: string;

  @Column({ nullable: true })
  passwordResetExpiry: Date;

  /** Bumped on password change so existing JWTs are rejected (e.g. after reset on another device). */
  @Column({ type: 'int', default: 0 })
  tokenVersion: number;

  /** When the user accepted the Terms & Privacy Policy at signup (null for legacy accounts). */
  @Column({ type: 'timestamptz', nullable: true })
  termsAcceptedAt: Date | null;

  @Column({ default: false })
  requires_cnic: boolean;

  @Column({ default: false })
  requires_profile_verification: boolean;

  @Column({ default: false })
  profile_verified: boolean;

  @Column({ default: false })
  identity_verified: boolean;

  /** OpenID Connect issuer of the University SSO identity linked to this account (null: none). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  ssoIssuer: string | null;

  /** The provider's stable subject id for that identity; stays valid if the email changes. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  ssoSubject: string | null;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * The canonical identity of a university on CIEL PK. Every university-facing view used to decide
 * membership by fuzzy-matching free-text names; a row here gives each university one stable id and
 * one short, immutable `code` that is printed into every public record id (CIEL-BNU-2026-0421).
 */
@Entity('universities')
export class University {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Upper-case 2–10 char code used in record ids. Never changes once any id has been issued. */
  @Index('UQ_universities_code', { unique: true })
  @Column({ type: 'varchar', length: 10 })
  code: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Other spellings that must resolve to this university (typed names, old names). */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  aliases: string[];

  /** The onboarded university organisation (account) for this university, once there is one. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;
}

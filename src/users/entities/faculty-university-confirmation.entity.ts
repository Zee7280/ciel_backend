import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The university CIEL PK admin set on a faculty member's profile (Admin → Users). A faculty account may
 * approve Quick Community Impact for that university's students without a university scope, while its
 * profile still names the university.
 *
 * Kept in its own table on purpose: `users` is read on every authenticated request, and adding columns
 * to it in production must never be needed for this feature. No foreign key to `users` either (creating
 * one would lock `users`). Nothing on the sign-in path reads this table, and every reader tolerates it
 * being missing.
 */
@Entity('faculty_university_confirmations')
export class FacultyUniversityConfirmation {
  @PrimaryColumn({ type: 'uuid' })
  facultyUserId: string;

  @Column({ type: 'varchar', length: 200 })
  university: string;

  @Column({ type: 'uuid' })
  confirmedByUserId: string;

  @Column({ type: 'timestamptz' })
  confirmedAt: Date;
}

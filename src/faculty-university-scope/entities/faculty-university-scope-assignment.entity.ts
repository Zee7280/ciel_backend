import {
    Entity,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Organization } from '../../organizations/entities/organization.entity';

/** Admin-granted scope: independent faculty may view/act on activity for students matched to a university org. */
@Entity('faculty_university_scope_assignments')
@Index(['facultyUser'], { unique: true })
export class FacultyUniversityScopeAssignment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'faculty_user_id' })
    facultyUser: User;

    @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'university_organization_id' })
    universityOrganization: Organization;

    @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'assigned_by_admin_id' })
    assignedByAdmin: User | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import { FacultyUniversityScopeAssignment } from './entities/faculty-university-scope-assignment.entity';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';

@Injectable()
export class FacultyUniversityScopeService {
    constructor(
        @InjectRepository(FacultyUniversityScopeAssignment)
        private readonly assignmentRepo: Repository<FacultyUniversityScopeAssignment>,
        @InjectRepository(User)
        private readonly usersRepo: Repository<User>,
        @InjectRepository(Organization)
        private readonly orgRepo: Repository<Organization>,
        @InjectRepository(Participation)
        private readonly participationRepo: Repository<Participation>,
        @InjectRepository(OpportunityApplication)
        private readonly applicationRepo: Repository<OpportunityApplication>,
        @InjectRepository(Opportunity)
        private readonly opportunityRepo: Repository<Opportunity>,
    ) {}

    isUniversityOrganization(org: Organization): boolean {
        return String(org.orgType || '')
            .trim()
            .toLowerCase()
            .includes('university');
    }

    normalizeOrgName(name: string): string {
        return (name || '').trim().toLowerCase();
    }

    async getAssignmentForFaculty(facultyUserId: string): Promise<FacultyUniversityScopeAssignment | null> {
        return this.assignmentRepo.findOne({
            where: { facultyUser: { id: facultyUserId } },
            relations: ['universityOrganization', 'facultyUser'],
        });
    }

    async getDelegatedOrganizationId(facultyUserId: string): Promise<string | null> {
        const row = await this.assignmentRepo.findOne({
            where: { facultyUser: { id: facultyUserId } },
            select: { id: true },
            relations: ['universityOrganization'],
        });
        return row?.universityOrganization?.id ?? null;
    }

    /** Students whose profile university/institution string matches the organization name (normalized). */
    studentProfileMatchesOrganization(student: User | null | undefined, orgNameNorm: string): boolean {
        if (!student || student.role !== UserRole.STUDENT || !orgNameNorm) return false;
        const u = this.normalizeOrgName(student.university || '');
        const i = this.normalizeOrgName(student.institution || '');
        return u === orgNameNorm || i === orgNameNorm;
    }

    /**
     * Opportunity IDs faculty should see when delegated to a university org — aligned with
     * {@link OrganizationsService.getUniversityAnalytics} linkage rules (not only student profile strings).
     */
    async resolveOpportunityIdsForUniversityOrganization(universityOrganizationId: string): Promise<string[]> {
        const org = await this.orgRepo.findOne({ where: { id: universityOrganizationId } });
        if (!org) return [];
        const n = this.normalizeOrgName(org.name);

        const fromParticipations = await this.participationRepo
            .createQueryBuilder('p')
            .innerJoin('p.student', 'u')
            .select('DISTINCT p.projectId', 'id')
            .where('u.role = :sr', { sr: UserRole.STUDENT })
            .andWhere(
                '(LOWER(TRIM(COALESCE(u.university, \'\'))) = :n OR LOWER(TRIM(COALESCE(u.institution, \'\'))) = :n)',
                { n },
            )
            .getRawMany();

        const fromParticipationsStudentOrg = await this.participationRepo
            .createQueryBuilder('p')
            .innerJoin('p.student', 'u')
            .select('DISTINCT p.projectId', 'id')
            .where('u.role = :sr', { sr: UserRole.STUDENT })
            .andWhere('u."organizationId"::text = :orgId', { orgId: universityOrganizationId })
            .getRawMany();

        /** Enrollment snapshot fields often carry institution text / occasional UUID; profile may differ or be empty. */
        const fromEnrollmentOnParticipation = await this.participationRepo
            .createQueryBuilder('p')
            .select('DISTINCT p.projectId', 'id')
            .where('p.student_id IS NOT NULL')
            .andWhere(
                new Brackets((b) => {
                    b.where(`TRIM(COALESCE(p.universityId, '')) = :orgId`, {
                        orgId: universityOrganizationId,
                    })
                        .orWhere(`LOWER(TRIM(COALESCE(p.universityName, ''))) = :n`, { n })
                        .orWhere(`LOWER(TRIM(COALESCE(p.universityId, ''))) = :n`, { n });
                }),
            )
            .getRawMany();

        const fromApps = await this.applicationRepo
            .createQueryBuilder('a')
            .innerJoin('a.studentUser', 'u')
            .select('DISTINCT a.opportunityId', 'id')
            .where('u.role = :sr', { sr: UserRole.STUDENT })
            .andWhere('a.withdrawnAt IS NULL')
            .andWhere(
                '(LOWER(TRIM(COALESCE(u.university, \'\'))) = :n OR LOWER(TRIM(COALESCE(u.institution, \'\'))) = :n)',
                { n },
            )
            .getRawMany();

        const fromAppsStudentOrg = await this.applicationRepo
            .createQueryBuilder('a')
            .innerJoin('a.studentUser', 'u')
            .select('DISTINCT a.opportunityId', 'id')
            .where('u.role = :sr', { sr: UserRole.STUDENT })
            .andWhere('a.withdrawnAt IS NULL')
            .andWhere('u."organizationId"::text = :orgId', { orgId: universityOrganizationId })
            .getRawMany();

        const fromCreators = await this.opportunityRepo
            .createQueryBuilder('o')
            .innerJoin(User, 'u', 'u.id::text = o."creatorId"::text')
            .select('DISTINCT o.id', 'id')
            .where('u.role = :sr', { sr: UserRole.STUDENT })
            .andWhere(
                '(LOWER(TRIM(COALESCE(u.university, \'\'))) = :n OR LOWER(TRIM(COALESCE(u.institution, \'\'))) = :n)',
                { n },
            )
            .getRawMany();

        const ownedByUniversityOrg = await this.opportunityRepo.find({
            where: { organizationId: universityOrganizationId },
            select: ['id'],
        });

        const ids = new Set<string>();
        const merge = (rows: { id?: string }[]) => {
            for (const row of rows) {
                const id = row?.id as string | undefined;
                if (id) ids.add(id);
            }
        };
        merge(fromParticipations);
        merge(fromParticipationsStudentOrg);
        merge(fromEnrollmentOnParticipation);
        merge(fromApps);
        merge(fromAppsStudentOrg);
        merge(fromCreators);
        for (const o of ownedByUniversityOrg) {
            if (o.id) ids.add(o.id);
        }
        return [...ids];
    }

    async assign(params: {
        facultyUserId: string;
        universityOrganizationId: string;
        assignedByAdminId: string;
    }): Promise<FacultyUniversityScopeAssignment> {
        const faculty = await this.usersRepo.findOne({ where: { id: params.facultyUserId } });
        if (!faculty || faculty.role !== UserRole.FACULTY) {
            throw new BadRequestException('Target user must be an independent faculty account');
        }

        const org = await this.orgRepo.findOne({ where: { id: params.universityOrganizationId } });
        if (!org) {
            throw new NotFoundException('University organization not found');
        }
        if (!this.isUniversityOrganization(org)) {
            throw new BadRequestException('Organization must be a university-type organization');
        }

        const admin = await this.usersRepo.findOne({ where: { id: params.assignedByAdminId } });
        if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
            throw new ForbiddenException('Only platform admins can assign university scope');
        }

        const existing = await this.assignmentRepo.findOne({
            where: { facultyUser: { id: faculty.id } },
            relations: ['facultyUser', 'universityOrganization', 'assignedByAdmin'],
        });

        if (existing) {
            existing.universityOrganization = org;
            existing.assignedByAdmin = admin;
            return this.assignmentRepo.save(existing);
        }

        const created = this.assignmentRepo.create({
            facultyUser: faculty,
            universityOrganization: org,
            assignedByAdmin: admin,
        });
        return this.assignmentRepo.save(created);
    }

    async remove(facultyUserId: string): Promise<void> {
        const existing = await this.assignmentRepo.findOne({
            where: { facultyUser: { id: facultyUserId } },
        });
        if (!existing) {
            throw new NotFoundException('No university scope assignment for this faculty');
        }
        await this.assignmentRepo.remove(existing);
    }

    async listAll(): Promise<FacultyUniversityScopeAssignment[]> {
        return this.assignmentRepo.find({
            relations: ['facultyUser', 'universityOrganization', 'assignedByAdmin'],
            order: { createdAt: 'DESC' },
        });
    }

    async canFacultyReviewApplicationAsUniversityDelegate(
        facultyUserId: string,
        studentUser: User | null | undefined,
    ): Promise<boolean> {
        const row = await this.getAssignmentForFaculty(facultyUserId);
        if (!row?.universityOrganization) return false;
        const n = this.normalizeOrgName(row.universityOrganization.name);
        return this.studentProfileMatchesOrganization(studentUser, n);
    }
}

import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { UserRole } from '../../users/enums/user-role.enum';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';
import { Participation } from '../../engagement/entities/participant.entity';
import { StudentReport } from '../../reports/entities/student-report.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { FacultyUniversityScopeService } from '../../faculty-university-scope/faculty-university-scope.service';
import { AnalyticsScope, AnalyticsStakeholder } from './section-analytics.types';

const ACTIVE_PARTICIPATION_STATUSES = [
    'pending',
    'pending_payment_approval',
    'paid',
    'pending_ciel_approval',
    'pending_faculty_approval',
    'approved',
    'verified',
    'accepted',
    'finalized',
];

@Injectable()
export class AnalyticsScopeService {
    constructor(
        @InjectRepository(Opportunity)
        private readonly opportunityRepository: Repository<Opportunity>,
        @InjectRepository(Participation)
        private readonly participationRepository: Repository<Participation>,
        @InjectRepository(StudentReport)
        private readonly studentReportRepository: Repository<StudentReport>,
        @InjectRepository(Organization)
        private readonly organizationsRepository: Repository<Organization>,
        private readonly facultyUniversityScopeService: FacultyUniversityScopeService,
    ) {}

    resolveStakeholderFromRole(
        role: string,
        orgType?: string | null,
    ): AnalyticsStakeholder {
        if (role === UserRole.SUPER_ADMIN) return 'ciel';
        if (role === UserRole.STUDENT) return 'student';
        if (role === UserRole.UNIVERSITY) return 'university';
        if (
            role === UserRole.NGO ||
            role === UserRole.CORPORATE ||
            role === UserRole.ORGANIZATION_ADMIN ||
            role === UserRole.PARTNER
        ) {
            const t = String(orgType || '').toLowerCase();
            if (t.includes('university')) return 'university';
            return 'partner';
        }
        if (role === UserRole.FACULTY) return 'university';
        return 'ciel';
    }

    async resolveOrgType(
        organizationId?: string | null,
        fallback?: string | null,
    ): Promise<string | null> {
        if (fallback) return fallback;
        if (!organizationId) return null;
        const org = await this.organizationsRepository.findOne({
            where: { id: organizationId },
            select: ['orgType'],
        });
        return org?.orgType ?? null;
    }

    async assertAccess(input: {
        stakeholder: AnalyticsStakeholder;
        scope: AnalyticsScope;
        requesterUserId: string;
        requesterRole: string;
        organizationId?: string | null;
        projectId?: string;
        studentId?: string;
    }): Promise<void> {
        const {
            stakeholder,
            scope,
            requesterUserId,
            requesterRole,
            organizationId,
            projectId,
        } = input;

        if (stakeholder === 'ciel') {
            if (requesterRole !== UserRole.SUPER_ADMIN) {
                throw new ForbiddenException('Admin access required');
            }
            return;
        }

        if (scope === 'aggregate') {
            if (stakeholder === 'student') {
                throw new ForbiddenException(
                    'Students may only view their own project analytics',
                );
            }
            // Faculty may view cohort aggregates via facultyId even without an org link.
            if (requesterRole === UserRole.FACULTY) {
                return;
            }
            if (
                (stakeholder === 'partner' || stakeholder === 'university') &&
                !organizationId
            ) {
                throw new ForbiddenException('Organization membership required');
            }
            return;
        }

        if (!projectId) {
            throw new BadRequestException('project_id is required for project scope');
        }

        const opportunity = await this.opportunityRepository.findOne({
            where: { id: projectId },
        });
        if (!opportunity) throw new NotFoundException('Project not found');

        if (stakeholder === 'student') {
            const mine = await this.participationRepository.findOne({
                where: { studentId: requesterUserId, projectId },
            });
            if (!mine) {
                throw new ForbiddenException(
                    'You may only view analytics for your own projects',
                );
            }
            return;
        }

        if (stakeholder === 'partner') {
            if (!organizationId || opportunity.organizationId !== organizationId) {
                const scopedIds =
                    await this.facultyUniversityScopeService.resolveOpportunityIdsForUniversityOrganization(
                        organizationId || '',
                    );
                if (!scopedIds.includes(projectId)) {
                    throw new ForbiddenException(
                        'You may only view analytics for linked projects',
                    );
                }
            }
            return;
        }

        if (stakeholder === 'university') {
            if (requesterRole === UserRole.FACULTY) {
                const supervisesOpp = await this.opportunityRepository.findOne({
                    where: { id: projectId, facultyId: requesterUserId },
                    select: ['id'],
                });
                if (supervisesOpp) return;
                const supervisesReport = await this.studentReportRepository.findOne({
                    where: [
                        { opportunityId: projectId, facultyId: requesterUserId },
                        { project_id: projectId, facultyId: requesterUserId },
                    ],
                    select: ['id'],
                });
                if (supervisesReport) return;
                if (!organizationId) {
                    throw new ForbiddenException(
                        'Project is outside your faculty analytics scope',
                    );
                }
            }
            if (!organizationId) {
                throw new ForbiddenException('University organization required');
            }
            const participations =
                await this.loadUniversityScopedParticipations(organizationId);
            if (!participations.some((p) => p.projectId === projectId)) {
                throw new ForbiddenException(
                    'Project is outside your university analytics scope',
                );
            }
        }
    }

    async loadUniversityScopedParticipations(
        orgId: string,
    ): Promise<Participation[]> {
        const org = await this.organizationsRepository.findOne({
            where: { id: orgId },
        });
        if (!org) return [];
        const orgNameNorm = org.name.trim().toLowerCase();
        return this.participationRepository
            .createQueryBuilder('p')
            .leftJoinAndSelect('p.project', 'project')
            .leftJoinAndSelect('p.student', 'student')
            .where('p.student_id IS NOT NULL')
            .andWhere('p.status IN (:...st)', { st: ACTIVE_PARTICIPATION_STATUSES })
            .andWhere(
                new Brackets((b) => {
                    b.where(`TRIM(COALESCE(p.universityId, '')) = :orgId`, {
                        orgId,
                    })
                        .orWhere(`project."organizationId"::text = :orgId`, {
                            orgId,
                        })
                        .orWhere(`student."organizationId"::text = :orgId`, {
                            orgId,
                        })
                        .orWhere(
                            `LOWER(TRIM(COALESCE(p.universityName, ''))) = :orgNameNorm`,
                            { orgNameNorm },
                        )
                        .orWhere(
                            `LOWER(TRIM(COALESCE(student.university, ''))) = :orgNameNorm`,
                            { orgNameNorm },
                        );
                }),
            )
            .getMany();
    }

    async loadScopedReports(input: {
        stakeholder: AnalyticsStakeholder;
        scope: AnalyticsScope;
        organizationId?: string | null;
        projectId?: string;
        studentId?: string;
        universityFilter?: string;
        /** When set (faculty), prefer reports / opportunities supervised by this faculty. */
        facultyId?: string;
    }): Promise<{
        reports: StudentReport[];
        projectIds: string[];
        titles: string[];
    }> {
        let projectIds: string[] = [];
        let titles: string[] = [];

        if (input.scope === 'project' && input.projectId) {
            projectIds = [input.projectId];
            const opp = await this.opportunityRepository.findOne({
                where: { id: input.projectId },
                select: ['id', 'title'],
            });
            titles = opp?.title ? [opp.title] : [];
        } else if (input.facultyId && !input.organizationId) {
            const facultyReports = await this.studentReportRepository.find({
                where: { facultyId: input.facultyId },
                select: ['opportunityId', 'project_id'],
            });
            const fromReports = facultyReports
                .map((r) => r.opportunityId || r.project_id)
                .filter((id): id is string => Boolean(id));
            const facultyOpps = await this.opportunityRepository.find({
                where: { facultyId: input.facultyId },
                select: ['id', 'title'],
            });
            projectIds = [
                ...new Set([
                    ...fromReports,
                    ...facultyOpps.map((o) => o.id),
                ]),
            ];
            titles = facultyOpps.map((o) => o.title).filter(Boolean);
        } else if (input.organizationId) {
            const stakeholder = input.stakeholder;
            if (stakeholder === 'partner') {
                const opps = await this.opportunityRepository.find({
                    where: { organizationId: input.organizationId },
                    select: ['id', 'title'],
                });
                projectIds = opps.map((o) => o.id);
                titles = opps.map((o) => o.title).filter(Boolean);
            } else {
                const participations =
                    await this.loadUniversityScopedParticipations(
                        input.organizationId,
                    );
                projectIds = [...new Set(participations.map((p) => p.projectId))];
                titles = [
                    ...new Set(
                        participations
                            .map((p) => p.project?.title)
                            .filter((t): t is string => Boolean(t)),
                    ),
                ];
            }
        } else {
            const participations = await this.participationRepository
                .createQueryBuilder('p')
                .leftJoinAndSelect('p.project', 'project')
                .where('p.student_id IS NOT NULL')
                .andWhere('p.status IN (:...st)', {
                    st: ACTIVE_PARTICIPATION_STATUSES,
                })
                .getMany();
            projectIds = [...new Set(participations.map((p) => p.projectId))];
            titles = [
                ...new Set(
                    participations
                        .map((p) => p.project?.title)
                        .filter((t): t is string => Boolean(t)),
                ),
            ];
        }

        if (projectIds.length === 0) {
            return { reports: [], projectIds: [], titles: [] };
        }

        let reports = await this.studentReportRepository.find({
            where: [
                { opportunityId: In(projectIds) },
                { project_id: In(projectIds) },
            ],
            order: { updatedAt: 'DESC' },
        });

        if (input.studentId) {
            reports = reports.filter((r) => r.studentId === input.studentId);
        }

        if (input.scope === 'project' && input.projectId) {
            reports = reports.filter(
                (r) =>
                    r.opportunityId === input.projectId ||
                    r.project_id === input.projectId,
            );
        }

        if (input.universityFilter?.trim()) {
            const uni = input.universityFilter.trim().toLowerCase();
            const participations = await this.participationRepository.find({
                where: { projectId: In(projectIds) },
                relations: ['student'],
            });
            const allowedStudentIds = new Set(
                participations
                    .filter((p) =>
                        (p.universityName || p.student?.university || '')
                            .trim()
                            .toLowerCase() === uni,
                    )
                    .map((p) => p.studentId)
                    .filter(Boolean),
            );
            reports = reports.filter((r) => allowedStudentIds.has(r.studentId));
        }

        // Deduplicate: keep newest report per student+project
        const seen = new Set<string>();
        const deduped: StudentReport[] = [];
        for (const r of reports) {
            const key = `${r.studentId}:${r.opportunityId || r.project_id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(r);
        }

        return { reports: deduped, projectIds, titles };
    }
}

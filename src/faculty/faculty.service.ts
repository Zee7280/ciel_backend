import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { UserRole } from '../users/enums/user-role.enum';

/** Participation statuses treated as “active” for faculty dashboard student counts. */
const ACTIVE_PARTICIPATION_STATUSES = [
    'approved',
    'verified',
    'paid',
    'pending_ciel_approval',
    'pending_faculty_approval',
    'accepted',
] as const;

const SDG_SHORT_NAMES: Record<number, string> = {
    1: 'No Poverty',
    2: 'Zero Hunger',
    3: 'Good Health and Well-being',
    4: 'Quality Education',
    5: 'Gender Equality',
    6: 'Clean Water and Sanitation',
    7: 'Affordable and Clean Energy',
    8: 'Decent Work and Economic Growth',
    9: 'Industry, Innovation and Infrastructure',
    10: 'Reduced Inequality',
    11: 'Sustainable Cities and Communities',
    12: 'Responsible Consumption and Production',
    13: 'Climate Action',
    14: 'Life Below Water',
    15: 'Life on Land',
    16: 'Peace, Justice and Strong Institutions',
    17: 'Partnerships for the Goals',
};

const SDG_COLORS: Record<number, string> = {
    1: '#e5243b',
    2: '#dda63a',
    3: '#4c9f38',
    4: '#c5192d',
    5: '#ff3a21',
    6: '#26bde2',
    7: '#fcc30b',
    8: '#a21942',
    9: '#fd6925',
    10: '#dd1367',
    11: '#fd9d24',
    12: '#bf8b2e',
    13: '#3f7e44',
    14: '#0a97d9',
    15: '#56c02b',
    16: '#00689d',
    17: '#19486a',
};

const COURSE_LINKED_ACADEMIC_TYPES = [
    'Course-Linked',
    'Credit-Bearing',
    'Capstone / Thesis',
    'Research-Integrated',
] as const;

type ActivityRow = {
    title: string;
    description: string | null;
    created_at: string;
    sortAt: number;
};

/** Query `view` on GET /faculty/dashboard — Instagram-style context switch for delegated university visibility. */
export type FacultyDashboardViewMode = 'combined' | 'personal' | 'university';

@Injectable()
export class FacultyService {
    constructor(
        @InjectRepository(Opportunity)
        private readonly opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
        @InjectRepository(StudentReport)
        private readonly studentReportsRepository: Repository<StudentReport>,
        @InjectRepository(Participation)
        private readonly participationRepository: Repository<Participation>,
        @InjectRepository(Timesheet)
        private readonly timesheetsRepository: Repository<Timesheet>,
        @InjectRepository(OpportunityApplication)
        private readonly opportunityApplicationsRepository: Repository<OpportunityApplication>,
        private readonly facultyUniversityScopeService: FacultyUniversityScopeService,
    ) {}

    private normalizeFacultyEmail(facultyEmail: string): string {
        return (facultyEmail || '').trim().toLowerCase();
    }

    private resolveRequiredHoursPerStudent(project: Opportunity | null | undefined): number {
        if (!project) return 0;
        const raw = project.timeline?.expected_hours;
        const fromT = Number(raw);
        if (Number.isFinite(fromT) && fromT > 0) return fromT;
        const rh = Number(project.requiredHours);
        return Number.isFinite(rh) ? rh : 0;
    }

    private participationTeamBucketKey(
        p: Pick<Participation, 'id' | 'participationMode' | 'teamId' | 'applicationId'>,
    ): string {
        if (p.participationMode !== 'team') {
            return `ind:${p.id}`;
        }
        const tid = typeof p.teamId === 'string' ? p.teamId.trim() : '';
        if (tid) return `tid:${tid}`;
        if (p.applicationId) return `aid:${p.applicationId}`;
        return `ind:${p.id}`;
    }

    /** Same opportunity scope as `GET /faculty/dashboard` for a given `view`. */
    private async resolveFacultyScopedContext(
        facultyId: string,
        facultyEmail: string,
        view: FacultyDashboardViewMode,
    ): Promise<{
        university_scope: { organization_id: string; organization_name: string } | null;
        effectiveView: FacultyDashboardViewMode;
        scopedIds: string[];
        delegatedOppIds: string[];
        faculty_view_modes_available: FacultyDashboardViewMode[];
    }> {
        const user = await this.usersRepository.findOne({ where: { id: facultyId } });
        if (!user || user.role !== UserRole.FACULTY) {
            throw new ForbiddenException('Only faculty can access this dashboard');
        }

        const personalIds = await this.resolveFacultyPersonalOpportunityIds(facultyId, facultyEmail);
        const delegatedOppIds = await this.resolveDelegatedOpportunityIds(facultyId);

        const delegation = await this.facultyUniversityScopeService.getAssignmentForFaculty(facultyId);
        const university_scope = delegation?.universityOrganization
            ? {
                  organization_id: delegation.universityOrganization.id,
                  organization_name: delegation.universityOrganization.name,
              }
            : null;

        const effectiveView: FacultyDashboardViewMode =
            view === 'university' && !university_scope ? 'combined' : view;

        let scopedIds: string[];
        if (effectiveView === 'personal') {
            scopedIds = personalIds;
        } else if (effectiveView === 'university') {
            scopedIds = [...delegatedOppIds];
        } else {
            scopedIds = [...new Set([...personalIds, ...delegatedOppIds])];
        }

        const faculty_view_modes_available: FacultyDashboardViewMode[] = university_scope
            ? ['combined', 'personal', 'university']
            : ['combined', 'personal'];

        return { university_scope, effectiveView, scopedIds, delegatedOppIds, faculty_view_modes_available };
    }

    /**
     * Supervision + primary-faculty applications only (no admin-delegated university org expansion).
     */
    private async resolveFacultyPersonalOpportunityIds(facultyId: string, facultyEmail: string): Promise<string[]> {
        const fe = this.normalizeFacultyEmail(facultyEmail);
        const oppQ = this.opportunitiesRepository.createQueryBuilder('o').select('o.id').where(
            new Brackets((qb) => {
                qb.where('"o"."facultyId"::text = :facultyId', { facultyId });
                if (fe) {
                    qb.orWhere(`LOWER(TRIM(COALESCE(o.supervision->>'contact', ''))) = :fe`, { fe }).orWhere(
                        `LOWER(TRIM(COALESCE(o.supervision->>'official_email', ''))) = :fe`,
                        { fe },
                    );
                }
            }),
        );
        const fromOpps = (await oppQ.getMany()).map((r) => r.id);
        const fromApps = fe
            ? (
                  await this.opportunityApplicationsRepository
                      .createQueryBuilder('a')
                      .select('DISTINCT a.opportunityId', 'opportunityId')
                      .where('LOWER(TRIM(a.primaryFacultyEmail)) = :fe', { fe })
                      .andWhere('a.withdrawnAt IS NULL')
                      .getRawMany()
              ).map((r: { opportunityId: string }) => r.opportunityId)
            : [];
        return [...new Set([...fromOpps, ...fromApps])];
    }

    /** Personal opportunities plus delegated university-org visibility (combined default). */
    private async resolveFacultyScopedOpportunityIds(facultyId: string, facultyEmail: string): Promise<string[]> {
        const personal = await this.resolveFacultyPersonalOpportunityIds(facultyId, facultyEmail);
        const delegated = await this.resolveDelegatedOpportunityIds(facultyId);
        return [...new Set([...personal, ...delegated])];
    }

    private async resolveDelegatedOpportunityIds(facultyId: string): Promise<string[]> {
        const orgId = await this.facultyUniversityScopeService.getDelegatedOrganizationId(facultyId);
        if (!orgId) return [];
        return this.facultyUniversityScopeService.resolveOpportunityIdsForUniversityOrganization(orgId);
    }

    private buildFacultyApprovalsQuery(
        facultyId: string,
        facultyEmail: string,
        status?: string,
        delegatedOpportunityIds: string[] = [],
    ): SelectQueryBuilder<Opportunity> {
        const fe = this.normalizeFacultyEmail(facultyEmail);
        const hasDelegated = delegatedOpportunityIds.length > 0;

        const query = this.opportunitiesRepository.createQueryBuilder('opportunity').where(
            new Brackets((top) => {
                top.where(
                    new Brackets((qb) => {
                        qb.where('"opportunity"."facultyId"::text = :facultyId', { facultyId });
                        if (fe) {
                            qb.orWhere(
                                `LOWER(TRIM(COALESCE(opportunity.supervision->>'contact', ''))) = :fe`,
                                { fe },
                            ).orWhere(
                                `LOWER(TRIM(COALESCE(opportunity.supervision->>'official_email', ''))) = :fe`,
                                { fe },
                            );
                        }
                    }),
                );
                if (hasDelegated) {
                    top.orWhere('opportunity.id IN (:...delegatedOppIdsTop)', {
                        delegatedOppIdsTop: delegatedOpportunityIds,
                    });
                }
            }),
        );

        if (status === 'pending' || status === undefined || status === '') {
            query.andWhere(
                new Brackets((outer) => {
                    outer.where(
                        new Brackets((early) => {
                            early
                                .where(
                                    new Brackets((s) => {
                                        s.where('opportunity.isStudentCreated = :isc', { isc: true }).orWhere(
                                            '(opportunity.creatorId IS NOT NULL AND opportunity.faculty_verification_token IS NOT NULL)',
                                        );
                                    }),
                                )
                                .andWhere(
                                    new Brackets((s) => {
                                        s.where('opportunity.status = :pf', { pf: 'pending_faculty' }).orWhere(
                                            'opportunity.status = :pv',
                                            { pv: 'pending_verification' },
                                        );
                                    }),
                                )
                                .andWhere('opportunity.faculty_verified = :fvp', { fvp: false })
                                .andWhere(
                                    new Brackets((s) => {
                                        s.where('opportunity.liaisonVerified = :lvp', { lvp: false }).orWhere(
                                            'opportunity.liaisonVerified IS NULL',
                                        );
                                    }),
                                );
                        }),
                    )
                        .orWhere(
                            new Brackets((rep) => {
                                rep.where('opportunity.creatorId IS NOT NULL').andWhere(
                                    `EXISTS (
                                        SELECT 1 FROM student_reports sr
                                        WHERE (
                                            sr."opportunityId"::text = opportunity.id::text
                                            OR (
                                                sr.project_id IS NOT NULL
                                                AND TRIM(sr.project_id)::text = opportunity.id::text
                                            )
                                        )
                                          AND sr."studentId"::text = opportunity."creatorId"::text
                                          AND (sr.faculty_status IS NULL OR sr.faculty_status = :repFacPending)
                                          AND COALESCE(sr.status, '') NOT IN (:repDraft, :repRejected)
                                    )`,
                                    {
                                        repFacPending: 'pending',
                                        repDraft: 'draft',
                                        repRejected: 'rejected',
                                    },
                                );
                            }),
                        )
                        .orWhere(
                            new Brackets((app) => {
                                const appPred = hasDelegated
                                    ? `EXISTS (
                                        SELECT 1 FROM opportunity_applications oa
                                        WHERE oa.opportunity_id::text = opportunity.id::text
                                          AND oa.withdrawn_at IS NULL
                                          AND oa.internal_status = :oaPendingFac
                                          AND (
                                            :oaEmailFilterOff = true
                                            OR LOWER(TRIM(oa.primary_faculty_email)) = :oaFacultyEmail
                                            OR opportunity.id IN (:...delegatedOppIdsApp)
                                          )
                                    )`
                                    : `EXISTS (
                                        SELECT 1 FROM opportunity_applications oa
                                        WHERE oa.opportunity_id::text = opportunity.id::text
                                          AND oa.withdrawn_at IS NULL
                                          AND oa.internal_status = :oaPendingFac
                                          AND (
                                            :oaEmailFilterOff = true
                                            OR LOWER(TRIM(oa.primary_faculty_email)) = :oaFacultyEmail
                                          )
                                    )`;
                                app.where(appPred, {
                                    oaPendingFac: 'pending_faculty',
                                    oaEmailFilterOff: !fe,
                                    oaFacultyEmail: fe,
                                    ...(hasDelegated ? { delegatedOppIdsApp: delegatedOpportunityIds } : {}),
                                });
                            }),
                        );
                }),
            );
        } else if (status === 'history' || status === 'reviewed') {
            query
                .andWhere('opportunity.creatorId IS NOT NULL')
                .andWhere(
                    new Brackets((qb) => {
                        qb.where('opportunity.isStudentCreated = :isc', { isc: true }).orWhere(
                            'opportunity.liaisonToken IS NOT NULL',
                        );
                    }),
                )
                .andWhere(
                    new Brackets((qb) => {
                        qb.where('opportunity.faculty_verified = :fv', { fv: true })
                            .orWhere('opportunity.liaisonVerified = :lv', { lv: true })
                            .orWhere('opportunity.status IN (:...histSt)', {
                                histSt: ['pending_approval', 'pending_partner', 'active', 'rejected'],
                            });
                    }),
                )
                .andWhere(
                    `NOT EXISTS (
                        SELECT 1 FROM student_reports sr
                        WHERE (
                            sr."opportunityId"::text = opportunity.id::text
                            OR (
                                sr.project_id IS NOT NULL
                                AND TRIM(sr.project_id)::text = opportunity.id::text
                            )
                        )
                          AND sr."studentId"::text = opportunity."creatorId"::text
                          AND (sr.faculty_status IS NULL OR sr.faculty_status = :histRepFacPending)
                          AND COALESCE(sr.status, '') NOT IN (:histRepDraft, :histRepRejected)
                    )`,
                    {
                        histRepFacPending: 'pending',
                        histRepDraft: 'draft',
                        histRepRejected: 'rejected',
                    },
                )
                .andWhere(
                    hasDelegated
                        ? `NOT EXISTS (
                        SELECT 1 FROM opportunity_applications oa
                        WHERE oa.opportunity_id::text = opportunity.id::text
                          AND oa.withdrawn_at IS NULL
                          AND oa.internal_status = :histOaPendingFac
                          AND (
                            :histOaEmailFilterOff = true
                            OR LOWER(TRIM(oa.primary_faculty_email)) = :histOaFacultyEmail
                            OR opportunity.id IN (:...delegatedOppIdsHistApp)
                          )
                    )`
                        : `NOT EXISTS (
                        SELECT 1 FROM opportunity_applications oa
                        WHERE oa.opportunity_id::text = opportunity.id::text
                          AND oa.withdrawn_at IS NULL
                          AND oa.internal_status = :histOaPendingFac
                          AND (
                            :histOaEmailFilterOff = true
                            OR LOWER(TRIM(oa.primary_faculty_email)) = :histOaFacultyEmail
                          )
                    )`,
                    {
                        histOaPendingFac: 'pending_faculty',
                        histOaEmailFilterOff: !fe,
                        histOaFacultyEmail: fe,
                        ...(hasDelegated ? { delegatedOppIdsHistApp: delegatedOpportunityIds } : {}),
                    },
                );
        } else {
            query.andWhere('opportunity.status = :st', { st: status });
        }

        return query;
    }

    private formatSdgLabel(opp: Opportunity): string {
        const n = opp.sdg_info?.sdg_id;
        const num = typeof n === 'number' ? n : typeof n === 'string' ? parseInt(n, 10) : NaN;
        if (!Number.isNaN(num) && num >= 1 && num <= 17) {
            return `SDG ${num} – ${SDG_SHORT_NAMES[num]}`;
        }
        if (opp.sdg && String(opp.sdg).trim()) {
            const s = String(opp.sdg).trim();
            if (/^\d+$/.test(s)) {
                const k = parseInt(s, 10);
                if (k >= 1 && k <= 17) return `SDG ${k} – ${SDG_SHORT_NAMES[k]}`;
            }
            return s;
        }
        return 'Other / unspecified';
    }

    private sdgColorForLabel(label: string): string | undefined {
        const m = /^SDG\s*(\d+)/i.exec(label);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n >= 1 && n <= 17) return SDG_COLORS[n];
        }
        return undefined;
    }

    private pickCourseCode(opp: Opportunity): string | null {
        const al = opp.academic_linkage as { course_code?: string; courseCode?: string } | undefined;
        const code = al?.course_code || al?.courseCode;
        return code && String(code).trim() ? String(code).trim() : null;
    }

    private pickSemester(opp: Opportunity): string | null {
        const al = opp.academic_linkage as { semester?: string; term?: string } | undefined;
        const val = al?.semester || al?.term;
        return val && String(val).trim() ? String(val).trim() : null;
    }

    async getProjectDetail(facultyId: string, facultyEmail: string, opportunityId: string) {
        const scopedIds = await this.resolveFacultyScopedOpportunityIds(facultyId, facultyEmail);
        if (!scopedIds.includes(opportunityId)) {
            throw new NotFoundException('Project not found or not assigned to you');
        }

        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId },
            relations: ['organization'],
        });

        if (!opportunity) {
            throw new NotFoundException('Project not found');
        }

        const student = opportunity.creatorId
            ? await this.usersRepository.findOne({
                  where: { id: opportunity.creatorId },
                  select: [
                      'id',
                      'name',
                      'email',
                      'registrationNumber',
                      'university',
                      'major',
                      'phone',
                      'city',
                      'department',
                      'avatar',
                  ],
              })
            : null;

        const reports = await this.studentReportsRepository.find({
            where: { opportunityId },
            relations: ['student'],
            order: { submission_date: 'DESC' },
        });

        const { liaisonToken: _lt, partnerToken: _pt, ...opportunitySafe } = opportunity;

        return {
            success: true,
            data: {
                opportunity: opportunitySafe,
                student,
                reports: reports.map((r) => ({
                    id: r.id,
                    status: r.status,
                    faculty_status: r.faculty_status,
                    submission_date: r.submission_date,
                    report_submitted_at: r.reportSubmittedAt,
                    partner_approved_at: r.partnerApprovedAt,
                    admin_approved_at: r.adminApprovedAt,
                    student_name: r.student?.name || 'Unknown',
                    student_email: r.student?.email || 'Unknown',
                })),
            },
        };
    }

    async getApprovals(facultyId: string, facultyEmail: string, status?: string) {
        const delegatedOppIds = await this.resolveDelegatedOpportunityIds(facultyId);
        const query = this.buildFacultyApprovalsQuery(facultyId, facultyEmail, status, delegatedOppIds);
        const opportunities = await query.orderBy('opportunity.createdAt', 'DESC').getMany();

        const formatted = await Promise.all(
            opportunities.map(async (opp) => {
                const student = await this.usersRepository.findOne({ where: { id: opp.creatorId } });
                const latestReport =
                    opp.creatorId
                        ? await this.studentReportsRepository.findOne({
                              where: [
                                  { opportunityId: opp.id, studentId: opp.creatorId },
                                  { project_id: opp.id, studentId: opp.creatorId },
                              ],
                              order: { submission_date: 'DESC' },
                          })
                        : null;
                const metrics = (
                    latestReport?.section1 as
                        | { metrics?: { total_verified_hours?: number; eis_score?: number } }
                        | undefined
                )?.metrics;
                const totalHours = Number(metrics?.total_verified_hours ?? 0) || 0;
                const eisScore = Number(metrics?.eis_score ?? 0) || 0;
                const impactScore =
                    Number(
                        (latestReport?.section11 as { ai_generated_impact_score?: number } | undefined)
                            ?.ai_generated_impact_score ?? 0,
                    ) || 0;

                return {
                    id: opp.id,
                    opportunity_id: opp.id,
                    title: opp.title,
                    projectTitle: opp.title,
                    studentName: student?.name || 'Unknown Student',
                    studentId: student?.registrationNumber || student?.id || 'N/A',
                    studentEmail: student?.email || null,
                    submittedDate: opp.createdAt.toISOString().split('T')[0],
                    totalHours,
                    eisScore,
                    impactScore,
                    sdg: opp.sdg || opp.sdg_info?.sdg_id || 'N/A',
                    opportunityStatus: opp.status,
                    workflowStage: opp.workflowStage ?? null,
                    workflow_stage: opp.workflowStage ?? null,
                    requires_partner_approval: opp.requiresPartnerApproval,
                    faculty_approval_status: opp.facultyApprovalStatus ?? null,
                    partner_approval_status: opp.partnerApprovalStatus ?? null,
                    admin_approval_status: opp.adminApprovalStatus ?? null,
                    facultyVerified: opp.faculty_verified,
                    liaisonVerified: opp.liaisonVerified,
                };
            }),
        );

        return {
            success: true,
            data: formatted,
        };
    }

    async getDashboard(
        facultyId: string,
        facultyEmail: string,
        view: FacultyDashboardViewMode = 'combined',
    ) {
        const { university_scope, effectiveView, scopedIds, delegatedOppIds, faculty_view_modes_available } =
            await this.resolveFacultyScopedContext(facultyId, facultyEmail, view);

        const delegatedForPendingQuery = effectiveView === 'personal' ? [] : delegatedOppIds;
        const pendingList = await this.buildFacultyApprovalsQuery(
            facultyId,
            facultyEmail,
            'pending',
            delegatedForPendingQuery,
        ).getMany();
        const delegatedSet = new Set(delegatedOppIds);
        const pendingApprovals =
            effectiveView === 'university'
                ? pendingList.filter((o) => delegatedSet.has(o.id)).length
                : pendingList.length;

        if (scopedIds.length === 0) {
            return {
                success: true,
                data: {
                    university_scope,
                    dashboard_view: effectiveView,
                    requested_dashboard_view: view,
                    faculty_view_modes_available,
                    students_active: 0,
                    hours_verified: 0,
                    pending_approvals: pendingApprovals,
                    courses: [],
                    hours_trend: [],
                    impact_distribution: [],
                    recent_activity: [],
                    pendingSummary: {
                        total: pendingApprovals,
                        items: [
                            {
                                key: 'faculty_pending_approvals',
                                title: 'Pending approvals',
                                count: pendingApprovals,
                                href: '/dashboard/faculty/approvals',
                                tone: 'warning',
                                description: 'Student-created opportunities or reports waiting for faculty review.',
                            },
                        ],
                    },
                },
            };
        }

        const idParams = { ids: scopedIds };

        const studentsRow = await this.participationRepository
            .createQueryBuilder('p')
            .select('COUNT(DISTINCT p.student_id)', 'cnt')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st: [...ACTIVE_PARTICIPATION_STATUSES] })
            .getRawOne<{ cnt: string }>();

        const hoursRow = await this.timesheetsRepository
            .createQueryBuilder('t')
            .select('COALESCE(SUM(t.hours), 0)', 'sum')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams)
            .getRawOne<{ sum: string }>();

        const hoursVerified = Number(hoursRow?.sum ?? 0) || 0;
        const studentsActive = Number(studentsRow?.cnt ?? 0) || 0;

        const trendRows = await this.timesheetsRepository
            .createQueryBuilder('t')
            .select(`date_trunc('month', t."updatedAt")`, 'bucket')
            .addSelect('SUM(t.hours)', 'hours')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams)
            .andWhere(`t."updatedAt" >= NOW() - INTERVAL '13 months'`)
            .groupBy('bucket')
            .orderBy('bucket', 'ASC')
            .getRawMany<{ bucket: Date; hours: string }>();

        const hours_trend = trendRows.map((row) => {
            const d = row.bucket instanceof Date ? row.bucket : new Date(row.bucket);
            const label = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
            return { label, hours: Number(row.hours) || 0 };
        });

        const oppsForSdg = await this.opportunitiesRepository.find({
            where: { id: In(scopedIds) },
            select: ['id', 'sdg', 'sdg_info'],
        });
        const sdgCounts = new Map<string, number>();
        for (const o of oppsForSdg) {
            const label = this.formatSdgLabel(o);
            sdgCounts.set(label, (sdgCounts.get(label) || 0) + 1);
        }

        const reportSdgRows = await this.studentReportsRepository
            .createQueryBuilder('r')
            .select('r.primary_sdg_goal', 'g')
            .addSelect('COUNT(*)', 'c')
            .where('COALESCE(r.status, \'\') NOT IN (:...draftish)', { draftish: ['draft', 'rejected'] })
            .andWhere('r.primary_sdg_goal IS NOT NULL')
            .andWhere(
                new Brackets((qb) => {
                    qb.where('r."opportunityId"::text IN (:...ids)', idParams).orWhere(
                        '(r.project_id IS NOT NULL AND TRIM(r.project_id) IN (:...ids))',
                        idParams,
                    );
                }),
            )
            .groupBy('r.primary_sdg_goal')
            .getRawMany<{ g: number; c: string }>();

        for (const row of reportSdgRows) {
            const n = Number(row.g);
            if (!Number.isFinite(n) || n < 1 || n > 17) continue;
            const label = `SDG ${n} – ${SDG_SHORT_NAMES[n]}`;
            sdgCounts.set(label, (sdgCounts.get(label) || 0) + Number(row.c));
        }

        const impact_distribution = [...sdgCounts.entries()]
            .map(([name, value]) => ({
                name,
                value,
                color: this.sdgColorForLabel(name),
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 12);

        const coursesBase = await this.opportunitiesRepository.find({
            where: { id: In(scopedIds) },
            order: { updatedAt: 'DESC' },
            take: 50,
        });

        const courses = await Promise.all(
            coursesBase.map(async (opp) => {
                const enrolled_students = await this.participationRepository.count({
                    where: {
                        projectId: opp.id,
                        status: In([
                            'pending',
                            'accepted',
                            'approved',
                            'verified',
                            'paid',
                            'pending_payment_approval',
                            'pending_ciel_approval',
                            'pending_faculty_approval',
                        ] as unknown as string[]),
                    },
                });
                const pending_grading = await this.studentReportsRepository
                    .createQueryBuilder('r')
                    .where(
                        new Brackets((qb) => {
                            qb.where('r."opportunityId"::text = :oid', { oid: opp.id }).orWhere(
                                '(r.project_id IS NOT NULL AND TRIM(r.project_id) = :oid)',
                                { oid: opp.id },
                            );
                        }),
                    )
                    .andWhere('(r.faculty_status IS NULL OR r.faculty_status = :fp)', { fp: 'pending' })
                    .andWhere('COALESCE(r.status, \'\') NOT IN (:...ex)', { ex: ['draft', 'rejected'] })
                    .getCount();

                return {
                    id: opp.id,
                    title: opp.title,
                    name: opp.title,
                    code: this.pickCourseCode(opp),
                    semester: this.pickSemester(opp),
                    enrolled_students,
                    students: enrolled_students,
                    pending_grading,
                    pending: pending_grading,
                };
            }),
        );
        const pendingGradingTotal = courses.reduce((sum, course) => sum + (course.pending_grading || 0), 0);

        const activities: ActivityRow[] = [];

        const reportEvents = await this.studentReportsRepository
            .createQueryBuilder('r')
            .leftJoinAndSelect('r.opportunity', 'o')
            .leftJoinAndSelect('r.student', 'stu')
            .where(
                new Brackets((qb) => {
                    qb.where('r."opportunityId"::text IN (:...ids)', idParams).orWhere(
                        '(r.project_id IS NOT NULL AND TRIM(r.project_id) IN (:...ids))',
                        idParams,
                    );
                }),
            )
            .andWhere('COALESCE(r.status, \'\') NOT IN (:...ex)', { ex: ['draft'] })
            .addSelect('COALESCE(r.reportSubmittedAt, r.submission_date, r.updatedAt)', 'report_recent_at')
            .orderBy('report_recent_at', 'DESC')
            .take(12)
            .getMany();

        for (const r of reportEvents) {
            const at = r.reportSubmittedAt || r.submission_date || r.updatedAt;
            const title =
                r.status === 'submitted' || (r.reportSubmittedAt && r.status !== 'draft')
                    ? 'Report submitted'
                    : 'Report updated';
            const course = r.opportunity?.title || 'Project';
            const who = r.student?.name || 'Student';
            activities.push({
                title,
                description: `${course} · ${who}`,
                created_at: at.toISOString(),
                sortAt: at.getTime(),
            });
        }

        const appEvents = await this.opportunityApplicationsRepository
            .createQueryBuilder('a')
            .leftJoinAndSelect('a.opportunity', 'o')
            .leftJoinAndSelect('a.studentUser', 's')
            .where('a.opportunityId IN (:...ids)', idParams)
            .andWhere('a.withdrawnAt IS NULL')
            .orderBy('a.updatedAt', 'DESC')
            .take(12)
            .getMany();

        for (const a of appEvents) {
            const at = a.facultyDecidedAt || a.updatedAt || a.createdAt;
            let title = 'Application updated';
            if (a.internalStatus === 'pending_faculty') {
                title = 'Application pending review';
            } else if (a.internalStatus === 'pending_partner' || a.internalStatus === 'pending_admin') {
                title = 'Application advanced';
            } else if (a.internalStatus === 'approved') {
                title = 'Application approved';
            } else if (a.internalStatus?.endsWith('rejected')) {
                title = 'Application rejected';
            }
            activities.push({
                title,
                description: a.opportunity?.title
                    ? `${a.opportunity.title} · ${a.studentUser?.name || 'Student'}`
                    : a.studentUser?.name || null,
                created_at: at.toISOString(),
                sortAt: at.getTime(),
            });
        }

        const recent_activity = [...activities]
            .sort((a, b) => b.sortAt - a.sortAt)
            .slice(0, 18)
            .map(({ sortAt: _s, ...rest }) => rest);

        return {
            success: true,
            data: {
                university_scope,
                dashboard_view: effectiveView,
                requested_dashboard_view: view,
                faculty_view_modes_available,
                students_active: studentsActive,
                hours_verified: hoursVerified,
                pending_approvals: pendingApprovals,
                courses,
                hours_trend,
                impact_distribution,
                recent_activity,
                pendingSummary: {
                    total: pendingApprovals + pendingGradingTotal,
                    items: [
                        {
                            key: 'faculty_pending_approvals',
                            title: 'Pending approvals',
                            count: pendingApprovals,
                            href: '/dashboard/faculty/approvals',
                            tone: 'warning',
                            description: 'Student-created opportunities or reports waiting for faculty review.',
                        },
                        {
                            key: 'faculty_pending_grading',
                            title: 'Pending grading',
                            count: pendingGradingTotal,
                            href: '/dashboard/faculty/grading',
                            tone: 'neutral',
                            description: 'Submitted student work still waiting for grading.',
                        },
                    ],
                },
            },
        };
    }

    /**
     * Department / supervision analytics for Impact Analytics page.
     * Uses the same opportunity scope as `getDashboard` for the given `view`.
     */
    async getImpactAnalytics(
        facultyId: string,
        facultyEmail: string,
        view: FacultyDashboardViewMode = 'combined',
    ) {
        const { university_scope, effectiveView, scopedIds, faculty_view_modes_available } =
            await this.resolveFacultyScopedContext(facultyId, facultyEmail, view);

        const buildEmpty = () => ({
            university_scope,
            dashboard_view: effectiveView,
            requested_dashboard_view: view,
            faculty_view_modes_available,
            total_students_under_faculty: 0,
            verified_students: 0,
            verification_rate_percent: 0,
            individual_participants: 0,
            team_participants: 0,
            total_teams: 0,
            average_team_size: 0,
            total_required_hours: 0,
            course_linked_ce_ratio_percent: 0,
            hours_verified: 0,
            projects_completed: 0,
            avg_impact_score: 0,
            hours_trend: [] as { label: string; hours: number }[],
            impact_distribution: [] as { name: string; value: number; color: string }[],
        });

        if (scopedIds.length === 0) {
            return { success: true, data: buildEmpty() };
        }

        const idParams = { ids: scopedIds };
        const st = [...ACTIVE_PARTICIPATION_STATUSES];

        const totalStudentsRow = await this.participationRepository
            .createQueryBuilder('p')
            .select('COUNT(DISTINCT p.student_id)', 'cnt')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st })
            .andWhere('p.student_id IS NOT NULL')
            .getRawOne<{ cnt: string }>();
        const totalStudents = Number(totalStudentsRow?.cnt ?? 0) || 0;

        const verifiedRow = await this.participationRepository
            .createQueryBuilder('p')
            .innerJoin('users', 'u', 'u.id = p.student_id')
            .select('COUNT(DISTINCT p.student_id)', 'cnt')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st })
            .andWhere('p.student_id IS NOT NULL')
            .andWhere('u.profile_verified = true')
            .andWhere('u.identity_verified = true')
            .getRawOne<{ cnt: string }>();
        const verifiedStudents = Number(verifiedRow?.cnt ?? 0) || 0;

        const verificationRatePercent =
            totalStudents === 0 ? 0 : Math.round((100 * verifiedStudents) / totalStudents);

        const participations = await this.participationRepository.find({
            where: {
                projectId: In(scopedIds),
                status: In([...st] as unknown as string[]),
                studentId: Not(IsNull()),
            },
            relations: ['project'],
        });

        let individualParticipants = 0;
        let teamParticipants = 0;
        const teamBuckets = new Set<string>();
        for (const p of participations) {
            if (p.participationMode === 'team') {
                teamParticipants += 1;
                teamBuckets.add(`${p.projectId}|${this.participationTeamBucketKey(p)}`);
            } else {
                individualParticipants += 1;
            }
        }
        const totalTeams = teamBuckets.size;
        const averageTeamSize =
            totalTeams > 0 ? Math.round((teamParticipants / totalTeams) * 10) / 10 : 0;

        let totalRequiredHours = 0;
        for (const p of participations) {
            totalRequiredHours += this.resolveRequiredHoursPerStudent(p.project);
        }

        const ceStudentsRow = await this.participationRepository
            .createQueryBuilder('p')
            .select('COUNT(DISTINCT p.student_id)', 'cnt')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st })
            .andWhere('p.student_id IS NOT NULL')
            .andWhere('p.academicIntegrationType IN (:...ce)', { ce: [...COURSE_LINKED_ACADEMIC_TYPES] })
            .getRawOne<{ cnt: string }>();
        const ceStudentCount = Number(ceStudentsRow?.cnt ?? 0) || 0;
        const courseLinkedCeRatioPercent =
            totalStudents === 0 ? 0 : Math.round((100 * ceStudentCount) / totalStudents);

        const hoursRow = await this.timesheetsRepository
            .createQueryBuilder('t')
            .select('COALESCE(SUM(t.hours), 0)', 'sum')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams)
            .getRawOne<{ sum: string }>();
        const hoursVerified = Number(hoursRow?.sum ?? 0) || 0;

        const projectsCompletedRow = await this.timesheetsRepository
            .createQueryBuilder('t')
            .select('COUNT(DISTINCT t.opportunityId)', 'cnt')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams)
            .getRawOne<{ cnt: string }>();
        const projectsCompleted = Number(projectsCompletedRow?.cnt ?? 0) || 0;

        const trendRows = await this.timesheetsRepository
            .createQueryBuilder('t')
            .select(`date_trunc('month', t."updatedAt")`, 'bucket')
            .addSelect('SUM(t.hours)', 'hours')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams)
            .andWhere(`t."updatedAt" >= NOW() - INTERVAL '13 months'`)
            .groupBy('bucket')
            .orderBy('bucket', 'ASC')
            .getRawMany<{ bucket: Date; hours: string }>();

        const hours_trend = trendRows.map((row) => {
            const d = row.bucket instanceof Date ? row.bucket : new Date(row.bucket);
            const label = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
            return { label, hours: Number(row.hours) || 0 };
        });

        const oppsForSdg = await this.opportunitiesRepository.find({
            where: { id: In(scopedIds) },
            select: ['id', 'sdg', 'sdg_info'],
        });
        const sdgCounts = new Map<string, number>();
        for (const o of oppsForSdg) {
            const label = this.formatSdgLabel(o);
            sdgCounts.set(label, (sdgCounts.get(label) || 0) + 1);
        }

        const reportSdgRows = await this.studentReportsRepository
            .createQueryBuilder('r')
            .select('r.primary_sdg_goal', 'g')
            .addSelect('COUNT(*)', 'c')
            .where('COALESCE(r.status, \'\') NOT IN (:...draftish)', { draftish: ['draft', 'rejected'] })
            .andWhere('r.primary_sdg_goal IS NOT NULL')
            .andWhere(
                new Brackets((qb) => {
                    qb.where('r."opportunityId"::text IN (:...ids)', idParams).orWhere(
                        '(r.project_id IS NOT NULL AND TRIM(r.project_id) IN (:...ids))',
                        idParams,
                    );
                }),
            )
            .groupBy('r.primary_sdg_goal')
            .getRawMany<{ g: number; c: string }>();

        for (const row of reportSdgRows) {
            const n = Number(row.g);
            if (!Number.isFinite(n) || n < 1 || n > 17) continue;
            const label = `SDG ${n} – ${SDG_SHORT_NAMES[n]}`;
            sdgCounts.set(label, (sdgCounts.get(label) || 0) + Number(row.c));
        }

        const impact_distribution = [...sdgCounts.entries()]
            .map(([name, value]) => ({
                name,
                value,
                color: this.sdgColorForLabel(name),
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 12);

        const avgRow = await this.studentReportsRepository
            .createQueryBuilder('r')
            .select(
                `AVG(CAST(r.section11->>'ai_generated_impact_score' AS double precision))`,
                'avg',
            )
            .where(
                new Brackets((qb) => {
                    qb.where('r."opportunityId"::text IN (:...ids)', idParams).orWhere(
                        '(r.project_id IS NOT NULL AND TRIM(r.project_id) IN (:...ids))',
                        idParams,
                    );
                }),
            )
            .andWhere('COALESCE(r.status, \'\') NOT IN (:...ex)', { ex: ['draft', 'rejected'] })
            .andWhere(`r.section11->>'ai_generated_impact_score' IS NOT NULL`)
            .getRawOne<{ avg: string | null }>();
        const avgImpactScore = Math.round((Number(avgRow?.avg ?? 0) || 0) * 10) / 10;

        return {
            success: true,
            data: {
                university_scope,
                dashboard_view: effectiveView,
                requested_dashboard_view: view,
                faculty_view_modes_available,
                total_students_under_faculty: totalStudents,
                verified_students: verifiedStudents,
                verification_rate_percent: verificationRatePercent,
                individual_participants: individualParticipants,
                team_participants: teamParticipants,
                total_teams: totalTeams,
                average_team_size: averageTeamSize,
                total_required_hours: Math.round(totalRequiredHours * 10) / 10,
                course_linked_ce_ratio_percent: courseLinkedCeRatioPercent,
                hours_verified: hoursVerified,
                projects_completed: projectsCompleted,
                avg_impact_score: avgImpactScore,
                hours_trend,
                impact_distribution,
            },
        };
    }
}

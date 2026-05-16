import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { FacultyAnalyticsQueryDto } from './dto/faculty-analytics-query.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { WORKFLOW_STAGE, LINE_STATUS } from '../opportunities/opportunity-workflow.service';

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
        private readonly opportunitiesService: OpportunitiesService,
    ) {}

    private normalizeFacultyEmail(facultyEmail: string): string {
        return (facultyEmail || '').trim().toLowerCase();
    }

    /** Same source order as `OpportunitiesService.resolvePartnerEmail` (first valid email wins). */
    private resolvedPartnerReviewerEmail(opp: Opportunity): string | null {
        const collab = opp.external_partner_collaboration as { official_email?: string } | undefined;
        const fromCollab =
            collab && typeof collab.official_email === 'string' ? collab.official_email : undefined;
        const sup = opp.supervision as
            | { external_partner_email?: string; partner_email?: string }
            | undefined;
        const fromSupExt = sup && typeof sup.external_partner_email === 'string' ? sup.external_partner_email : undefined;
        const fromSupPartner = sup && typeof sup.partner_email === 'string' ? sup.partner_email : undefined;
        const ctx = opp.executing_context as { partner?: { official_email?: string } } | undefined;
        const fromCtx =
            ctx?.partner && typeof ctx.partner.official_email === 'string' ? ctx.partner.official_email : undefined;
        const po = opp.partner_organization as { official_email?: string } | undefined;
        const fromPo = po && typeof po.official_email === 'string' ? po.official_email : undefined;
        for (const c of [fromCollab, fromSupExt, fromSupPartner, fromCtx, fromPo]) {
            const e = this.normalizeFacultyEmail(c || '');
            if (e && e.includes('@')) {
                return e;
            }
        }
        return null;
    }

    /**
     * Whether this row should use partner approve/reject APIs from the Faculty Hub instead of faculty opportunity APIs.
     */
    private approvalActionForRow(
        opp: Opportunity,
        facultyId: string,
        fe: string,
        delegatedIds: Set<string>,
        reportAwaitingFacultyGate: boolean,
    ): 'faculty_review' | 'partner_ack' {
        if (reportAwaitingFacultyGate) {
            return 'faculty_review';
        }
        const awaitingFacultyOppGate = this.opportunityNeedsFacultyReview(opp);

        const namedSupervisor = this.opportunityMatchesNamedSupervisorPath(opp, facultyId, fe);
        const delegated = delegatedIds.has(opp.id);

        if (awaitingFacultyOppGate && (namedSupervisor || delegated)) {
            return 'faculty_review';
        }

        const resolvedPartner = this.resolvedPartnerReviewerEmail(opp);
        const partnerReviewerMatch = !!fe && !!resolvedPartner && fe === resolvedPartner;
        const partnerAckPending =
            partnerReviewerMatch &&
            (!opp.isStudentCreated || opp.faculty_verified === true) &&
            this.opportunitiesService.isAwaitingPartnerDashboardReview(opp);

        if (partnerAckPending) {
            return 'partner_ack';
        }

        return 'faculty_review';
    }

    private studentLeadReportNeedsFacultyFirst(latestReport: StudentReport | null, creatorId?: string | null): boolean {
        if (!creatorId || !latestReport?.studentId) return false;
        if (latestReport.studentId !== creatorId) return false;
        const st = (latestReport.status || '').trim().toLowerCase();
        if (st === 'draft' || st === 'rejected') return false;
        const fs = latestReport.faculty_status;
        if (fs === null || fs === undefined || fs === 'pending') {
            return true;
        }
        return false;
    }

    private opportunityNeedsFacultyReview(opp: Opportunity): boolean {
        if (!opp.creatorId || opp.faculty_verified || opp.admin_approved) return false;
        if (opp.workflowStage === WORKFLOW_STAGE.LIVE || opp.status === 'active' || opp.status === 'live') return false;
        return (
            opp.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY ||
            opp.status === 'pending_faculty' ||
            opp.status === 'pending_verification' ||
            opp.facultyApprovalStatus === LINE_STATUS.PENDING ||
            opp.faculty_verification_status === WORKFLOW_STAGE.PENDING_FACULTY
        );
    }

    /**
     * Matches the first OR-branch of {@link buildFacultyApprovalsQuery}:
     * assigned faculty, supervision emails, or partner org official contact (same person may be both).
     */
    private opportunityMatchesNamedSupervisorPath(opportunity: Opportunity, facultyId: string, fe: string): boolean {
        if (opportunity.facultyId != null && String(opportunity.facultyId) === String(facultyId)) {
            return true;
        }
        if (!fe) return false;
        const sup = opportunity.supervision as Record<string, unknown> | null | undefined;
        if (sup && typeof sup === 'object') {
            const contact =
                typeof sup.contact === 'string' ? this.normalizeFacultyEmail(sup.contact) : '';
            const official =
                typeof sup.official_email === 'string' ? this.normalizeFacultyEmail(sup.official_email) : '';
            if (contact === fe || official === fe) return true;
        }
        const po = opportunity.partner_organization as Record<string, unknown> | null | undefined;
        if (po && typeof po === 'object') {
            const pe =
                typeof po.official_email === 'string' ? this.normalizeFacultyEmail(po.official_email) : '';
            if (pe === fe) return true;
        }
        return false;
    }

    private approvalVisibilityForRow(
        opportunity: Opportunity,
        facultyId: string,
        facultyEmail: string,
        delegatedIds: Set<string>,
    ): 'named_supervisor' | 'university_scope' | 'both' {
        const fe = this.normalizeFacultyEmail(facultyEmail);
        const named = this.opportunityMatchesNamedSupervisorPath(opportunity, facultyId, fe);
        const uni = delegatedIds.has(opportunity.id);
        if (named && uni) return 'both';
        if (named) return 'named_supervisor';
        if (uni) return 'university_scope';
        return 'named_supervisor';
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
     * Supervision / partner_organization official_email + primary-faculty applications only
     * (no admin-delegated university org expansion).
     */
    private async resolveFacultyPersonalOpportunityIds(facultyId: string, facultyEmail: string): Promise<string[]> {
        const fe = this.normalizeFacultyEmail(facultyEmail);
        const oppQ = this.opportunitiesRepository.createQueryBuilder('o').select('o.id').where(
            new Brackets((qb) => {
                qb.where('"o"."facultyId"::text = :facultyId', { facultyId });
                if (fe) {
                    qb.orWhere(`LOWER(TRIM(COALESCE(o.supervision->>'contact', ''))) = :fe`, { fe })
                        .orWhere(`LOWER(TRIM(COALESCE(o.supervision->>'official_email', ''))) = :fe`, { fe })
                        .orWhere(`LOWER(TRIM(COALESCE(o.partner_organization->>'official_email', ''))) = :fe`, {
                            fe,
                        });
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
                            )
                                .orWhere(
                                    `LOWER(TRIM(COALESCE(opportunity.supervision->>'official_email', ''))) = :fe`,
                                    { fe },
                                )
                                .orWhere(
                                    `LOWER(TRIM(COALESCE(opportunity.partner_organization->>'official_email', ''))) = :fe`,
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
                                        s.where('opportunity.workflowStage = :facultyWorkflow', {
                                            facultyWorkflow: WORKFLOW_STAGE.PENDING_FACULTY,
                                        })
                                            .orWhere('opportunity.status = :pf', { pf: 'pending_faculty' })
                                            .orWhere('opportunity.status = :pv', { pv: 'pending_verification' })
                                            .orWhere('opportunity.facultyApprovalStatus = :facultyLinePending', {
                                                facultyLinePending: LINE_STATUS.PENDING,
                                            })
                                            .orWhere('opportunity.faculty_verification_status = :facultyStatusPending', {
                                                facultyStatusPending: WORKFLOW_STAGE.PENDING_FACULTY,
                                            });
                                    }),
                                )
                                .andWhere('opportunity.faculty_verified = :fvp', { fvp: false })
                                .andWhere(
                                    new Brackets((s) => {
                                        s.where('opportunity.admin_approved = :adminApproved', {
                                            adminApproved: false,
                                        }).orWhere('opportunity.admin_approved IS NULL');
                                    }),
                                )
                                .andWhere(
                                    new Brackets((s) => {
                                        s.where('opportunity.workflowStage IS NULL').orWhere(
                                            'opportunity.workflowStage NOT IN (:...facultyExcludedWorkflows)',
                                            {
                                                facultyExcludedWorkflows: [
                                                    WORKFLOW_STAGE.LIVE,
                                                    WORKFLOW_STAGE.REJECTED,
                                                ],
                                            },
                                        );
                                    }),
                                )
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
                            new Brackets((partnerQ) => {
                                // Browse/join `pending_faculty` applications belong on Faculty → Join applications,
                                // not here (avoids live / faculty-verified listings reappearing as "opportunity" pending).
                                if (!fe) {
                                    partnerQ.where('FALSE');
                                    return;
                                }
                                partnerQ
                                    .where('opportunity.creatorId IS NOT NULL')
                                    .andWhere('opportunity.requiresPartnerApproval = :pReq', { pReq: true })
                                    .andWhere('opportunity.partnerVerified = :pUnv', { pUnv: false })
                                    .andWhere(
                                        new Brackets((facultyCleared) => {
                                            facultyCleared
                                                .where('opportunity.isStudentCreated = :iscLegacy', {
                                                    iscLegacy: false,
                                                })
                                                .orWhere('opportunity.faculty_verified = :fvOk', { fvOk: true });
                                        }),
                                    )
                                    .andWhere(
                                        new Brackets((emOr) => {
                                            emOr.where(
                                                `LOWER(TRIM(COALESCE(opportunity.external_partner_collaboration->>'official_email', ''))) = :fePartner`,
                                                { fePartner: fe },
                                            )
                                                .orWhere(
                                                    `LOWER(TRIM(COALESCE(opportunity.supervision->>'external_partner_email', ''))) = :fePartner`,
                                                    { fePartner: fe },
                                                )
                                                .orWhere(
                                                    `LOWER(TRIM(COALESCE(opportunity.supervision->>'partner_email', ''))) = :fePartner`,
                                                    { fePartner: fe },
                                                )
                                                .orWhere(
                                                    `LOWER(TRIM(COALESCE(opportunity.executing_context->'partner'->>'official_email', ''))) = :fePartner`,
                                                    { fePartner: fe },
                                                )
                                                .orWhere(
                                                    `LOWER(TRIM(COALESCE(opportunity.partner_organization->>'official_email', ''))) = :fePartner`,
                                                    { fePartner: fe },
                                                );
                                        }),
                                    )
                                    .andWhere(
                                        new Brackets((gate) => {
                                            gate.where('opportunity.workflowStage = :pGateWs', {
                                                pGateWs: WORKFLOW_STAGE.PENDING_PARTNER,
                                            })
                                                .orWhere('opportunity.status = :pGateSt1', {
                                                    pGateSt1: 'pending_partner',
                                                })
                                                .orWhere('opportunity.status = :pGateSt2', {
                                                    pGateSt2: 'pending_execution',
                                                })
                                                .orWhere('opportunity.partnerApprovalStatus = :pGatePas', {
                                                    pGatePas: LINE_STATUS.PENDING,
                                                })
                                                .orWhere('opportunity.partnerApprovalStatus IS NULL');
                                        }),
                                    );
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
                    fe
                        ? `NOT EXISTS (
                        SELECT 1 FROM opportunity_applications oa
                        WHERE oa.opportunity_id::text = opportunity.id::text
                          AND oa.withdrawn_at IS NULL
                          AND oa.internal_status = :histOaPendingFac
                          AND LOWER(TRIM(oa.primary_faculty_email)) = :histOaFacultyEmail
                    )`
                        : 'TRUE',
                    fe
                        ? {
                              histOaPendingFac: 'pending_faculty',
                              histOaFacultyEmail: fe,
                          }
                        : {},
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

    private facultyAnalyticsUtcEndOfDay(iso: string): Date {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return d;
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
    }

    private facultyAnalyticsParticipationDimensionFiltersActive(query: FacultyAnalyticsQueryDto): boolean {
        return Boolean(
            query.degree_program?.trim() ||
                query.year_of_study?.trim() ||
                query.academic_integration_type?.trim() ||
                query.participation_type?.trim() ||
                query.verification_status ||
                query.period_start?.trim() ||
                query.period_end?.trim(),
        );
    }

    private facultyAnalyticsAnyFilterActive(query?: FacultyAnalyticsQueryDto): boolean {
        if (!query) return false;
        return Object.entries(query).some(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
    }

    private compactFacultyAnalyticsFilterParams(query: FacultyAnalyticsQueryDto): Record<string, string> {
        const out: Record<string, string> = {};
        const keys = [
            'project_id',
            'course_section',
            'degree_program',
            'year_of_study',
            'academic_integration_type',
            'participation_type',
            'verification_status',
            'period_start',
            'period_end',
        ] as const;
        for (const k of keys) {
            const raw = query[k];
            if (raw === undefined || raw === null) continue;
            const s = String(raw).trim();
            if (s !== '') out[k] = s;
        }
        return out;
    }

    private async narrowFacultyAnalyticsOpportunityIds(
        scopedIds: string[],
        query?: FacultyAnalyticsQueryDto,
    ): Promise<string[]> {
        if (!scopedIds.length) return [];
        const pid = query?.project_id?.trim();
        if (pid) {
            return scopedIds.includes(pid) ? [pid] : [];
        }
        const cs = query?.course_section?.trim();
        if (!cs) return scopedIds;
        const opps = await this.opportunitiesRepository.find({
            where: { id: In(scopedIds) },
            select: ['id', 'title', 'academic_linkage'],
        });
        const lower = cs.toLowerCase();
        return opps
            .filter((o) => {
                const code = this.pickCourseCode(o)?.toLowerCase() ?? '';
                const sem = this.pickSemester(o)?.toLowerCase() ?? '';
                const title = (o.title || '').toLowerCase();
                return code.includes(lower) || sem.includes(lower) || title.includes(lower);
            })
            .map((o) => o.id);
    }

    private applyFacultyAnalyticsParticipationFilters(
        qb: SelectQueryBuilder<Participation>,
        query?: FacultyAnalyticsQueryDto,
        userAlias?: string,
    ): void {
        if (!query) return;
        if (query.degree_program?.trim()) {
            qb.andWhere('TRIM(COALESCE(p.academicProgram, \'\')) = :fafDeg', {
                fafDeg: query.degree_program.trim(),
            });
        }
        if (query.year_of_study?.trim()) {
            qb.andWhere('p.yearOfStudy = :fafYos', { fafYos: query.year_of_study.trim() });
        }
        if (query.academic_integration_type?.trim()) {
            qb.andWhere('p.academicIntegrationType = :fafAit', {
                fafAit: query.academic_integration_type.trim(),
            });
        }
        if (query.participation_type?.trim()) {
            qb.andWhere('LOWER(TRIM(CAST(p.participationMode AS text))) = :fafPm', {
                fafPm: query.participation_type.trim().toLowerCase(),
            });
        }
        if (query.period_start?.trim()) {
            const ps = new Date(query.period_start.trim());
            if (!Number.isNaN(ps.getTime())) qb.andWhere('p.createdAt >= :fafPs', { fafPs: ps });
        }
        if (query.period_end?.trim()) {
            const pe = this.facultyAnalyticsUtcEndOfDay(query.period_end.trim());
            if (!Number.isNaN(pe.getTime())) qb.andWhere('p.createdAt <= :fafPe', { fafPe: pe });
        }
        if (userAlias && query.verification_status === 'verified') {
            qb.andWhere(
                `${userAlias}.profile_verified = true AND ${userAlias}.identity_verified = true`,
            );
        } else if (userAlias && query.verification_status === 'unverified') {
            qb.andWhere(
                `(COALESCE(${userAlias}.profile_verified, false) = false OR COALESCE(${userAlias}.identity_verified, false) = false)`,
            );
        }
    }

    private appendFacultyTimesheetParticipationFilters(
        qb: SelectQueryBuilder<Timesheet>,
        timesheetAlias: string,
        oppIds: string[],
        st: readonly string[],
        query?: FacultyAnalyticsQueryDto,
    ): void {
        if (!query || !this.facultyAnalyticsParticipationDimensionFiltersActive(query)) return;
        const subParams: Record<string, unknown> = {
            ftsOpp: oppIds,
            ftsSt: [...st],
        };
        let sql = `
      EXISTS (
        SELECT 1 FROM participations p
        INNER JOIN users u ON u.id = p.student_id
        WHERE p.project_id = ${timesheetAlias}."opportunityId"
        AND p.student_id = ${timesheetAlias}."studentId"
        AND p.project_id IN (:...ftsOpp)
        AND p.status IN (:...ftsSt)
        AND p.student_id IS NOT NULL
    `;
        if (query.degree_program?.trim()) {
            sql += ` AND TRIM(COALESCE(p.academicProgram, '')) = :ftsDeg`;
            subParams.ftsDeg = query.degree_program.trim();
        }
        if (query.year_of_study?.trim()) {
            sql += ` AND p.yearOfStudy = :ftsYos`;
            subParams.ftsYos = query.year_of_study.trim();
        }
        if (query.academic_integration_type?.trim()) {
            sql += ` AND p.academicIntegrationType = :ftsAit`;
            subParams.ftsAit = query.academic_integration_type.trim();
        }
        if (query.participation_type?.trim()) {
            sql += ` AND LOWER(TRIM(CAST(p.participationMode AS text))) = :ftsPm`;
            subParams.ftsPm = query.participation_type.trim().toLowerCase();
        }
        if (query.period_start?.trim()) {
            const ps = new Date(query.period_start.trim());
            if (!Number.isNaN(ps.getTime())) {
                sql += ` AND p.createdAt >= :ftsPs`;
                subParams.ftsPs = ps;
            }
        }
        if (query.period_end?.trim()) {
            const pe = this.facultyAnalyticsUtcEndOfDay(query.period_end.trim());
            if (!Number.isNaN(pe.getTime())) {
                sql += ` AND p.createdAt <= :ftsPe`;
                subParams.ftsPe = pe;
            }
        }
        if (query.verification_status === 'verified') {
            sql += ` AND u.profile_verified = true AND u.identity_verified = true`;
        } else if (query.verification_status === 'unverified') {
            sql += ` AND (COALESCE(u.profile_verified, false) = false OR COALESCE(u.identity_verified, false) = false)`;
        }
        sql += ')';
        qb.andWhere(sql, subParams);
    }

    private appendFacultyReportParticipationFilters(
        qb: SelectQueryBuilder<StudentReport>,
        reportAlias: string,
        oppIds: string[],
        st: readonly string[],
        query?: FacultyAnalyticsQueryDto,
    ): void {
        if (!query || !this.facultyAnalyticsParticipationDimensionFiltersActive(query)) return;
        const subParams: Record<string, unknown> = {
            frOpp: oppIds,
            frSt: [...st],
        };
        let sql = `
      EXISTS (
        SELECT 1 FROM participations p
        INNER JOIN users u ON u.id = p.student_id
        WHERE p.student_id = ${reportAlias}.studentId
        AND (
          (${reportAlias}."opportunityId" IS NOT NULL AND ${reportAlias}."opportunityId"::text = p.project_id)
          OR (${reportAlias}.project_id IS NOT NULL AND TRIM(${reportAlias}.project_id) = p.project_id)
        )
        AND p.project_id IN (:...frOpp)
        AND p.status IN (:...frSt)
        AND p.student_id IS NOT NULL
    `;
        if (query.degree_program?.trim()) {
            sql += ` AND TRIM(COALESCE(p.academicProgram, '')) = :frDeg`;
            subParams.frDeg = query.degree_program.trim();
        }
        if (query.year_of_study?.trim()) {
            sql += ` AND p.yearOfStudy = :frYos`;
            subParams.frYos = query.year_of_study.trim();
        }
        if (query.academic_integration_type?.trim()) {
            sql += ` AND p.academicIntegrationType = :frAit`;
            subParams.frAit = query.academic_integration_type.trim();
        }
        if (query.participation_type?.trim()) {
            sql += ` AND LOWER(TRIM(CAST(p.participationMode AS text))) = :frPm`;
            subParams.frPm = query.participation_type.trim().toLowerCase();
        }
        if (query.period_start?.trim()) {
            const ps = new Date(query.period_start.trim());
            if (!Number.isNaN(ps.getTime())) {
                sql += ` AND p.createdAt >= :frPs`;
                subParams.frPs = ps;
            }
        }
        if (query.period_end?.trim()) {
            const pe = this.facultyAnalyticsUtcEndOfDay(query.period_end.trim());
            if (!Number.isNaN(pe.getTime())) {
                sql += ` AND p.createdAt <= :frPe`;
                subParams.frPe = pe;
            }
        }
        if (query.verification_status === 'verified') {
            sql += ` AND u.profile_verified = true AND u.identity_verified = true`;
        } else if (query.verification_status === 'unverified') {
            sql += ` AND (COALESCE(u.profile_verified, false) = false OR COALESCE(u.identity_verified, false) = false)`;
        }
        sql += ')';
        qb.andWhere(sql, subParams);
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
        const delegatedSet = new Set(delegatedOppIds);
        const query = this.buildFacultyApprovalsQuery(facultyId, facultyEmail, status, delegatedOppIds);
        const opportunities = await query.orderBy('opportunity.createdAt', 'DESC').getMany();

        const formatted = await Promise.all(
            opportunities.map(async (opp) => {
                const approvalVisibility = this.approvalVisibilityForRow(opp, facultyId, facultyEmail, delegatedSet);
                const normalizedEmail = this.normalizeFacultyEmail(facultyEmail);
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
                const reportAwaitingFaculty = this.studentLeadReportNeedsFacultyFirst(latestReport, opp.creatorId);
                const approval_action = this.approvalActionForRow(
                    opp,
                    facultyId,
                    normalizedEmail,
                    delegatedSet,
                    reportAwaitingFaculty,
                );
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
                    approvalVisibility,
                    approval_visibility: approvalVisibility,
                    approval_action,
                    approvalAction: approval_action,
                };
            }),
        );

        return {
            success: true,
            data: formatted,
            meta: {
                has_university_scope: delegatedOppIds.length > 0,
                delegated_opportunity_count: delegatedOppIds.length,
            },
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
     * Optional query params narrow metrics (AND); scope remains faculty-assigned opportunities only.
     */
    async getImpactAnalytics(
        facultyId: string,
        facultyEmail: string,
        view: FacultyDashboardViewMode = 'combined',
        query?: FacultyAnalyticsQueryDto,
    ) {
        const { university_scope, effectiveView, scopedIds, faculty_view_modes_available } =
            await this.resolveFacultyScopedContext(facultyId, facultyEmail, view);

        const filter_meta =
            query && this.facultyAnalyticsAnyFilterActive(query)
                ? { active: true as const, params: this.compactFacultyAnalyticsFilterParams(query) }
                : { active: false as const };

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
            filter_meta,
        });

        if (scopedIds.length === 0) {
            return { success: true, data: buildEmpty() };
        }

        const oppIds = await this.narrowFacultyAnalyticsOpportunityIds(scopedIds, query);
        if (oppIds.length === 0) {
            return { success: true, data: buildEmpty() };
        }

        const idParams = { ids: oppIds };
        const st = [...ACTIVE_PARTICIPATION_STATUSES];
        const partDimActive = Boolean(query && this.facultyAnalyticsParticipationDimensionFiltersActive(query));

        const totalStudentsQb = this.participationRepository
            .createQueryBuilder('p')
            .innerJoin('users', 'u', 'u.id = p.student_id')
            .select('COUNT(DISTINCT p.student_id)', 'cnt')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st })
            .andWhere('p.student_id IS NOT NULL');
        this.applyFacultyAnalyticsParticipationFilters(totalStudentsQb, query, 'u');
        const totalStudents = Number((await totalStudentsQb.getRawOne<{ cnt: string }>())?.cnt ?? 0) || 0;

        const verifiedRowQb = this.participationRepository
            .createQueryBuilder('p')
            .innerJoin('users', 'u', 'u.id = p.student_id')
            .select('COUNT(DISTINCT p.student_id)', 'cnt')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st })
            .andWhere('p.student_id IS NOT NULL')
            .andWhere('u.profile_verified = true')
            .andWhere('u.identity_verified = true');
        this.applyFacultyAnalyticsParticipationFilters(verifiedRowQb, query, 'u');
        const verifiedStudents =
            Number((await verifiedRowQb.getRawOne<{ cnt: string }>())?.cnt ?? 0) || 0;

        const verificationRatePercent =
            totalStudents === 0 ? 0 : Math.round((100 * verifiedStudents) / totalStudents);

        const participationsQb = this.participationRepository
            .createQueryBuilder('p')
            .innerJoin('users', 'u', 'u.id = p.student_id')
            .leftJoinAndSelect('p.project', 'proj')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st })
            .andWhere('p.student_id IS NOT NULL');
        this.applyFacultyAnalyticsParticipationFilters(participationsQb, query, 'u');
        const participations = await participationsQb.getMany();

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

        const ceStudentsRowQb = this.participationRepository
            .createQueryBuilder('p')
            .innerJoin('users', 'u', 'u.id = p.student_id')
            .select('COUNT(DISTINCT p.student_id)', 'cnt')
            .where('p.project_id IN (:...ids)', idParams)
            .andWhere('p.status IN (:...st)', { st })
            .andWhere('p.student_id IS NOT NULL')
            .andWhere('p.academicIntegrationType IN (:...ce)', { ce: [...COURSE_LINKED_ACADEMIC_TYPES] });
        this.applyFacultyAnalyticsParticipationFilters(ceStudentsRowQb, query, 'u');
        const ceStudentCount =
            Number((await ceStudentsRowQb.getRawOne<{ cnt: string }>())?.cnt ?? 0) || 0;
        const courseLinkedCeRatioPercent =
            totalStudents === 0 ? 0 : Math.round((100 * ceStudentCount) / totalStudents);

        const hoursRowQb = this.timesheetsRepository
            .createQueryBuilder('t')
            .select('COALESCE(SUM(t.hours), 0)', 'sum')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams);
        this.appendFacultyTimesheetParticipationFilters(hoursRowQb, 't', oppIds, st, query);
        const hoursVerified = Number((await hoursRowQb.getRawOne<{ sum: string }>())?.sum ?? 0) || 0;

        const projectsCompletedRowQb = this.timesheetsRepository
            .createQueryBuilder('t')
            .select('COUNT(DISTINCT t.opportunityId)', 'cnt')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams);
        this.appendFacultyTimesheetParticipationFilters(projectsCompletedRowQb, 't', oppIds, st, query);
        const projectsCompleted =
            Number((await projectsCompletedRowQb.getRawOne<{ cnt: string }>())?.cnt ?? 0) || 0;

        const trendRowsQb = this.timesheetsRepository
            .createQueryBuilder('t')
            .select(`date_trunc('month', t."updatedAt")`, 'bucket')
            .addSelect('SUM(t.hours)', 'hours')
            .where('t.status = :vs', { vs: 'verified' })
            .andWhere('t.opportunityId IN (:...ids)', idParams)
            .andWhere(`t."updatedAt" >= NOW() - INTERVAL '13 months'`);
        this.appendFacultyTimesheetParticipationFilters(trendRowsQb, 't', oppIds, st, query);
        const trendRows = await trendRowsQb.groupBy('bucket').orderBy('bucket', 'ASC').getRawMany<{
            bucket: Date;
            hours: string;
        }>();

        const hours_trend = trendRows.map((row) => {
            const d = row.bucket instanceof Date ? row.bucket : new Date(row.bucket);
            const label = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
            return { label, hours: Number(row.hours) || 0 };
        });

        let oppIdsForSdg = oppIds;
        if (partDimActive) {
            const sdgScopeQb = this.participationRepository
                .createQueryBuilder('p')
                .innerJoin('users', 'u', 'u.id = p.student_id')
                .select('DISTINCT p.project_id', 'pid')
                .where('p.project_id IN (:...ids)', idParams)
                .andWhere('p.status IN (:...st)', { st })
                .andWhere('p.student_id IS NOT NULL');
            this.applyFacultyAnalyticsParticipationFilters(sdgScopeQb, query, 'u');
            const rawPid = await sdgScopeQb.getRawMany<{ pid: string }>();
            oppIdsForSdg = rawPid.map((r) => r.pid).filter(Boolean);
        }

        const oppsForSdg =
            oppIdsForSdg.length > 0
                ? await this.opportunitiesRepository.find({
                      where: { id: In(oppIdsForSdg) },
                      select: ['id', 'sdg', 'sdg_info'],
                  })
                : [];
        const sdgCounts = new Map<string, number>();
        for (const o of oppsForSdg) {
            const label = this.formatSdgLabel(o);
            sdgCounts.set(label, (sdgCounts.get(label) || 0) + 1);
        }

        const reportSdgQb = this.studentReportsRepository
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
            );
        this.appendFacultyReportParticipationFilters(reportSdgQb, 'r', oppIds, st, query);
        const reportSdgRows = await reportSdgQb.groupBy('r.primary_sdg_goal').getRawMany<{ g: number; c: string }>();

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

        const avgRowQb = this.studentReportsRepository
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
            .andWhere(`r.section11->>'ai_generated_impact_score' IS NOT NULL`);
        this.appendFacultyReportParticipationFilters(avgRowQb, 'r', oppIds, st, query);
        const avgRow = await avgRowQb.getRawOne<{ avg: string | null }>();
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
                filter_meta,
            },
        };
    }
}

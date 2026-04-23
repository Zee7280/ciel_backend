import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';
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

type ActivityRow = {
    title: string;
    description: string | null;
    created_at: string;
    sortAt: number;
};

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
    ) {}

    private normalizeFacultyEmail(facultyEmail: string): string {
        return (facultyEmail || '').trim().toLowerCase();
    }

    /**
     * Opportunities this faculty supervises (assigned id or supervision emails),
     * plus any listing id appearing on a non-withdrawn application where this faculty is primary.
     */
    private async resolveFacultyScopedOpportunityIds(facultyId: string, facultyEmail: string): Promise<string[]> {
        const fe = this.normalizeFacultyEmail(facultyEmail);
        const oppQ = this.opportunitiesRepository.createQueryBuilder('o').select('o.id').where(
            new Brackets((qb) => {
                qb.where('o.facultyId = :facultyId', { facultyId });
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

    private buildFacultyApprovalsQuery(
        facultyId: string,
        facultyEmail: string,
        status?: string,
    ): SelectQueryBuilder<Opportunity> {
        const fe = this.normalizeFacultyEmail(facultyEmail);

        const query = this.opportunitiesRepository
            .createQueryBuilder('opportunity')
            .where(
                new Brackets((qb) => {
                    qb.where('opportunity.facultyId = :facultyId', { facultyId });
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
                                app.where('opportunity.creatorId IS NOT NULL').andWhere(
                                    `EXISTS (
                                        SELECT 1 FROM opportunity_applications oa
                                        WHERE oa.opportunity_id::text = opportunity.id::text
                                          AND oa.student_user_id::text = opportunity."creatorId"::text
                                          AND oa.withdrawn_at IS NULL
                                          AND oa.internal_status = :oaPendingFac
                                          AND (
                                            :oaEmailFilterOff = true
                                            OR LOWER(TRIM(oa.primary_faculty_email)) = :oaFacultyEmail
                                          )
                                    )`,
                                    {
                                        oaPendingFac: 'pending_faculty',
                                        oaEmailFilterOff: !fe,
                                        oaFacultyEmail: fe,
                                    },
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
                    `NOT EXISTS (
                        SELECT 1 FROM opportunity_applications oa
                        WHERE oa.opportunity_id::text = opportunity.id::text
                          AND oa.student_user_id::text = opportunity."creatorId"::text
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
        const fe = this.normalizeFacultyEmail(facultyEmail);
        const opportunity = await this.opportunitiesRepository
            .createQueryBuilder('opportunity')
            .leftJoinAndSelect('opportunity.organization', 'organization')
            .where('opportunity.id = :opportunityId', { opportunityId })
            .andWhere(
                new Brackets((qb) => {
                    qb.where('opportunity.facultyId = :facultyId', { facultyId });
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
            )
            .getOne();

        if (!opportunity) {
            throw new NotFoundException('Project not found or not assigned to you');
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
        const query = this.buildFacultyApprovalsQuery(facultyId, facultyEmail, status);
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

    async getDashboard(facultyId: string, facultyEmail: string) {
        const user = await this.usersRepository.findOne({ where: { id: facultyId } });
        if (!user || user.role !== UserRole.FACULTY) {
            throw new ForbiddenException('Only faculty can access this dashboard');
        }

        const scopedIds = await this.resolveFacultyScopedOpportunityIds(facultyId, facultyEmail);
        const pendingApprovals = await this.buildFacultyApprovalsQuery(facultyId, facultyEmail, 'pending').getCount();

        if (scopedIds.length === 0) {
            return {
                success: true,
                data: {
                    students_active: 0,
                    hours_verified: 0,
                    pending_approvals: pendingApprovals,
                    courses: [],
                    hours_trend: [],
                    impact_distribution: [],
                    recent_activity: [],
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
                    qb.where('r.opportunityId IN (:...ids)', idParams).orWhere(
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
                            qb.where('r.opportunityId = :oid', { oid: opp.id }).orWhere(
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

        const activities: ActivityRow[] = [];

        const reportEvents = await this.studentReportsRepository
            .createQueryBuilder('r')
            .leftJoinAndSelect('r.opportunity', 'o')
            .leftJoinAndSelect('r.student', 'stu')
            .where(
                new Brackets((qb) => {
                    qb.where('r.opportunityId IN (:...ids)', idParams).orWhere(
                        '(r.project_id IS NOT NULL AND TRIM(r.project_id) IN (:...ids))',
                        idParams,
                    );
                }),
            )
            .andWhere('COALESCE(r.status, \'\') NOT IN (:...ex)', { ex: ['draft'] })
            .orderBy('COALESCE(r.reportSubmittedAt, r.submission_date, r.updatedAt)', 'DESC')
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
                students_active: studentsActive,
                hours_verified: hoursVerified,
                pending_approvals: pendingApprovals,
                courses,
                hours_trend,
                impact_distribution,
                recent_activity,
            },
        };
    }
}

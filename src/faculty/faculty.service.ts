import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { StudentReport } from '../reports/entities/student-report.entity';

@Injectable()
export class FacultyService {
    constructor(
        @InjectRepository(Opportunity)
        private readonly opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
        @InjectRepository(StudentReport)
        private readonly studentReportsRepository: Repository<StudentReport>,
    ) { }

    async getProjectDetail(facultyId: string, facultyEmail: string, opportunityId: string) {
        const fe = (facultyEmail || '').trim().toLowerCase();
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
                        )
                            .orWhere(
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
        const fe = (facultyEmail || '').trim().toLowerCase();

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

        // Pending: still waiting on faculty/liaison action (email or dashboard), OR a submitted
        // impact report on the student's opportunity that still needs faculty verification — even
        // when the opportunity workflow is already `live` / `active`.
        if (status === 'pending' || status === undefined || status === '') {
            query.andWhere(
                new Brackets((outer) => {
                    outer
                        .where(
                            new Brackets((early) => {
                                // Student / liaison proposals only (not org-owned postings where facultyId matches).
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
                                    // liaisonVerified can be NULL on older rows; NULL must still count as "not liaison-approved"
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
                        // Browse/join flow: row stays in opportunity_applications as pending_faculty while
                        // the opportunity itself may already be live — faculty must still see it under Pending.
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
            // Student-originated proposals this faculty supervised, after liaison/faculty step or further along.
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
                // Keep submitted reports that still need faculty verification in Pending, not History.
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

        const opportunities = await query.orderBy('opportunity.createdAt', 'DESC').getMany();

        // Format according to user request
        const formatted = await Promise.all(opportunities.map(async (opp) => {
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
            const metrics = (latestReport?.section1 as { metrics?: { total_verified_hours?: number; eis_score?: number } } | undefined)
                ?.metrics;
            const totalHours = Number(metrics?.total_verified_hours ?? 0) || 0;
            const eisScore = Number(metrics?.eis_score ?? 0) || 0;
            const impactScore = Number(
                (latestReport?.section11 as { ai_generated_impact_score?: number } | undefined)?.ai_generated_impact_score ?? 0,
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
                sdg: opp.sdg || (opp.sdg_info?.sdg_id) || 'N/A',
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
        }));

        return {
            success: true,
            data: formatted
        };
    }
}

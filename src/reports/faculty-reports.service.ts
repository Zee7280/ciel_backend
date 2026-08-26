import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, SelectQueryBuilder, WhereExpressionBuilder } from 'typeorm';
import { StudentReport } from './entities/student-report.entity';
import { StudentReportsService } from './student-reports.service';
import { FacultyService } from '../faculty/faculty.service';

@Injectable()
export class FacultyReportsService {
    constructor(
        @InjectRepository(StudentReport)
        private studentReportsRepository: Repository<StudentReport>,
        private readonly studentReportsService: StudentReportsService,
        private readonly facultyService: FacultyService,
    ) {}

    private normalizeFacultyEmail(facultyEmail: string): string {
        return (facultyEmail || '').trim().toLowerCase();
    }

    /**
     * Align report visibility with faculty dashboard / approvals scope:
     * UUID assignment, scoped opportunities, supervision emails, applications, participations.
     */
    private applyFacultyAccessFilter(
        qb: WhereExpressionBuilder,
        facultyId: string,
        facultyEmail: string,
        scopedOpportunityIds: string[],
    ) {
        const fe = this.normalizeFacultyEmail(facultyEmail);

        qb.where('report.facultyId = :facultyId', { facultyId }).orWhere(
            'opportunity.facultyId = :facultyId',
            { facultyId },
        );

        if (scopedOpportunityIds.length > 0) {
            qb.orWhere('report."opportunityId"::text IN (:...scopedOppIds)', {
                scopedOppIds: scopedOpportunityIds,
            }).orWhere(`TRIM(COALESCE(report.project_id, '')) IN (:...scopedOppIds)`, {
                scopedOppIds: scopedOpportunityIds,
            });
        }

        if (!fe) {
            return;
        }

        qb.orWhere(
            `LOWER(TRIM(COALESCE(report.section1->>'faculty_supervisor_email', ''))) = :fe`,
            { fe },
        )
            .orWhere(
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
            )
            .orWhere(
                `EXISTS (
                    SELECT 1 FROM participations p
                    WHERE (
                        p.project_id::text = report."opportunityId"::text
                        OR p.project_id::text = TRIM(COALESCE(report.project_id, ''))
                    )
                    AND (
                        LOWER(TRIM(COALESCE(p."facultySupervisorEmail", ''))) = :fe
                        OR LOWER(TRIM(COALESCE(p."primaryFacultyEmail", ''))) = :fe
                        OR LOWER(TRIM(COALESCE(p."secondaryFacultyEmail", ''))) = :fe
                    )
                )`,
                { fe },
            )
            .orWhere(
                `EXISTS (
                    SELECT 1 FROM opportunity_applications app
                    WHERE app.opportunity_id::text = report."opportunityId"::text
                    AND app.withdrawn_at IS NULL
                    AND (
                        LOWER(TRIM(COALESCE(app.primary_faculty_email, ''))) = :fe
                        OR LOWER(TRIM(COALESCE(app.secondary_faculty_email, ''))) = :fe
                    )
                )`,
                { fe },
            );
    }

    private baseReportQuery(): SelectQueryBuilder<StudentReport> {
        return this.studentReportsRepository
            .createQueryBuilder('report')
            .leftJoinAndSelect('report.student', 'student')
            .leftJoinAndSelect('report.opportunity', 'opportunity')
            .leftJoinAndSelect('opportunity.organization', 'organization');
    }

    async listAssignedReports(facultyId: string, facultyEmail: string) {
        const scopedOpportunityIds = await this.facultyService.getScopedOpportunityIds(
            facultyId,
            facultyEmail,
        );

        const reports = await this.baseReportQuery()
            .where(
                new Brackets((qb) =>
                    this.applyFacultyAccessFilter(
                        qb,
                        facultyId,
                        facultyEmail,
                        scopedOpportunityIds,
                    ),
                ),
            )
            .andWhere('report.admin_status = :adminApproved', { adminApproved: 'approved' })
            .orderBy('report.submission_date', 'DESC')
            .getMany();

        return reports;
    }

    async findAll(facultyId: string, facultyEmail: string) {
        const reports = await this.listAssignedReports(facultyId, facultyEmail);

        return {
            success: true,
            data: reports.map((r) => ({
                id: r.id,
                student_name: r.student?.name || 'Unknown',
                student_email: r.student?.email || 'Unknown',
                project_title: r.opportunity?.title || r.project_id,
                organization_name: r.opportunity?.organization?.name || 'N/A',
                status: r.status,
                faculty_status: r.faculty_status,
                hours: Number(r.section1?.metrics?.total_verified_hours ?? 0) || 0,
                submission_date: r.submission_date,
                report_submitted_at: r.reportSubmittedAt,
                partner_approved_at: r.partnerApprovedAt,
                admin_approved_at: r.adminApprovedAt,
                metrics: r.section1?.metrics,
            })),
        };
    }

    async findOne(id: string, facultyId: string, facultyEmail: string) {
        const scopedOpportunityIds = await this.facultyService.getScopedOpportunityIds(
            facultyId,
            facultyEmail,
        );

        const report = await this.baseReportQuery()
            .where('report.id = :id', { id })
            .andWhere(
                new Brackets((qb) =>
                    this.applyFacultyAccessFilter(
                        qb,
                        facultyId,
                        facultyEmail,
                        scopedOpportunityIds,
                    ),
                ),
            )
            .andWhere('report.admin_status = :adminApproved', { adminApproved: 'approved' })
            .getOne();

        if (!report) {
            throw new NotFoundException(
                'Report not found, not assigned to you, or not yet approved by CIEL Admin',
            );
        }

        return this.studentReportsService.buildDetailResponse(report);
    }

    async updateAction(
        id: string,
        facultyId: string,
        facultyEmail: string,
        status: 'approved' | 'rejected',
        remarks?: string,
    ) {
        const scopedOpportunityIds = await this.facultyService.getScopedOpportunityIds(
            facultyId,
            facultyEmail,
        );

        const report = await this.studentReportsRepository
            .createQueryBuilder('report')
            .leftJoin('report.opportunity', 'opportunity')
            .where('report.id = :id', { id })
            .andWhere(
                new Brackets((qb) =>
                    this.applyFacultyAccessFilter(
                        qb,
                        facultyId,
                        facultyEmail,
                        scopedOpportunityIds,
                    ),
                ),
            )
            .andWhere('report.admin_status = :adminApproved', { adminApproved: 'approved' })
            .getOne();

        if (!report) {
            throw new NotFoundException(
                'Report not found, not assigned to you, or not yet approved by CIEL Admin',
            );
        }

        report.faculty_status = status;
        if (remarks) {
            report.faculty_remarks = remarks;
        }

        await this.studentReportsRepository.save(report);

        return {
            success: true,
            message: `Report ${status} successfully.`,
            data: {
                id: report.id,
                faculty_status: report.faculty_status,
            },
        };
    }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, WhereExpressionBuilder } from 'typeorm';
import { StudentReport } from './entities/student-report.entity';
import { StudentReportsService } from './student-reports.service';

@Injectable()
export class FacultyReportsService {
    constructor(
        @InjectRepository(StudentReport)
        private studentReportsRepository: Repository<StudentReport>,
        private readonly studentReportsService: StudentReportsService,
    ) { }

    private applyFacultyAccessFilter(qb: WhereExpressionBuilder, facultyId: string) {
        qb.where('report.facultyId = :facultyId', { facultyId }).orWhere(
            'opportunity.facultyId = :facultyId',
            { facultyId },
        );
    }

    async findAll(facultyId: string) {
        const reports = await this.studentReportsRepository
            .createQueryBuilder('report')
            .leftJoinAndSelect('report.student', 'student')
            .leftJoinAndSelect('report.opportunity', 'opportunity')
            .leftJoinAndSelect('opportunity.organization', 'organization')
            .where(new Brackets((qb) => this.applyFacultyAccessFilter(qb, facultyId)))
            .orderBy('report.submission_date', 'DESC')
            .getMany();

        return {
            success: true,
            data: reports.map(r => ({
                id: r.id,
                student_name: r.student?.name || 'Unknown',
                student_email: r.student?.email || 'Unknown',
                project_title: r.opportunity?.title || r.project_id,
                organization_name: r.opportunity?.organization?.name || 'N/A',
                status: r.status,
                faculty_status: r.faculty_status,
                submission_date: r.submission_date,
                report_submitted_at: r.reportSubmittedAt,
                partner_approved_at: r.partnerApprovedAt,
                admin_approved_at: r.adminApprovedAt,
                metrics: r.section1?.metrics,
            })),
        };
    }

    async findOne(id: string, facultyId: string) {
        const report = await this.studentReportsRepository
            .createQueryBuilder('report')
            .leftJoinAndSelect('report.student', 'student')
            .leftJoinAndSelect('report.opportunity', 'opportunity')
            .leftJoinAndSelect('opportunity.organization', 'organization')
            .where('report.id = :id', { id })
            .andWhere(new Brackets((qb) => this.applyFacultyAccessFilter(qb, facultyId)))
            .getOne();

        if (!report) {
            throw new NotFoundException('Report not found or not assigned to you');
        }

        return this.studentReportsService.buildDetailResponse(report);
    }

    async updateAction(id: string, facultyId: string, status: 'approved' | 'rejected', remarks?: string) {
        const report = await this.studentReportsRepository
            .createQueryBuilder('report')
            .leftJoin('report.opportunity', 'opportunity')
            .where('report.id = :id', { id })
            .andWhere(new Brackets((qb) => this.applyFacultyAccessFilter(qb, facultyId)))
            .getOne();

        if (!report) {
            throw new NotFoundException('Report not found or not assigned to you');
        }

        report.faculty_status = status;
        if (remarks) {
            report.faculty_remarks = remarks;
        }

        // If faculty approves, we might want to update the overall status if institutional approval is a blocker
        // For now, we just update the faculty_status fields as per plan.
        
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

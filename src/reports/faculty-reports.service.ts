import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StudentReport } from './entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';

@Injectable()
export class FacultyReportsService {
    constructor(
        @InjectRepository(StudentReport)
        private studentReportsRepository: Repository<StudentReport>,
        @InjectRepository(AttendanceLog)
        private readonly attendanceLogsRepository: Repository<AttendanceLog>,
    ) { }

    async findAll(facultyId: string) {
        const reports = await this.studentReportsRepository.find({
            where: { facultyId },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { submission_date: 'DESC' },
        });

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
                metrics: r.section1?.metrics,
            })),
        };
    }

    async findOne(id: string, facultyId: string) {
        const report = await this.studentReportsRepository.findOne({
            where: { id, facultyId },
            relations: ['student', 'opportunity', 'opportunity.organization'],
        });

        if (!report) {
            throw new NotFoundException('Report not found or not assigned to you');
        }

        // Fetch attendance logs for this student and opportunity for complete review context
        const attendanceLogs = await this.attendanceLogsRepository.find({
            where: {
                participant: { userId: report.studentId },
                projectId: report.opportunityId || report.project_id
            },
            order: { dateOfEngagement: 'ASC', startTime: 'ASC' }
        });

        return {
            success: true,
            data: {
                ...report,
                attendance_logs: attendanceLogs.map(log => ({
                    id: log.id,
                    date: log.dateOfEngagement,
                    start_time: log.startTime,
                    end_time: log.endTime,
                    location: log.organizationName,
                    activity_type: log.activityType,
                    description: log.description,
                    hours: Number(log.sessionHours),
                    evidence_url: log.evidenceUrl,
                    entryStatus: log.entryStatus
                }))
            }
        };
    }

    async updateAction(id: string, facultyId: string, status: 'approved' | 'rejected', remarks?: string) {
        const report = await this.studentReportsRepository.findOne({
            where: { id, facultyId },
        });

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

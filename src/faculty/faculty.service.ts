import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

    async getProjectDetail(facultyId: string, opportunityId: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId, facultyId },
            relations: ['organization'],
        });

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
                    student_name: r.student?.name || 'Unknown',
                    student_email: r.student?.email || 'Unknown',
                })),
            },
        };
    }

    async getApprovals(facultyId: string, status?: string) {
        // Map frontend status to backend status
        let dbStatus = status;
        if (status === 'pending') {
            dbStatus = 'pending_verification';
        }

        const query = this.opportunitiesRepository.createQueryBuilder('opportunity')
            .where('opportunity.facultyId = :facultyId', { facultyId });

        if (dbStatus) {
            query.andWhere('opportunity.status = :status', { status: dbStatus });
        }

        const opportunities = await query.getMany();

        // Format according to user request
        const formatted = await Promise.all(opportunities.map(async (opp) => {
            const student = await this.usersRepository.findOne({ where: { id: opp.creatorId } });
            
            return {
                id: opp.id,
                projectTitle: opp.title,
                studentName: student?.name || 'Unknown Student',
                studentId: student?.registrationNumber || student?.id || 'N/A',
                submittedDate: opp.createdAt.toISOString().split('T')[0],
                totalHours: 0, // Default for new independent opportunities
                eisScore: 0,   // Default for new independent opportunities
                sdg: opp.sdg || (opp.sdg_info?.sdg_id) || 'N/A'
            };
        }));

        return {
            success: true,
            data: formatted
        };
    }
}

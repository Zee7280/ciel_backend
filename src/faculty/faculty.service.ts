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
        const email = (facultyEmail || '').trim();
        const opportunity = await this.opportunitiesRepository
            .createQueryBuilder('opportunity')
            .leftJoinAndSelect('opportunity.organization', 'organization')
            .where('opportunity.id = :opportunityId', { opportunityId })
            .andWhere(
                new Brackets((qb) => {
                    qb.where('opportunity.facultyId = :facultyId', { facultyId });
                    if (email) {
                        qb.orWhere(
                            `LOWER(TRIM(opportunity.supervision->>'contact')) = LOWER(:email)`,
                            { email },
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
                    student_name: r.student?.name || 'Unknown',
                    student_email: r.student?.email || 'Unknown',
                })),
            },
        };
    }

    async getApprovals(facultyId: string, facultyEmail: string, status?: string) {
        const email = (facultyEmail || '').trim();

        const query = this.opportunitiesRepository
            .createQueryBuilder('opportunity')
            .where(
                new Brackets((qb) => {
                    qb.where('opportunity.facultyId = :facultyId', { facultyId });
                    if (email) {
                        qb.orWhere(
                            `LOWER(TRIM(opportunity.supervision->>'contact')) = LOWER(:email)`,
                            { email },
                        );
                    }
                }),
            );

        // Pending faculty queue: new student flow + legacy liaison path
        if (status === 'pending' || status === undefined || status === '') {
            query.andWhere(
                new Brackets((qb) => {
                    qb.where('opportunity.status = :pf', { pf: 'pending_faculty' }).orWhere(
                        'opportunity.status = :pv',
                        { pv: 'pending_verification' },
                    );
                }),
            );
        } else {
            query.andWhere('opportunity.status = :st', { st: status });
        }

        const opportunities = await query.orderBy('opportunity.createdAt', 'DESC').getMany();

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

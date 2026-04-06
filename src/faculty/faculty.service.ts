import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class FacultyService {
    constructor(
        @InjectRepository(Opportunity)
        private readonly opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
    ) { }

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

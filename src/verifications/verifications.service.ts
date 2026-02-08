import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Report } from '../reports/entities/report.entity';
import { OrganizationsService } from '../organizations/organizations.service';

@Injectable()
export class VerificationsService {
    constructor(
        @InjectRepository(Timesheet)
        private timesheetsRepository: Repository<Timesheet>,
        @InjectRepository(Report)
        private reportsRepository: Repository<Report>,
        private organizationsService: OrganizationsService,
    ) { }

    async findAllPending(userId: string) {
        const org = await this.organizationsService.getMyOrganization(userId);
        if (!org) {
            return []; // Or throw
        }

        const timesheets = await this.timesheetsRepository.find({
            where: { organizationId: org.id, status: 'pending' },
            relations: ['student'],
            order: { createdAt: 'DESC' }
        });

        const reports = await this.reportsRepository.find({
            where: { organizationId: org.id, status: 'pending' },
            relations: ['student'],
            order: { createdAt: 'DESC' }
        });

        // Combine and map
        const combined = [
            ...timesheets.map(t => ({
                id: t.id,
                student_name: t.student ? t.student.name : 'Unknown Student',
                student_id: t.studentId,
                type: 'Timesheet',
                description: t.description || `Logged ${t.hours} hours`,
                submitted_at: t.createdAt,
                evidence_url: t.evidenceUrl,
                evidence_type: t.evidenceType
            })),
            ...reports.map(r => ({
                id: r.id,
                student_name: r.student ? r.student.name : 'Unknown Student',
                student_id: r.studentId,
                type: 'Report',
                description: r.description,
                submitted_at: r.createdAt,
                evidence_url: r.evidenceUrl,
                evidence_type: r.evidenceType
            }))
        ];

        return combined.sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
    }

    async approve(id: string, feedback?: string) {
        let type = 'Timesheet';
        let entity: any = await this.timesheetsRepository.findOne({ where: { id } });

        if (!entity) {
            entity = await this.reportsRepository.findOne({ where: { id } });
            type = 'Report';
        }

        if (!entity) {
            throw new NotFoundException('Verification item not found');
        }

        entity.status = 'verified';
        if (type === 'Timesheet') {
            await this.timesheetsRepository.save(entity);
        } else {
            await this.reportsRepository.save(entity);
        }
    }

    async reject(id: string, reason: string) {
        let type = 'Timesheet';
        let entity: any = await this.timesheetsRepository.findOne({ where: { id } });

        if (!entity) {
            entity = await this.reportsRepository.findOne({ where: { id } });
            type = 'Report';
        }

        if (!entity) {
            throw new NotFoundException('Verification item not found');
        }

        entity.status = 'rejected';
        entity.rejectionReason = reason;

        if (type === 'Timesheet') {
            await this.timesheetsRepository.save(entity);
        } else {
            await this.reportsRepository.save(entity);
        }
    }
}

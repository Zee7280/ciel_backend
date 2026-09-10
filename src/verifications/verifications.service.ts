import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Report } from '../reports/entities/report.entity';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserRole } from '../users/enums/user-role.enum';

/** Authenticated caller acting on a verification item. */
export interface VerificationActor {
    id: string;
    role?: string;
}

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

    /**
     * The acting partner must own the organization the record was submitted to — the same scope
     * `findAllPending` uses to build the queue. Admins may act on anything.
     *
     * `Timesheet.organizationId` is never populated at creation time (see `students.service.ts`
     * `logHours`), so for Timesheets we fall back to the linked opportunity's organizationId —
     * callers must eager-load the `opportunity` relation for this to resolve correctly.
     */
    private async assertActorOwnsVerificationItem(
        actor: VerificationActor | undefined,
        entity: { organizationId?: string | null; opportunity?: { organizationId?: string | null } | null },
    ) {
        if (actor?.role === UserRole.SUPER_ADMIN) return;
        if (!actor?.id) {
            throw new ForbiddenException('You are not allowed to act on this verification item');
        }
        const effectiveOrgId = entity.organizationId || entity.opportunity?.organizationId || null;
        const org = await this.organizationsService.getMyOrganization(actor.id);
        if (!org || !effectiveOrgId || org.id !== effectiveOrgId) {
            throw new ForbiddenException('You are not allowed to act on this verification item');
        }
    }

    async approve(id: string, feedback?: string, actor?: VerificationActor) {
        let type = 'Timesheet';
        let entity: any = await this.timesheetsRepository.findOne({ where: { id }, relations: ['opportunity'] });

        if (!entity) {
            entity = await this.reportsRepository.findOne({ where: { id } });
            type = 'Report';
        }

        if (!entity) {
            throw new NotFoundException('Verification item not found');
        }

        await this.assertActorOwnsVerificationItem(actor, entity);

        entity.status = 'verified';
        if (type === 'Timesheet') {
            await this.timesheetsRepository.save(entity);
        } else {
            await this.reportsRepository.save(entity);
        }
    }

    async reject(id: string, reason: string, actor?: VerificationActor) {
        let type = 'Timesheet';
        let entity: any = await this.timesheetsRepository.findOne({ where: { id }, relations: ['opportunity'] });

        if (!entity) {
            entity = await this.reportsRepository.findOne({ where: { id } });
            type = 'Report';
        }

        if (!entity) {
            throw new NotFoundException('Verification item not found');
        }

        await this.assertActorOwnsVerificationItem(actor, entity);

        entity.status = 'rejected';
        entity.rejectionReason = reason;

        if (type === 'Timesheet') {
            await this.timesheetsRepository.save(entity);
        } else {
            await this.reportsRepository.save(entity);
        }
    }
}

import {
    Injectable,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { OpportunityApplication, OpportunityApplicationInternalStatus } from './entities/opportunity-application.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { EngagementService } from '../engagement/engagement.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';

const PENDING_PIPELINE: OpportunityApplicationInternalStatus[] = [
    'pending_faculty',
    'pending_partner',
    'pending_admin',
];

@Injectable()
export class OpportunityApplicationsService {
    constructor(
        @InjectRepository(OpportunityApplication)
        private readonly appRepo: Repository<OpportunityApplication>,
        @InjectRepository(Participation)
        private readonly participationRepo: Repository<Participation>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        private readonly engagementService: EngagementService,
        private readonly usersService: UsersService,
    ) {}

    normalizeEmail(email: string) {
        return (email || '').trim().toLowerCase();
    }

    applicationStage(internal: OpportunityApplicationInternalStatus): 'faculty' | 'partner' | 'admin' | null {
        if (internal === 'pending_faculty') return 'faculty';
        if (internal === 'pending_partner') return 'partner';
        if (internal === 'pending_admin') return 'admin';
        return null;
    }

    isTerminalRejection(internal: OpportunityApplicationInternalStatus): boolean {
        return (
            internal === 'faculty_rejected' ||
            internal === 'partner_rejected' ||
            internal === 'admin_rejected'
        );
    }

    /**
     * Values aligned with current student frontend expectations (incl. join / apply-again aliases).
     */
    toPublicApplicationStatus(
        internal: OpportunityApplicationInternalStatus,
        leadParticipation?: Participation | null,
    ): string {
        if (internal === 'approved') {
            if (leadParticipation?.status === 'verified') return 'verified';
            return 'approved';
        }
        if (internal === 'faculty_rejected') return 'faculty_rejected';
        if (internal === 'partner_rejected') return 'partner_rejected';
        if (internal === 'admin_rejected') return 'admin_rejected';
        if (
            internal === 'pending_faculty' ||
            internal === 'pending_partner' ||
            internal === 'pending_admin'
        ) {
            return 'pending_approval';
        }
        return 'pending_approval';
    }

    async findLatestForStudentOpportunity(studentUserId: string, opportunityId: string) {
        const rows = await this.appRepo.find({
            where: { studentUserId, opportunityId, withdrawnAt: IsNull() },
            order: { createdAt: 'DESC' },
            take: 5,
        });
        return rows[0] || null;
    }

    async hasOpenPipelineApplication(studentUserId: string, opportunityId: string): Promise<boolean> {
        return this.appRepo.exists({
            where: {
                studentUserId,
                opportunityId,
                withdrawnAt: IsNull(),
                internalStatus: In(['pending_faculty', 'pending_partner', 'pending_admin', 'approved']),
            },
        });
    }

    /**
     * Latest non-withdrawn row per opportunity for this student (for browse overlays).
     */
    async mapCurrentApplicationsForOpportunities(
        studentUserId: string,
        opportunityIds: string[],
    ): Promise<Map<string, OpportunityApplication>> {
        const result = new Map<string, OpportunityApplication>();
        if (!studentUserId || !opportunityIds.length) return result;

        const apps = await this.appRepo.find({
            where: { studentUserId, opportunityId: In(opportunityIds), withdrawnAt: IsNull() },
            order: { createdAt: 'DESC' },
        });

        const grouped = new Map<string, OpportunityApplication[]>();
        for (const a of apps) {
            if (!grouped.has(a.opportunityId)) grouped.set(a.opportunityId, []);
            grouped.get(a.opportunityId)!.push(a);
        }

        for (const oppId of opportunityIds) {
            const list = grouped.get(oppId);
            if (!list?.length) continue;
            const sorted = [...list].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
            const current = sorted[0];
            if (current) result.set(oppId, current);
        }
        return result;
    }

    async findNonWithdrawnApplicationsForStudent(studentUserId: string) {
        return this.appRepo.find({
            where: { studentUserId, withdrawnAt: IsNull() },
            relations: ['opportunity', 'opportunity.organization', 'studentUser'],
            order: { createdAt: 'DESC' },
        });
    }

    async countSeatsInFlight(opportunityId: string): Promise<number> {
        return this.appRepo.count({
            where: {
                opportunityId,
                withdrawnAt: IsNull(),
                internalStatus: In(['pending_faculty', 'pending_partner', 'pending_admin']),
            },
        });
    }

    async countPendingAdmin(): Promise<number> {
        return this.appRepo.count({
            where: { internalStatus: 'pending_admin', withdrawnAt: IsNull() },
        });
    }

    async createApplication(params: {
        studentUserId: string;
        opportunityId: string;
        primaryFacultyEmail: string;
        secondaryFacultyEmail?: string | null;
        applyPayload: Record<string, unknown>;
    }) {
        const primary = this.normalizeEmail(params.primaryFacultyEmail);
        const secondary = params.secondaryFacultyEmail
            ? this.normalizeEmail(String(params.secondaryFacultyEmail))
            : null;

        const row = this.appRepo.create({
            opportunityId: params.opportunityId,
            studentUserId: params.studentUserId,
            internalStatus: 'pending_faculty',
            primaryFacultyEmail: primary,
            secondaryFacultyEmail: secondary,
            applyPayload: params.applyPayload,
        });
        try {
            return await this.appRepo.save(row);
        } catch (e: any) {
            if (e?.code === '23505') {
                throw new BadRequestException('Already applied to this opportunity');
            }
            throw e;
        }
    }

    async withdraw(studentUserId: string, id: string) {
        const app = await this.appRepo.findOne({
            where: { id, studentUserId, withdrawnAt: IsNull() },
        });
        if (!app) {
            return null;
        }
        if (!PENDING_PIPELINE.includes(app.internalStatus)) {
            throw new BadRequestException('Can only withdraw pending applications');
        }
        app.withdrawnAt = new Date();
        await this.appRepo.save(app);
        return { success: true, message: 'Application withdrawn successfully' };
    }

    /**
     * Browse/join: faculty dashboard uses opportunity id; resolve the row awaiting this faculty.
     */
    async findLatestPendingFacultyApplicationForDashboard(
        opportunityId: string,
        facultyEmail: string,
        studentUserId?: string | null,
    ): Promise<OpportunityApplication | null> {
        const email = this.normalizeEmail(facultyEmail);
        const qb = this.appRepo
            .createQueryBuilder('a')
            .where('a.opportunityId = :oid', { oid: opportunityId })
            .andWhere('a.withdrawnAt IS NULL')
            .andWhere('a.internalStatus = :st', { st: 'pending_faculty' })
            .andWhere('LOWER(TRIM(a.primaryFacultyEmail)) = :email', { email });
        if (studentUserId) {
            qb.andWhere('a.studentUserId = :sid', { sid: studentUserId });
        }
        qb.orderBy('a.createdAt', 'DESC');
        return qb.getOne();
    }

    async facultyList(facultyEmail: string, status: 'pending' | 'history' = 'pending') {
        const email = this.normalizeEmail(facultyEmail);
        const qb = this.appRepo
            .createQueryBuilder('a')
            .leftJoinAndSelect('a.opportunity', 'o')
            .leftJoinAndSelect('a.studentUser', 's')
            .where('lower(a.primaryFacultyEmail) = :email', { email })
            .andWhere('a.withdrawnAt IS NULL');

        if (status === 'pending') {
            qb.andWhere('a.internalStatus = :st', { st: 'pending_faculty' });
        } else {
            qb.andWhere('a.internalStatus IN (:...sts)', {
                sts: [
                    'pending_partner',
                    'pending_admin',
                    'approved',
                    'faculty_rejected',
                    'partner_rejected',
                    'admin_rejected',
                ],
            });
        }

        qb.orderBy('a.createdAt', 'DESC');
        const rows = await qb.getMany();
        return {
            success: true,
            data: rows.map((a) => ({
                id: a.id,
                opportunity_id: a.opportunityId,
                opportunity_title: a.opportunity?.title,
                student_name: a.studentUser?.name,
                student_email: a.studentUser?.email,
                internal_status: a.internalStatus,
                application_status: this.toPublicApplicationStatus(a.internalStatus),
                application_stage: this.applicationStage(a.internalStatus),
                created_at: a.createdAt,
            })),
        };
    }

    async facultyApprove(id: string, facultyEmail: string, facultyUserId: string) {
        const email = this.normalizeEmail(facultyEmail);
        const app = await this.appRepo.findOne({
            where: { id, withdrawnAt: IsNull() },
            relations: ['opportunity', 'studentUser'],
        });
        if (!app) throw new NotFoundException('Application not found');
        if (this.normalizeEmail(app.primaryFacultyEmail) !== email) {
            throw new ForbiddenException('Not authorized to act on this application');
        }
        if (app.internalStatus !== 'pending_faculty') {
            throw new BadRequestException('Application is not awaiting faculty review');
        }
        const opp = app.opportunity;
        if (!opp) {
            throw new NotFoundException('Opportunity not found for this application');
        }
        const nextStatus: OpportunityApplicationInternalStatus = opp.requiresPartnerApproval
            ? 'pending_partner'
            : 'pending_admin';
        app.internalStatus = nextStatus;
        app.facultyDecidedAt = new Date();
        app.facultyDecidedBy = facultyUserId;
        app.facultyComment = null;
        await this.appRepo.save(app);
        return { success: true, data: app };
    }

    async facultyReject(id: string, facultyEmail: string, facultyUserId: string, reason: string) {
        const email = this.normalizeEmail(facultyEmail);
        const app = await this.appRepo.findOne({ where: { id, withdrawnAt: IsNull() } });
        if (!app) throw new NotFoundException('Application not found');
        if (this.normalizeEmail(app.primaryFacultyEmail) !== email) {
            throw new ForbiddenException('Not authorized to act on this application');
        }
        if (app.internalStatus !== 'pending_faculty') {
            throw new BadRequestException('Application is not awaiting faculty review');
        }
        app.internalStatus = 'faculty_rejected';
        app.facultyDecidedAt = new Date();
        app.facultyDecidedBy = facultyUserId;
        app.facultyComment = reason || null;
        await this.appRepo.save(app);
        return { success: true, data: app };
    }

    /**
     * Browse listing org: join applications after faculty, when opportunity.requiresPartnerApproval.
     */
    async partnerList(organizationId: string, status: 'pending' | 'history' = 'pending') {
        if (!organizationId) {
            throw new BadRequestException('Organization is required');
        }
        const qb = this.appRepo
            .createQueryBuilder('a')
            .leftJoinAndSelect('a.opportunity', 'o')
            .leftJoinAndSelect('a.studentUser', 's')
            .where('o.organizationId = :orgId', { orgId: organizationId })
            .andWhere('a.withdrawnAt IS NULL');

        if (status === 'pending') {
            qb.andWhere('a.internalStatus = :st', { st: 'pending_partner' });
        } else {
            qb.andWhere('a.internalStatus IN (:...sts)', {
                sts: [
                    'pending_admin',
                    'approved',
                    'faculty_rejected',
                    'partner_rejected',
                    'admin_rejected',
                ],
            });
        }
        qb.orderBy('a.createdAt', 'DESC');
        const rows = await qb.getMany();
        return {
            success: true,
            data: rows.map((a) => ({
                id: a.id,
                opportunity_id: a.opportunityId,
                opportunity_title: a.opportunity?.title,
                student_name: a.studentUser?.name,
                student_email: a.studentUser?.email,
                internal_status: a.internalStatus,
                application_status: this.toPublicApplicationStatus(a.internalStatus),
                application_stage: this.applicationStage(a.internalStatus),
                created_at: a.createdAt,
            })),
        };
    }

    async partnerApprove(id: string, organizationId: string | null) {
        if (!organizationId) {
            throw new ForbiddenException('User is not linked to an organization');
        }
        const app = await this.appRepo.findOne({
            where: { id, withdrawnAt: IsNull() },
            relations: ['opportunity', 'studentUser'],
        });
        if (!app) throw new NotFoundException('Application not found');
        if (app.internalStatus !== 'pending_partner') {
            throw new BadRequestException('Application is not awaiting partner review');
        }
        const orgId = app.opportunity?.organizationId;
        if (!orgId || orgId !== organizationId) {
            throw new ForbiddenException('Not authorized to act on this application');
        }
        app.internalStatus = 'pending_admin';
        await this.appRepo.save(app);
        return { success: true, data: app };
    }

    async partnerReject(id: string, organizationId: string | null, reason: string) {
        if (!organizationId) {
            throw new ForbiddenException('User is not linked to an organization');
        }
        const app = await this.appRepo.findOne({
            where: { id, withdrawnAt: IsNull() },
            relations: ['opportunity'],
        });
        if (!app) throw new NotFoundException('Application not found');
        if (app.internalStatus !== 'pending_partner') {
            throw new BadRequestException('Application is not awaiting partner review');
        }
        const orgId = app.opportunity?.organizationId;
        if (!orgId || orgId !== organizationId) {
            throw new ForbiddenException('Not authorized to act on this application');
        }
        app.internalStatus = 'partner_rejected';
        app.partnerComment = reason?.trim() || null;
        await this.appRepo.save(app);
        return { success: true, data: app };
    }

    /** Rows waiting on CIEL admin (after faculty, and partner if applicable). */
    async findPendingAdminApplicationsForQueue(): Promise<OpportunityApplication[]> {
        return this.appRepo.find({
            where: { internalStatus: 'pending_admin', withdrawnAt: IsNull() },
            relations: ['opportunity', 'opportunity.organization', 'studentUser'],
            order: { createdAt: 'ASC' },
        });
    }

    async adminList(status?: string) {
        const normalized = (status || 'pending').trim().toLowerCase();
        if (normalized !== 'pending' && normalized !== 'history') {
            throw new BadRequestException('Only status=pending or status=history is supported for this listing');
        }

        const relations = ['opportunity', 'opportunity.organization', 'studentUser'] as const;

        const ADMIN_HISTORY_STATUSES: OpportunityApplicationInternalStatus[] = [
            'approved',
            'faculty_rejected',
            'partner_rejected',
            'admin_rejected',
        ];

        const rows =
            normalized === 'pending'
                ? await this.appRepo.find({
                      where: { internalStatus: 'pending_admin', withdrawnAt: IsNull() },
                      relations: [...relations],
                      order: { createdAt: 'ASC' },
                  })
                : await this.appRepo.find({
                      where: { internalStatus: In(ADMIN_HISTORY_STATUSES), withdrawnAt: IsNull() },
                      relations: [...relations],
                      order: { createdAt: 'DESC' },
                  });

        return {
            success: true,
            data: rows.map((a) => ({
                id: a.id,
                opportunity_id: a.opportunityId,
                opportunity_title: a.opportunity?.title,
                organization: a.opportunity?.organization?.name,
                student_name: a.studentUser?.name,
                student_email: a.studentUser?.email,
                primary_faculty_email: a.primaryFacultyEmail,
                secondary_faculty_email: a.secondaryFacultyEmail,
                apply_payload: a.applyPayload,
                created_at: a.createdAt,
                internal_status: a.internalStatus,
                application_status: this.toPublicApplicationStatus(a.internalStatus),
            })),
        };
    }

    async adminApprove(id: string, adminUserId: string) {
        const app = await this.appRepo.findOne({
            where: { id, withdrawnAt: IsNull() },
            relations: ['opportunity', 'studentUser'],
        });
        if (!app) throw new NotFoundException('Application not found');
        if (app.internalStatus !== 'pending_admin') {
            throw new BadRequestException('Application is not awaiting admin review');
        }

        const user = app.studentUser || (await this.userRepo.findOne({ where: { id: app.studentUserId } }));
        if (!user) throw new NotFoundException('Student not found');

        const payload = app.applyPayload || {};
        const participationType = (payload['participation_type'] as string) || 'individual';
        const teamId = (payload['team_id'] as string) || undefined;
        const primaryFaculty = (payload['primary_faculty_email'] as string) || app.primaryFacultyEmail;
        const secondaryFaculty =
            (payload['secondary_faculty_email'] as string) || app.secondaryFacultyEmail || undefined;
        const contactPhone = (payload['contact_phone_e164'] as string) || undefined;
        const teamMembers = (payload['team_members'] as any[]) || [];

        const existingLead = await this.participationRepo.findOne({
            where: { studentId: app.studentUserId, projectId: app.opportunityId },
        });
        if (existingLead && ['approved', 'verified', 'accepted', 'finalized'].includes(existingLead.status)) {
            app.internalStatus = 'approved';
            app.adminDecidedAt = new Date();
            app.adminDecidedBy = adminUserId;
            await this.appRepo.save(app);
            return { success: true, message: 'Application was already provisioned', data: app };
        }

        const applicationCorrelationId = app.id;

        await this.engagementService.preRegister(app.studentUserId, app.opportunityId, {
            applicationId: applicationCorrelationId,
            fullName: user.name,
            email: user.email,
            mobile: contactPhone || user.phone || '',
            cnic: user.cnic || '',
            universityName: user.university || '',
            universityId: user.university || '',
            academicProgram: user.major || '',
            yearOfStudy: '1st Year',
            department: 'Other',
            academicIntegrationType: 'Voluntary',
            participationMode: participationType,
            isTeamLead: true,
            emailVerified: true,
            mobileVerified: true,
            status: 'approved',
            primaryFacultyEmail: this.normalizeEmail(primaryFaculty),
            secondaryFacultyEmail: secondaryFaculty ? this.normalizeEmail(secondaryFaculty) : undefined,
            teamId,
        } as any);

        if (participationType === 'team' && teamMembers.length > 0) {
            for (const m of teamMembers) {
                const memberUser = await this.usersService.findByEmail(m.email);
                await this.engagementService.preRegister(memberUser?.id || null, app.opportunityId, {
                    applicationId: applicationCorrelationId,
                    fullName: m.name,
                    email: m.email,
                    mobile: m.mobile || '',
                    cnic: m.cnic || '',
                    universityName: m.university || '',
                    universityId: m.university || '',
                    academicProgram: m.program || '',
                    yearOfStudy: '1st Year',
                    department: 'Other',
                    academicIntegrationType: 'Voluntary',
                    participationMode: 'team',
                    isTeamLead: false,
                    emailVerified: true,
                    mobileVerified: true,
                    status: 'approved',
                    teamId,
                    primaryFacultyEmail: this.normalizeEmail(primaryFaculty),
                } as any);
            }
        }

        app.internalStatus = 'approved';
        app.adminDecidedAt = new Date();
        app.adminDecidedBy = adminUserId;
        app.adminComment = null;
        await this.appRepo.save(app);

        return { success: true, message: 'Application approved successfully', data: app };
    }

    async adminReject(id: string, adminUserId: string, reason: string) {
        const app = await this.appRepo.findOne({ where: { id, withdrawnAt: IsNull() } });
        if (!app) throw new NotFoundException('Application not found');
        if (app.internalStatus !== 'pending_admin') {
            throw new BadRequestException('Application is not awaiting admin review');
        }
        app.internalStatus = 'admin_rejected';
        app.adminDecidedAt = new Date();
        app.adminDecidedBy = adminUserId;
        app.adminComment = reason || null;
        await this.appRepo.save(app);
        return { success: true, message: 'Application rejected', data: app };
    }
}

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
import { StudentReport } from '../reports/entities/student-report.entity';
import { Payment } from '../payments/entities/payment.entity';

const PENDING_PIPELINE: OpportunityApplicationInternalStatus[] = [
    'pending_faculty',
    'pending_partner',
    'pending_admin',
];

/**
 * Student report is past the point where admin should remove the seat via this endpoint
 * (aligned with `StudentReportsService.saveDraft` locked statuses, minus `rejected`).
 */
const REPORT_STATUSES_BLOCKING_ADMIN_SEAT_REMOVAL: readonly string[] = [
    'submitted',
    'partner_verified',
    'payment_pending',
    'payment_under_review',
    'verified',
    'paid',
];

/** Applicants listed as having work still before final verification / payment-complete. */
const REPORT_STATUSES_EXCLUDED_FROM_INCOMPLETE_LIST: readonly string[] = [
    ...REPORT_STATUSES_BLOCKING_ADMIN_SEAT_REMOVAL,
    'rejected',
];

const TEAM_ACTIVE_PARTICIPATION_STATUSES: readonly string[] = [
    'pending',
    'accepted',
    'approved',
    'verified',
    'paid',
    'pending_payment_approval',
    'pending_ciel_approval',
    'pending_faculty_approval',
    'finalized',
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
        @InjectRepository(StudentReport)
        private readonly studentReportRepo: Repository<StudentReport>,
        private readonly engagementService: EngagementService,
        private readonly usersService: UsersService,
    ) {}

    normalizeEmail(email?: string | null) {
        return (email || '').trim().toLowerCase();
    }

    /** Public-facing report label for admin lists (matches student report API mapping). */
    private mapReportStatusForAdminList(raw: string | null | undefined): string {
        if (raw === 'payment_pending') return 'payment_under_review';
        if (raw === 'continue') return 'draft';
        return raw ?? 'draft';
    }

    private async findReportsForOpportunityAndStudents(opportunityId: string, studentIds: string[]) {
        if (!studentIds.length) return [];
        return this.studentReportRepo
            .createQueryBuilder('r')
            .where('r.studentId IN (:...studentIds)', { studentIds })
            .andWhere(
                '(r.opportunityId = :oid OR (r.project_id IS NOT NULL AND TRIM(r.project_id) = CAST(:oid AS varchar)))',
                { oid: opportunityId },
            )
            .getMany();
    }

    private toTeamReportStatus(raw: string | null | undefined): 'not_started' | 'in_progress' | 'completed' {
        if (!raw) return 'not_started';
        if (raw === 'verified' || raw === 'paid') return 'completed';
        return 'in_progress';
    }

    private aggregateTeamReportStatus(
        statuses: Array<'not_started' | 'in_progress' | 'completed'>,
    ): 'not_started' | 'in_progress' | 'completed' {
        if (!statuses.length) return 'not_started';
        if (statuses.every((s) => s === 'completed')) return 'completed';
        if (statuses.some((s) => s !== 'not_started')) return 'in_progress';
        return 'not_started';
    }

    private pickLatestReportForStudent(reports: StudentReport[], studentId: string): StudentReport | null {
        const forStudent = reports.filter((r) => r.studentId === studentId);
        if (!forStudent.length) return null;
        return [...forStudent].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
    }

    async adminListOpportunityTeams(opportunityId: string) {
        const rows = await this.participationRepo
            .createQueryBuilder('p')
            .leftJoinAndSelect('p.student', 'student')
            .where('p.projectId = :opportunityId', { opportunityId })
            .andWhere('p.teamId IS NOT NULL')
            .andWhere("TRIM(p.teamId) <> ''")
            .andWhere('p.status IN (:...statuses)', { statuses: [...TEAM_ACTIVE_PARTICIPATION_STATUSES] })
            .orderBy('p.createdAt', 'ASC')
            .getMany();

        if (!rows.length) {
            return {
                summary: {
                    registered_teams: 0,
                    completed_reports: 0,
                    reports_available: 0,
                },
                data: [],
            };
        }

        const rowsByTeamId = new Map<string, Participation[]>();
        for (const row of rows) {
            if (!row.teamId) continue;
            if (!rowsByTeamId.has(row.teamId)) {
                rowsByTeamId.set(row.teamId, []);
            }
            rowsByTeamId.get(row.teamId)!.push(row);
        }

        const studentIds = rows
            .map((r) => r.studentId)
            .filter((id): id is string => Boolean(id));
        const reports = await this.findReportsForOpportunityAndStudents(opportunityId, studentIds);

        const data: Array<Record<string, unknown>> = [];
        let completedReports = 0;
        let reportsAvailable = 0;

        for (const [teamId, members] of rowsByTeamId.entries()) {
            const lead = members.find((m) => m.isTeamLead) ?? members[0];
            const memberPayload = members.map((member) => {
                const rep = member.studentId
                    ? this.pickLatestReportForStudent(reports, member.studentId)
                    : null;
                const reportStatus = this.toTeamReportStatus(rep?.status);
                return {
                    id: member.id,
                    name: member.student?.name ?? member.fullName ?? null,
                    email: member.student?.email ?? member.email ?? null,
                    role: member.isTeamLead ? 'lead' : 'member',
                    report_status: reportStatus,
                    report_available: reportStatus !== 'not_started',
                };
            });
            const teamReportStatus = this.aggregateTeamReportStatus(
                memberPayload.map((m) => m.report_status as 'not_started' | 'in_progress' | 'completed'),
            );
            const teamReportAvailable = teamReportStatus !== 'not_started';
            if (teamReportStatus === 'completed') completedReports += 1;
            if (teamReportAvailable) reportsAvailable += 1;

            data.push({
                id: teamId,
                team_id: teamId,
                team_name: `Team ${teamId.slice(0, 8)}`,
                lead_name: lead?.student?.name ?? lead?.fullName ?? null,
                report_status: teamReportStatus,
                report_available: teamReportAvailable,
                members: memberPayload,
            });
        }

        return {
            summary: {
                registered_teams: data.length,
                completed_reports: completedReports,
                reports_available: reportsAvailable,
            },
            data,
        };
    }

    async adminDeleteOpportunityTeam(opportunityId: string, teamId: string) {
        await this.appRepo.manager.transaction(async (em) => {
            const members = await em.find(Participation, {
                where: {
                    projectId: opportunityId,
                    teamId,
                    status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
                },
            });
            if (!members.length) {
                throw new NotFoundException('Team not found for this opportunity');
            }

            const studentIds = members
                .map((m) => m.studentId)
                .filter((id): id is string => Boolean(id));
            const applicationIds = Array.from(
                new Set(
                    members
                        .map((m) => m.applicationId)
                        .filter((id): id is string => Boolean(id)),
                ),
            );

            if (studentIds.length) {
                const reports = await em
                    .getRepository(StudentReport)
                    .createQueryBuilder('r')
                    .where('r.studentId IN (:...studentIds)', { studentIds })
                    .andWhere(
                        '(r.opportunityId = :oid OR (r.project_id IS NOT NULL AND TRIM(r.project_id) = CAST(:oid AS varchar)))',
                        { oid: opportunityId },
                    )
                    .getMany();
                if (reports.length) {
                    await em.remove(reports);
                }
                await em.delete(Payment, { projectId: opportunityId, studentId: In(studentIds) });
            }

            await em.remove(members);

            if (applicationIds.length) {
                await em
                    .getRepository(OpportunityApplication)
                    .createQueryBuilder()
                    .update(OpportunityApplication)
                    .set({ withdrawnAt: new Date() })
                    .where('id IN (:...applicationIds)', { applicationIds })
                    .andWhere('withdrawnAt IS NULL')
                    .execute();
            }
        });
    }

    async adminDeleteOpportunityTeamMember(opportunityId: string, teamId: string, memberId: string) {
        await this.appRepo.manager.transaction(async (em) => {
            const member = await em.findOne(Participation, {
                where: {
                    id: memberId,
                    projectId: opportunityId,
                    teamId,
                    status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
                },
            });
            if (!member) {
                throw new NotFoundException('Team member not found for this opportunity');
            }

            if (member.studentId) {
                const reports = await em
                    .getRepository(StudentReport)
                    .createQueryBuilder('r')
                    .where('r.studentId = :studentId', { studentId: member.studentId })
                    .andWhere(
                        '(r.opportunityId = :oid OR (r.project_id IS NOT NULL AND TRIM(r.project_id) = CAST(:oid AS varchar)))',
                        { oid: opportunityId },
                    )
                    .getMany();
                if (reports.length) {
                    await em.remove(reports);
                }
                await em.delete(Payment, { projectId: opportunityId, studentId: member.studentId });
            }

            await em.remove(member);

            if (member.applicationId) {
                await em
                    .getRepository(OpportunityApplication)
                    .createQueryBuilder()
                    .update(OpportunityApplication)
                    .set({ withdrawnAt: new Date() })
                    .where('id = :applicationId', { applicationId: member.applicationId })
                    .andWhere('withdrawnAt IS NULL')
                    .execute();
            }

            const remainingTeamMembers = await em.find(Participation, {
                where: {
                    projectId: opportunityId,
                    teamId,
                    status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
                },
                order: { createdAt: 'ASC' },
            });
            if (remainingTeamMembers.length && !remainingTeamMembers.some((p) => p.isTeamLead)) {
                const nextLead = remainingTeamMembers[0];
                nextLead.isTeamLead = true;
                await em.save(nextLead);
            }
        });
    }

    /**
     * Approved enrollments on this opportunity whose student has a student_reports row
     * that is not yet submitted / verified / paid (etc.).
     */
    async adminListIncompleteReportApplicants(opportunityId: string) {
        const apps = await this.appRepo.find({
            where: {
                opportunityId,
                internalStatus: 'approved',
                withdrawnAt: IsNull(),
            },
            relations: ['studentUser'],
            order: { createdAt: 'DESC' },
        });
        if (!apps.length) {
            return { data: [] as Array<Record<string, unknown>> };
        }

        const studentIds = apps.map((a) => a.studentUserId);
        const reports = await this.findReportsForOpportunityAndStudents(opportunityId, studentIds);

        const data: Array<Record<string, unknown>> = [];
        for (const a of apps) {
            const rep = this.pickLatestReportForStudent(reports, a.studentUserId);
            if (!rep) continue;
            if (REPORT_STATUSES_EXCLUDED_FROM_INCOMPLETE_LIST.includes(rep.status)) continue;
            data.push({
                application_id: a.id,
                student_name: a.studentUser?.name ?? null,
                student_email: a.studentUser?.email ?? null,
                report_status: this.mapReportStatusForAdminList(rep.status),
            });
        }

        return { data };
    }

    /**
     * Withdraws the application, removes linked participations (same applicationId),
     * student reports, and payments for this project/students — only while no report is
     * in a submitted-or-verified-or-paid state (see REPORT_STATUSES_BLOCKING_ADMIN_SEAT_REMOVAL).
     */
    async adminDeleteApprovedApplicationForIncompleteReport(opportunityId: string, applicationId: string) {
        await this.appRepo.manager.transaction(async (em) => {
            const app = await em.findOne(OpportunityApplication, {
                where: { id: applicationId, opportunityId, withdrawnAt: IsNull() },
            });
            if (!app) {
                throw new NotFoundException('Application not found for this opportunity');
            }
            if (app.internalStatus !== 'approved') {
                throw new BadRequestException(
                    'Only approved applications on this opportunity can be removed with this action',
                );
            }

            const participations = await em.find(Participation, {
                where: { projectId: opportunityId, applicationId },
            });

            const studentIdSet = new Set<string>();
            for (const p of participations) {
                if (p.studentId) studentIdSet.add(p.studentId);
            }
            studentIdSet.add(app.studentUserId);
            const studentIds = [...studentIdSet];

            const reports = await em
                .getRepository(StudentReport)
                .createQueryBuilder('r')
                .where('r.studentId IN (:...studentIds)', { studentIds })
                .andWhere(
                    '(r.opportunityId = :oid OR (r.project_id IS NOT NULL AND TRIM(r.project_id) = CAST(:oid AS varchar)))',
                    { oid: opportunityId },
                )
                .getMany();

            for (const sid of studentIds) {
                const forSid = reports.filter((r) => r.studentId === sid);
                if (
                    forSid.some((r) => REPORT_STATUSES_BLOCKING_ADMIN_SEAT_REMOVAL.includes(r.status))
                ) {
                    throw new BadRequestException(
                        'Cannot remove this enrollment: report is already submitted or verified for at least one participant',
                    );
                }
            }

            if (participations.length) {
                await em.remove(participations);
            }

            if (reports.length) {
                await em.remove(reports);
            }

            await em.delete(Payment, { projectId: opportunityId, studentId: In(studentIds) });

            app.withdrawnAt = new Date();
            await em.save(app);
        });
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
            where: { internalStatus: In(['pending_admin', 'pending_partner']), withdrawnAt: IsNull() },
        });
    }

    async createApplication(params: {
        studentUserId: string;
        opportunityId: string;
        primaryFacultyEmail?: string | null;
        secondaryFacultyEmail?: string | null;
        attendanceApproverType?: 'faculty' | 'partner';
        applyPayload: Record<string, unknown>;
    }) {
        const primary = params.primaryFacultyEmail ? this.normalizeEmail(params.primaryFacultyEmail) : null;
        const secondary = params.secondaryFacultyEmail
            ? this.normalizeEmail(String(params.secondaryFacultyEmail))
            : null;
        const attendanceApproverType = params.attendanceApproverType === 'partner' ? 'partner' : 'faculty';

        const row = this.appRepo.create({
            opportunityId: params.opportunityId,
            studentUserId: params.studentUserId,
            internalStatus: attendanceApproverType === 'partner' && !primary ? 'pending_admin' : 'pending_faculty',
            primaryFacultyEmail: primary,
            secondaryFacultyEmail: secondary,
            attendanceApproverType,
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
        // Student join/apply pipeline: faculty → CIEL admin only (no org/partner gate on applications).
        app.internalStatus = 'pending_admin';
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
     * Browse listing org: legacy partner queue (new applications no longer enter this stage from faculty).
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

    /** Rows waiting on CIEL admin (after faculty; legacy `pending_partner` included for same queue). */
    async findPendingAdminApplicationsForQueue(): Promise<OpportunityApplication[]> {
        return this.appRepo.find({
            where: { internalStatus: In(['pending_admin', 'pending_partner']), withdrawnAt: IsNull() },
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
                      where: { internalStatus: In(['pending_admin', 'pending_partner']), withdrawnAt: IsNull() },
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
        if (app.internalStatus !== 'pending_admin' && app.internalStatus !== 'pending_partner') {
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
        const normalizedPrimaryFaculty = primaryFaculty ? this.normalizeEmail(primaryFaculty) : undefined;
        const normalizedSecondaryFaculty = secondaryFaculty ? this.normalizeEmail(secondaryFaculty) : undefined;
        const contactPhone = (payload['contact_phone_e164'] as string) || undefined;
        const teamMembers = (payload['team_members'] as any[]) || [];
        const attendanceApproverType =
            app.attendanceApproverType === 'partner' ||
            payload['attendance_approver_type'] === 'partner'
                ? 'partner'
                : 'faculty';

        const existingLead = await this.participationRepo.findOne({
            where: { studentId: app.studentUserId, projectId: app.opportunityId },
        });
        if (existingLead && ['approved', 'verified', 'accepted', 'finalized'].includes(existingLead.status)) {
            let changed = false;
            if (!existingLead.applicationId) {
                existingLead.applicationId = app.id;
                changed = true;
            }
            if (existingLead.attendanceApproverType !== attendanceApproverType) {
                existingLead.attendanceApproverType = attendanceApproverType;
                changed = true;
            }
            if (!existingLead.primaryFacultyEmail && normalizedPrimaryFaculty) {
                existingLead.primaryFacultyEmail = normalizedPrimaryFaculty;
                changed = true;
            }
            if (!existingLead.secondaryFacultyEmail && normalizedSecondaryFaculty) {
                existingLead.secondaryFacultyEmail = normalizedSecondaryFaculty;
                changed = true;
            }
            if (changed) {
                await this.participationRepo.save(existingLead);
            }
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
            primaryFacultyEmail: normalizedPrimaryFaculty,
            secondaryFacultyEmail: normalizedSecondaryFaculty,
            attendanceApproverType,
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
                    primaryFacultyEmail: normalizedPrimaryFaculty,
                    attendanceApproverType,
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
        if (app.internalStatus !== 'pending_admin' && app.internalStatus !== 'pending_partner') {
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

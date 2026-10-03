import { Injectable, Optional, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type FindOptionsWhere } from 'typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { findCanonicalTeamLeadStudentId } from '../engagement/team-lead-canonical.util';
import { Setting } from '../settings/entities/setting.entity';
import { S3Service } from '../common/s3.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

import { Payment, PaymentStatus } from './entities/payment.entity';
import { StudentReport } from '../reports/entities/student-report.entity';

@Injectable()
export class PaymentsService {
    constructor(
        @InjectRepository(Participation)
        private readonly participantRepository: Repository<Participation>,
        @InjectRepository(Setting)
        private readonly settingRepository: Repository<Setting>,
        @InjectRepository(Payment)
        private readonly paymentRepository: Repository<Payment>,
        @InjectRepository(StudentReport)
        private readonly studentReportRepository: Repository<StudentReport>,
        private readonly s3Service: S3Service,
        @Optional() private readonly mailService?: MailService,
        @Optional() private readonly notificationsService?: NotificationsService,
    ) { }

    private async getSetting(key: string, defaultValue: string): Promise<string> {
        const setting = await this.settingRepository.findOne({ where: { key } });
        return setting ? setting.value : defaultValue;
    }

    async submitPaymentProof(studentId: string, projectId: string, file: any) {
        const participant = await this.participantRepository.findOne({
            where: { studentId, projectId },
        });

        if (!participant) {
            throw new NotFoundException('Project application not found');
        }

        const proofUrl = await this.s3Service.uploadFile(file, `payments/${studentId}`);

        participant.paymentProofUrl = proofUrl;
        participant.paymentStatus = 'pending_payment_approval';
        participant.paymentDate = new Date();

        await this.participantRepository.save(participant);

        return {
            success: true,
            message: 'Payment proof submitted successfully',
            data: {
                payment_status: participant.paymentStatus,
                payment_proof_url: proofUrl,
            },
        };
    }

    // --- NEW MANUAL PAYMENT FLOW ---

    private looksLikeUuid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
    }

    /** Match student-reports resolution: opportunityId or project_id; team members use team-lead row. */
    private async findStudentReportForPayment(
        studentId: string,
        projectId: string,
    ): Promise<StudentReport | null> {
        const key = projectId.trim();
        if (!this.looksLikeUuid(key)) {
            return null;
        }

        const fetchLatestRow = async (sid: string) =>
            this.studentReportRepository.findOne({
                where: [
                    { studentId: sid, opportunityId: key },
                    { studentId: sid, project_id: key },
                ] as FindOptionsWhere<StudentReport>[],
                order: { createdAt: 'DESC' },
            });

        const mine = await this.participantRepository.findOne({
            where: { studentId, projectId: key },
        });

        if (mine?.participationMode === 'team') {
            const leadId = await findCanonicalTeamLeadStudentId(this.participantRepository, key, {
                teamId: mine.teamId,
                applicationId: mine.applicationId,
            });
            const reportStudentId = leadId && leadId !== studentId ? leadId : studentId;
            const teamReport = await fetchLatestRow(reportStudentId);
            if (teamReport) {
                return teamReport;
            }
        }

        return fetchLatestRow(studentId);
    }

    async submitManualPayment(
        studentId: string,
        projectId: string,
        file: any,
        paidAmountRaw?: string | number,
    ) {
        const paidAmount = this.parsePaidAmount(paidAmountRaw);

        // 1. Upload proof to S3
        const proofUrl = await this.s3Service.uploadFile(file, `payments-manual/${studentId}`);

        // 2. Insert record into payments table
        const payment = this.paymentRepository.create({
            studentId,
            projectId,
            proof_url: proofUrl,
            status: PaymentStatus.PENDING,
            paid_amount: paidAmount,
        });
        await this.paymentRepository.save(payment);

        // 3. Update reports.status (student UI: payment_under_review)
        const report = await this.findStudentReportForPayment(studentId, projectId);

        if (report) {
            report.status = 'payment_under_review';
            await this.studentReportRepository.save(report);
        }

        return {
            success: true,
            message: 'Payment proof submitted successfully',
            data: {
                paymentId: payment.id,
                paid_amount: payment.paid_amount,
            },
        };
    }

    private parsePaidAmount(paidAmountRaw?: string | number): number {
        if (paidAmountRaw === undefined || paidAmountRaw === null || paidAmountRaw === '') {
            throw new BadRequestException('paid_amount is required');
        }
        const n =
            typeof paidAmountRaw === 'number' ? paidAmountRaw : Number(String(paidAmountRaw).trim());
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            throw new BadRequestException('paid_amount must be a positive whole number');
        }
        return n;
    }

    private async getReportingFeePerMemberPkr(): Promise<number> {
        const raw = await this.getSetting('REPORTING_FEE_PKR', '200');
        const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) && n > 0 ? n : 200;
    }

    /** Same team bucket as My Projects roster (applicationId + teamId on project). */
    private async loadTeamRosterForSubmitter(
        studentId: string,
        projectId: string,
    ): Promise<{ participation: Participation | null; roster: Participation[] }> {
        const participation = await this.participantRepository.findOne({
            where: { studentId, projectId },
        });
        if (!participation) {
            return { participation: null, roster: [] };
        }

        const merged = new Map<string, Participation>();
        merged.set(participation.id, participation);

        if (participation.applicationId) {
            const byApplication = await this.participantRepository.find({
                where: { projectId, applicationId: participation.applicationId },
            });
            for (const row of byApplication) {
                merged.set(row.id, row);
            }
        }

        const teamId = typeof participation.teamId === 'string' ? participation.teamId.trim() : '';
        if (teamId) {
            const byTeam = await this.participantRepository.find({
                where: { projectId, teamId },
            });
            for (const row of byTeam) {
                merged.set(row.id, row);
            }
        }

        const roster = Array.from(merged.values()).sort((a, b) => {
            if (a.isTeamLead !== b.isTeamLead) {
                return a.isTeamLead ? -1 : 1;
            }
            return (a.fullName || '').localeCompare(b.fullName || '');
        });

        return { participation, roster };
    }

    private async buildManualPaymentTeamContext(
        p: Payment,
        preloaded?: { participation: Participation | null; roster: Participation[]; perMember: number },
    ): Promise<{
        participation_mode: 'individual' | 'team';
        submitted_by: {
            student_id: string;
            name: string;
            email: string;
            is_team_lead: boolean;
        };
        team_member_count: number;
        team_members: { name: string; email: string; is_team_lead: boolean }[];
        reporting_fee_per_member_pkr: number;
        expected_paid_amount_pkr: number;
    }> {
        const { participation, roster } =
            preloaded ?? (await this.loadTeamRosterForSubmitter(p.studentId, p.projectId));
        const perMember = preloaded?.perMember ?? (await this.getReportingFeePerMemberPkr());

        const submitterRow = roster.find((r) => r.studentId === p.studentId) ?? participation;
        const isTeamLead = submitterRow?.isTeamLead === true;
        const participationMode =
            participation?.participationMode === 'team' || roster.length > 1 ? 'team' : 'individual';

        const teamMembers =
            roster.length > 0
                ? roster.map((row) => ({
                      name: (row.fullName || '').trim() || '—',
                      email: (row.email || '').trim() || '—',
                      is_team_lead: !!row.isTeamLead,
                  }))
                : [];

        const teamMemberCount = participationMode === 'team' ? Math.max(1, teamMembers.length) : 1;
        const expectedPaid = perMember * teamMemberCount;

        return {
            participation_mode: participationMode,
            submitted_by: {
                student_id: p.studentId,
                name: p.student?.name || submitterRow?.fullName || 'Unknown',
                email: p.student?.email || submitterRow?.email || 'Unknown',
                is_team_lead: isTeamLead,
            },
            team_member_count: teamMemberCount,
            team_members: teamMembers,
            reporting_fee_per_member_pkr: perMember,
            expected_paid_amount_pkr: expectedPaid,
        };
    }

    /**
     * Batch version of loadTeamRosterForSubmitter: three queries for the whole page instead of
     * several per row. Roster membership rules are identical (same applicationId or same teamId).
     */
    private async loadTeamContextsForPayments(
        payments: Payment[],
    ): Promise<Map<string, { participation: Participation | null; roster: Participation[]; perMember: number }>> {
        const out = new Map<
            string,
            { participation: Participation | null; roster: Participation[]; perMember: number }
        >();
        if (!payments.length) return out;
        const perMember = await this.getReportingFeePerMemberPkr();
        const projectIds = [...new Set(payments.map((p) => p.projectId))];
        const rows = await this.participantRepository.find({
            where: { projectId: In(projectIds) },
        });
        const byStudentProject = new Map<string, Participation>();
        const byProject = new Map<string, Participation[]>();
        for (const row of rows) {
            byStudentProject.set(this.paymentScopeKey(row.studentId, row.projectId), row);
            const list = byProject.get(row.projectId) ?? [];
            list.push(row);
            byProject.set(row.projectId, list);
        }
        for (const p of payments) {
            const participation = byStudentProject.get(this.paymentScopeKey(p.studentId, p.projectId)) ?? null;
            if (!participation) {
                out.set(p.id, { participation: null, roster: [], perMember });
                continue;
            }
            const teamId = typeof participation.teamId === 'string' ? participation.teamId.trim() : '';
            const merged = new Map<string, Participation>([[participation.id, participation]]);
            for (const row of byProject.get(p.projectId) ?? []) {
                if (
                    (participation.applicationId && row.applicationId === participation.applicationId) ||
                    (teamId && row.teamId === teamId)
                ) {
                    merged.set(row.id, row);
                }
            }
            const roster = Array.from(merged.values()).sort((a, b) => {
                if (a.isTeamLead !== b.isTeamLead) return a.isTeamLead ? -1 : 1;
                return (a.fullName || '').localeCompare(b.fullName || '');
            });
            out.set(p.id, { participation, roster, perMember });
        }
        return out;
    }

    private paymentScopeKey(studentId: string, projectId: string): string {
        return `${studentId}:${projectId}`;
    }

    private async buildSubmissionMetaForPayments(
        payments: Payment[],
    ): Promise<Map<string, { submissionNumber: number; totalInScope: number }>> {
        const meta = new Map<string, { submissionNumber: number; totalInScope: number }>();
        if (!payments.length) {
            return meta;
        }

        const scopeKeys = new Set<string>();
        const studentIds = new Set<string>();
        const projectIds = new Set<string>();
        for (const payment of payments) {
            studentIds.add(payment.studentId);
            projectIds.add(payment.projectId);
            scopeKeys.add(this.paymentScopeKey(payment.studentId, payment.projectId));
        }

        const allRows = await this.paymentRepository.find({
            where: {
                studentId: In([...studentIds]),
                projectId: In([...projectIds]),
            },
            order: { created_at: 'ASC' },
            select: ['id', 'studentId', 'projectId', 'created_at'],
        });

        const byScope = new Map<string, typeof allRows>();
        for (const row of allRows) {
            const key = this.paymentScopeKey(row.studentId, row.projectId);
            if (!scopeKeys.has(key)) {
                continue;
            }
            const list = byScope.get(key) ?? [];
            list.push(row);
            byScope.set(key, list);
        }

        for (const list of byScope.values()) {
            for (let i = 0; i < list.length; i++) {
                meta.set(list[i].id, {
                    submissionNumber: i + 1,
                    totalInScope: list.length,
                });
            }
        }

        return meta;
    }

    private async mapManualPaymentRow(
        p: Payment,
        submissionMeta?: { submissionNumber: number; totalInScope: number },
        preloaded?: { participation: Participation | null; roster: Participation[]; perMember: number },
    ) {
        const teamCtx = await this.buildManualPaymentTeamContext(p, preloaded);
        return {
            id: p.id,
            projectId: p.projectId,
            project_id: p.projectId,
            studentId: p.studentId,
            student_id: p.studentId,
            studentName: p.student?.name || teamCtx.submitted_by.name,
            studentEmail: p.student?.email || teamCtx.submitted_by.email,
            submitted_by: teamCtx.submitted_by,
            submittedBy: teamCtx.submitted_by,
            participation_mode: teamCtx.participation_mode,
            participationMode: teamCtx.participation_mode,
            team_member_count: teamCtx.team_member_count,
            teamMemberCount: teamCtx.team_member_count,
            team_members: teamCtx.team_members,
            teamMembers: teamCtx.team_members,
            reporting_fee_per_member_pkr: teamCtx.reporting_fee_per_member_pkr,
            reportingFeePerMemberPkr: teamCtx.reporting_fee_per_member_pkr,
            expected_paid_amount_pkr: teamCtx.expected_paid_amount_pkr,
            expectedPaidAmountPkr: teamCtx.expected_paid_amount_pkr,
            projectTitle: p.opportunity?.title || 'Unknown',
            organization: p.opportunity?.organization?.name || 'Unknown',
            amount: p.amount,
            paid_amount: p.paid_amount,
            proofUrl: p.proof_url,
            submittedAt: p.created_at,
            status: p.status,
            feedback: p.feedback,
            reviewedBy: p.reviewedBy ?? null,
            reviewedAt: p.reviewedAt ?? null,
            submission_number: submissionMeta?.submissionNumber,
            submissionNumber: submissionMeta?.submissionNumber,
            submission_total: submissionMeta?.totalInScope,
            submissionTotal: submissionMeta?.totalInScope,
        };
    }

    async getStudentManualPaymentHistory(studentId: string) {
        const payments = await this.paymentRepository.find({
            where: { studentId },
            relations: ['opportunity', 'opportunity.organization', 'student'],
            order: { created_at: 'DESC' },
        });

        const firstStudent = payments[0]?.student;
        const student =
            firstStudent != null
                ? {
                      id: firstStudent.id,
                      name: firstStudent.name,
                      email: firstStudent.email,
                  }
                : { id: studentId, name: null as string | null, email: null as string | null };

        const paymentRows = payments.map((p) => ({
            id: p.id,
            studentId: p.studentId,
            opportunityId: p.projectId,
            amount: p.amount,
            paid_amount: p.paid_amount,
            proofUrl: p.proof_url,
            status: p.status,
            feedback: p.feedback,
            reviewedAt: p.reviewedAt ?? null,
            submittedAt: p.created_at,
            updatedAt: p.updated_at,
            opportunity: p.opportunity
                ? {
                      id: p.opportunity.id,
                      title: p.opportunity.title,
                      status: p.opportunity.status,
                      workflowStage: p.opportunity.workflowStage,
                      adminApproved: p.opportunity.admin_approved,
                      types: p.opportunity.types ?? null,
                      mode: p.opportunity.mode ?? null,
                      requiredHours: p.opportunity.requiredHours,
                      organization: p.opportunity.organization
                          ? {
                                id: p.opportunity.organization.id,
                                name: p.opportunity.organization.name,
                                orgType: p.opportunity.organization.orgType,
                            }
                          : null,
                  }
                : null,
        }));

        return {
            studentId,
            student,
            payments: paymentRows,
        };
    }

    private normalizePaging(opts?: { page?: number | string; limit?: number | string }) {
        if (!opts || (opts.page === undefined && opts.limit === undefined)) return null;
        const limit = Math.min(200, Math.max(1, parseInt(String(opts.limit ?? 50), 10) || 50));
        const page = Math.max(1, parseInt(String(opts.page ?? 1), 10) || 1);
        return { page, limit, skip: (page - 1) * limit };
    }

    private async listManualPayments(
        status: PaymentStatus,
        opts?: { page?: number | string; limit?: number | string },
    ): Promise<{ rows: any[]; total: number; page: number | null; limit: number | null }> {
        const paging = this.normalizePaging(opts);
        const [payments, total] = await this.paymentRepository.findAndCount({
            where: { status },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { created_at: 'DESC' },
            ...(paging ? { skip: paging.skip, take: paging.limit } : {}),
        });

        const [submissionMeta, teamContexts] = await Promise.all([
            this.buildSubmissionMetaForPayments(payments),
            this.loadTeamContextsForPayments(payments),
        ]);
        const rows = await Promise.all(
            payments.map((p) =>
                this.mapManualPaymentRow(p, submissionMeta.get(p.id), teamContexts.get(p.id)),
            ),
        );
        return { rows, total, page: paging?.page ?? null, limit: paging?.limit ?? null };
    }

    async findAllPendingManual(opts?: { page?: number | string; limit?: number | string }) {
        return (await this.listManualPayments(PaymentStatus.PENDING, opts)).rows;
    }

    async findAllPendingManualPaged(opts?: { page?: number | string; limit?: number | string }) {
        return this.listManualPayments(PaymentStatus.PENDING, opts);
    }

    async findManualPaymentsByStatus(
        status: PaymentStatus.APPROVED | PaymentStatus.REJECTED,
        opts?: { page?: number | string; limit?: number | string },
    ) {
        return (await this.listManualPayments(status, opts)).rows;
    }

    async findManualPaymentsByStatusPaged(
        status: PaymentStatus.APPROVED | PaymentStatus.REJECTED,
        opts?: { page?: number | string; limit?: number | string },
    ) {
        return this.listManualPayments(status, opts);
    }

    /** All slips for the same student + project (oldest first). */
    async getSubmissionHistoryByPaymentId(paymentId: string) {
        const payment = await this.paymentRepository.findOne({
            where: { id: paymentId },
        });

        if (!payment) {
            throw new NotFoundException('Payment record not found');
        }

        const rows = await this.paymentRepository.find({
            where: {
                studentId: payment.studentId,
                projectId: payment.projectId,
            },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { created_at: 'ASC' },
        });

        const [submissionMeta, teamContexts] = await Promise.all([
            this.buildSubmissionMetaForPayments(rows),
            this.loadTeamContextsForPayments(rows),
        ]);
        return Promise.all(
            rows.map((p) =>
                this.mapManualPaymentRow(p, submissionMeta.get(p.id), teamContexts.get(p.id)),
            ),
        );
    }

    /** Best-effort in-app + email notice to the student; never throws. */
    private async notifyStudentOfPaymentDecision(
        paymentId: string,
        decision: 'approved' | 'rejected' | 'reverted',
        feedback?: string | null,
    ): Promise<void> {
        try {
            const full = await this.paymentRepository.findOne({
                where: { id: paymentId },
                relations: ['student', 'opportunity'],
            });
            if (!full) return;
            const projectTitle = full.opportunity?.title || 'your project';
            const title =
                decision === 'approved'
                    ? 'Reporting fee approved'
                    : decision === 'rejected'
                      ? 'Reporting fee payment rejected'
                      : 'Reporting fee under review again';
            const message =
                decision === 'approved'
                    ? `Your reporting fee payment for "${projectTitle}" was approved.`
                    : decision === 'rejected'
                      ? `Your reporting fee payment for "${projectTitle}" was rejected. Please submit a new payment proof.`
                      : `The earlier approval of your reporting fee payment for "${projectTitle}" was reverted and the slip is under review again.`;
            if (this.notificationsService && full.studentId) {
                try {
                    await this.notificationsService.createApprovalNotification(full.studentId, title, message);
                } catch (error) {
                    console.warn('Failed to create payment notification', (error as Error).message);
                }
            }
            if (this.mailService && full.student?.email) {
                try {
                    await this.mailService.sendStudentOpportunityStatusUpdate(
                        full.student.email,
                        projectTitle,
                        title,
                        title,
                        message,
                        decision === 'rejected' ? feedback : null,
                    );
                } catch (error) {
                    console.warn('Failed to send payment decision email', (error as Error).message);
                }
            }
        } catch (error) {
            console.warn('Payment decision notification failed', (error as Error).message);
        }
    }

    async verifyManualPayment(
        id: string,
        status: PaymentStatus,
        feedback?: string,
        admin?: { id: string; email?: string },
    ) {
        const payment = await this.paymentRepository.findOne({
            where: { id },
        });

        if (!payment) {
            throw new NotFoundException('Payment record not found');
        }

        if (payment.status !== PaymentStatus.PENDING) {
            throw new ConflictException('Only a pending payment can be approved or rejected');
        }

        // Conditional update: two concurrent reviewers can't both decide the same slip.
        const result = await this.paymentRepository.update(
            { id, status: PaymentStatus.PENDING },
            {
                status,
                ...(feedback ? { feedback } : {}),
                reviewedBy: admin?.id ?? null,
                reviewedAt: new Date(),
            },
        );
        if (!result.affected) {
            throw new ConflictException('Only a pending payment can be approved or rejected');
        }
        payment.status = status;
        if (feedback) payment.feedback = feedback;

        await this.syncReportStatusForPaymentScope(payment);
        await this.notifyStudentOfPaymentDecision(
            id,
            status === PaymentStatus.APPROVED ? 'approved' : 'rejected',
            feedback,
        );

        return {
            success: true,
            message: `Payment ${status} successfully`,
        };
    }

    /**
     * Report status follows the slips for this student + project.
     * Approve clears the fee (`paid`). Reject with nothing else pending sends the student back to pay.
     * Revert puts a cleared fee back under review. A later faculty/admin verify (`verified`) is only
     * pulled back when the approval that cleared the fee is reverted.
     */
    private async syncReportStatusForPaymentScope(payment: Payment): Promise<void> {
        const report = await this.findStudentReportForPayment(payment.studentId, payment.projectId);
        if (!report) return;

        const rows = await this.paymentRepository.find({
            where: { studentId: payment.studentId, projectId: payment.projectId },
        });
        const anyApproved = rows.some((row) => row.status === PaymentStatus.APPROVED);
        const anyPending = rows.some((row) => row.status === PaymentStatus.PENDING);
        const current = String(report.status || '').toLowerCase();
        let next: string | null = null;

        if (anyApproved) {
            if (current === 'payment_pending' || current === 'payment_under_review') {
                next = 'paid';
            }
        } else if (anyPending) {
            if (current === 'paid' || current === 'verified' || current === 'payment_pending') {
                next = 'payment_under_review';
            }
        } else if (current === 'payment_under_review' || current === 'paid') {
            next = 'payment_pending';
        }

        if (!next || next === current) return;
        report.status = next;
        await this.studentReportRepository.save(report);
    }

    async revertManualPaymentApproval(
        paymentId: string,
        admin: { id: string; email?: string },
        reason?: string,
    ) {
        const payment = await this.paymentRepository.findOne({
            where: { id: paymentId },
        });

        if (!payment) {
            throw new NotFoundException('Payment record not found');
        }

        if (payment.status !== PaymentStatus.APPROVED) {
            throw new ConflictException('Only an approved payment can be reverted');
        }

        const reverted = await this.paymentRepository.update(
            { id: paymentId, status: PaymentStatus.APPROVED },
            {
                status: PaymentStatus.PENDING,
                feedback: null,
                reviewedBy: admin?.id ?? null,
                reviewedAt: new Date(),
            },
        );
        if (!reverted.affected) {
            throw new ConflictException('Only an approved payment can be reverted');
        }
        payment.status = PaymentStatus.PENDING;
        payment.feedback = null;

        await this.syncReportStatusForPaymentScope(payment);
        await this.notifyStudentOfPaymentDecision(paymentId, 'reverted', reason);

        const updated = await this.paymentRepository.findOne({
            where: { id: paymentId },
            relations: ['student', 'opportunity', 'opportunity.organization'],
        });

        return {
            success: true,
            data: updated
                ? await this.mapManualPaymentRow(updated)
                : { id: paymentId, status: PaymentStatus.PENDING },
        };
    }
}

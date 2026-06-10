import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type FindOptionsWhere } from 'typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { findCanonicalTeamLeadStudentId } from '../engagement/team-lead-canonical.util';
import { Setting } from '../settings/entities/setting.entity';
import { S3Service } from '../common/s3.service';

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
    ) { }

    async getPaymentInfo() {
        const bankName = await this.getSetting('BANK_NAME', 'Standard Chartered');
        const accountHolder = await this.getSetting('ACCOUNT_HOLDER', 'CIEL Education');
        const accountNumber = await this.getSetting('ACCOUNT_NUMBER', '000-0000000-00');
        const amount = await this.getSetting('PAYMENT_AMOUNT', '5000');

        return {
            bankName,
            accountHolder,
            accountNumber,
            amount: parseInt(amount),
        };
    }

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

    async getPendingPayments() {
        const payments = await this.participantRepository.find({
            where: { paymentStatus: 'pending_payment_approval' },
            relations: ['student', 'project', 'project.organization'],
            order: { updatedAt: 'DESC' }
        });

        return payments.map(p => ({
            id: p.id,
            studentName: p.student?.name || 'Unknown',
            studentEmail: p.student?.email || 'Unknown',
            projectTitle: p.project?.title || 'Unknown',
            organization: p.project?.organization?.name || 'Unknown',
            proofUrl: p.paymentProofUrl,
            amount: 5000, // This could be dynamic later
            submittedAt: p.paymentDate,
            status: p.paymentStatus
        }));
    }

    async verifyPayment(id: string, action: 'approve' | 'reject', feedback?: string) {
        const participant = await this.participantRepository.findOne({ where: { id } });

        if (!participant) {
            throw new NotFoundException('Payment record not found');
        }

        if (action === 'approve') {
            participant.paymentStatus = 'paid';
            participant.status = 'paid'; // Sync main status if needed
        } else {
            participant.paymentStatus = 'rejected';
            participant.status = 'rejected';
        }

        // feedback can be stored in a separate field if needed, for now we just log it or ignore
        await this.participantRepository.save(participant);

        return {
            success: true,
            message: `Payment ${action}d successfully`,
            data: {
                payment_status: participant.paymentStatus,
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

    private async buildManualPaymentTeamContext(p: Payment): Promise<{
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
        const { participation, roster } = await this.loadTeamRosterForSubmitter(p.studentId, p.projectId);
        const perMember = await this.getReportingFeePerMemberPkr();

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

    private async mapManualPaymentRow(p: Payment) {
        const teamCtx = await this.buildManualPaymentTeamContext(p);
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

    async findAllPendingManual() {
        const payments = await this.paymentRepository.find({
            where: { status: PaymentStatus.PENDING },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { created_at: 'DESC' },
        });

        return Promise.all(payments.map((p) => this.mapManualPaymentRow(p)));
    }

    async findManualPaymentsByStatus(status: PaymentStatus.APPROVED | PaymentStatus.REJECTED) {
        const payments = await this.paymentRepository.find({
            where: { status },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { created_at: 'DESC' },
        });

        return Promise.all(payments.map((p) => this.mapManualPaymentRow(p)));
    }

    async verifyManualPayment(id: string, status: PaymentStatus, feedback?: string) {
        const payment = await this.paymentRepository.findOne({
            where: { id },
        });

        if (!payment) {
            throw new NotFoundException('Payment record not found');
        }

        payment.status = status;
        if (feedback) payment.feedback = feedback;
        await this.paymentRepository.save(payment);

        // Update corresponding report status
        const report = await this.findStudentReportForPayment(payment.studentId, payment.projectId);

        if (report) {
            if (status === PaymentStatus.APPROVED) {
                // Fee cleared — partner/admin review may proceed (final verify is separate).
                report.status = 'paid';
            } else if (status === PaymentStatus.REJECTED) {
                report.status = 'payment_pending';
            }
            await this.studentReportRepository.save(report);
        }

        return {
            success: true,
            message: `Payment ${status} successfully`,
        };
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

        payment.status = PaymentStatus.PENDING;
        payment.feedback = null;
        await this.paymentRepository.save(payment);

        const report = await this.findStudentReportForPayment(payment.studentId, payment.projectId);

        if (report && report.status === 'verified') {
            report.status = 'payment_under_review';
            await this.studentReportRepository.save(report);
        }

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

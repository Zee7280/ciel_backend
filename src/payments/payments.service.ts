import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { Setting } from '../settings/entities/setting.entity';
import { S3Service } from '../common/s3.service';

import { Payment, PaymentStatus } from './entities/payment.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AuditLog } from '../audit-logs/entities/audit-log.entity';

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
        @InjectRepository(AuditLog)
        private readonly auditLogRepository: Repository<AuditLog>,
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
        const report = await this.studentReportRepository.findOne({
            where: { studentId, opportunityId: projectId },
        });

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

    private mapManualPaymentRow(p: Payment) {
        return {
            id: p.id,
            studentName: p.student?.name || 'Unknown',
            studentEmail: p.student?.email || 'Unknown',
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

        return payments.map(p => this.mapManualPaymentRow(p));
    }

    async findManualPaymentsByStatus(status: PaymentStatus.APPROVED | PaymentStatus.REJECTED) {
        const payments = await this.paymentRepository.find({
            where: { status },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { created_at: 'DESC' },
        });

        return payments.map(p => this.mapManualPaymentRow(p));
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
        const report = await this.studentReportRepository.findOne({
            where: { studentId: payment.studentId, opportunityId: payment.projectId },
        });

        if (report) {
            if (status === PaymentStatus.APPROVED) {
                report.status = 'verified';
            } else if (status === PaymentStatus.REJECTED) {
                report.status = 'submitted'; // Revert back so they can Pay again
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

        const report = await this.studentReportRepository.findOne({
            where: { studentId: payment.studentId, opportunityId: payment.projectId },
        });

        if (report && report.status === 'verified') {
            report.status = 'payment_under_review';
            await this.studentReportRepository.save(report);
        }

        const log = this.auditLogRepository.create({
            action: 'payment_approval_reverted',
            user: admin.email || admin.id,
            target: paymentId,
            target_type: 'payment',
            details: {
                adminId: admin.id,
                adminEmail: admin.email,
                paymentId,
                reason: reason ?? null,
            },
        });
        await this.auditLogRepository.save(log);

        const updated = await this.paymentRepository.findOne({
            where: { id: paymentId },
            relations: ['student', 'opportunity', 'opportunity.organization'],
        });

        return {
            success: true,
            data: updated ? this.mapManualPaymentRow(updated) : { id: paymentId, status: PaymentStatus.PENDING },
        };
    }
}

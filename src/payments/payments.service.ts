import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpportunityParticipant } from '../opportunities/entities/opportunity-participant.entity';
import { Setting } from '../settings/entities/setting.entity';
import { S3Service } from '../common/s3.service';

@Injectable()
export class PaymentsService {
    constructor(
        @InjectRepository(OpportunityParticipant)
        private readonly participantRepository: Repository<OpportunityParticipant>,
        @InjectRepository(Setting)
        private readonly settingRepository: Repository<Setting>,
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
            where: { studentId, opportunityId: projectId },
        });

        if (!participant) {
            throw new NotFoundException('Project application not found');
        }

        const proofUrl = await this.s3Service.uploadFile(file, `payments/${studentId}`);

        participant.payment_proof_url = proofUrl;
        participant.payment_status = 'pending_payment_approval';
        participant.payment_date = new Date();

        await this.participantRepository.save(participant);

        return {
            success: true,
            message: 'Payment proof submitted successfully',
            data: {
                payment_status: participant.payment_status,
                payment_proof_url: proofUrl,
            },
        };
    }

    async getPendingPayments() {
        const payments = await this.participantRepository.find({
            where: { payment_status: 'pending_payment_approval' },
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { updatedAt: 'DESC' }
        });

        return payments.map(p => ({
            id: p.id,
            studentName: p.student?.name || 'Unknown',
            studentEmail: p.student?.email || 'Unknown',
            projectTitle: p.opportunity?.title || 'Unknown',
            organization: p.opportunity?.organization?.name || 'Unknown',
            proofUrl: p.payment_proof_url,
            amount: 5000, // This could be dynamic later
            submittedAt: p.payment_date,
            status: p.payment_status
        }));
    }

    async verifyPayment(id: string, action: 'approve' | 'reject', feedback?: string) {
        const participant = await this.participantRepository.findOne({ where: { id } });

        if (!participant) {
            throw new NotFoundException('Payment record not found');
        }

        if (action === 'approve') {
            participant.payment_status = 'paid';
        } else {
            participant.payment_status = 'rejected';
        }

        // feedback can be stored in a separate field if needed, for now we just log it or ignore
        await this.participantRepository.save(participant);

        return {
            success: true,
            message: `Payment ${action}d successfully`,
            data: {
                payment_status: participant.payment_status,
            },
        };
    }
}

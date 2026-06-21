import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, In } from 'typeorm';
import { OrganizationMembershipFee } from './entities/organization-membership-fee.entity';
import { User } from '../users/entities/user.entity';
import { Setting } from '../settings/entities/setting.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { MEMBERSHIP_FEE_DEFAULT_PKR } from './membership-fee.defaults';
import { PartnerMembershipSettingsService } from './partner-membership-settings.service';

const SETTING_KEY_UNI = 'MEMBERSHIP_FEE_UNIVERSITY_PKR';
const SETTING_KEY_CORP = 'MEMBERSHIP_FEE_CORPORATE_PKR';
const SETTING_KEY_PARTNER = 'MEMBERSHIP_FEE_PARTNER_PKR';

export type MembershipFeeSubmissionUi = 'none' | 'pending_review' | 'approved' | 'rejected';

export type AdminMembershipFeeRowDto = {
    id: string;
    userId: string;
    organizationId: string | null;
    paidAmountPkr: number;
    proofUrl: string;
    status: string;
    createdAt: Date;
    reviewedAt: Date | null;
    adminFeedback: string | null;
    reviewedByUserId: string | null;
    user: {
        id: string;
        name: string;
        email: string;
        role: string;
        accountStatus: string;
        phone: string | null;
        city: string | null;
        orgName: string | null;
        orgType: string | null;
        contactPerson: string | null;
        institution: string | null;
        university: string | null;
        department: string | null;
    } | null;
    organization: {
        id: string;
        name: string;
        orgType: string;
        description: string | null;
        city: string | null;
        region: string | null;
        address: string | null;
        country: string;
        websiteUrl: string | null;
        logoUrl: string | null;
        contactName: string | null;
        contactEmail: string | null;
        contactPhone: string | null;
        verificationStatus: string;
        safeguardingAcknowledged: boolean;
        dataPolicyAcknowledged: boolean;
    } | null;
};

@Injectable()
export class OrganizationMembershipService {
    constructor(
        @InjectRepository(OrganizationMembershipFee)
        private readonly feeRepo: Repository<OrganizationMembershipFee>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        @InjectRepository(Setting)
        private readonly settingRepo: Repository<Setting>,
        private readonly partnerMembershipSettings: PartnerMembershipSettingsService,
    ) { }

    async roleRequiresMembershipPayment(role: UserRole): Promise<boolean> {
        if (role === UserRole.UNIVERSITY || role === UserRole.CORPORATE) {
            return true;
        }
        if (role === UserRole.NGO) {
            return this.partnerMembershipSettings.isPartnerMembershipRequired();
        }
        return false;
    }

    roleRequiresMembershipPaymentSync(role: UserRole): boolean {
        if (role === UserRole.UNIVERSITY || role === UserRole.CORPORATE) {
            return true;
        }
        if (role === UserRole.NGO) {
            return this.partnerMembershipSettings.isPartnerMembershipRequiredCached();
        }
        return false;
    }

    async releasePendingPartnerMembershipAccounts(): Promise<number> {
        const result = await this.userRepo.update(
            { role: UserRole.NGO, status: 'pending_membership_payment' },
            { status: 'active' },
        );
        return result.affected ?? 0;
    }

    async getExpectedFeePkr(role: UserRole): Promise<number> {
        const key =
            role === UserRole.UNIVERSITY
                ? SETTING_KEY_UNI
                : role === UserRole.CORPORATE
                  ? SETTING_KEY_CORP
                  : SETTING_KEY_PARTNER;
        const envFallback =
            role === UserRole.UNIVERSITY
                ? process.env.MEMBERSHIP_FEE_UNIVERSITY_PKR
                : role === UserRole.CORPORATE
                  ? process.env.MEMBERSHIP_FEE_CORPORATE_PKR
                  : process.env.MEMBERSHIP_FEE_PARTNER_PKR;
        const row = await this.settingRepo.findOne({ where: { key } });
        const raw = row?.value ?? envFallback ?? String(MEMBERSHIP_FEE_DEFAULT_PKR);
        const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) && n > 0 ? n : MEMBERSHIP_FEE_DEFAULT_PKR;
    }

    async getUiFlags(user: User): Promise<{
        requires_membership_payment: boolean;
        membership_fee_submission_status: MembershipFeeSubmissionUi | null;
        membership_fee_amount_pkr: number | null;
    }> {
        if (!(await this.roleRequiresMembershipPayment(user.role))) {
            return {
                requires_membership_payment: false,
                membership_fee_submission_status: null,
                membership_fee_amount_pkr: null,
            };
        }
        const amount = await this.getExpectedFeePkr(user.role);
        const approvedSubmission = await this.latestSubmissionForUserOrOrganization(user, 'approved');
        if (approvedSubmission) {
            if (user.status === 'pending_membership_payment') {
                await this.activateMembershipAccounts(user.id, user.organization?.id ?? approvedSubmission.organizationId);
                user.status = 'active';
            }
            return {
                requires_membership_payment: false,
                membership_fee_submission_status: 'approved',
                membership_fee_amount_pkr: amount,
            };
        }
        if (user.status !== 'pending_membership_payment') {
            return {
                requires_membership_payment: false,
                membership_fee_submission_status: null,
                membership_fee_amount_pkr: amount,
            };
        }
        const latest = await this.latestSubmissionForUserOrOrganization(user);
        let membership_fee_submission_status: MembershipFeeSubmissionUi = 'none';
        if (latest) {
            if (latest.status === 'pending_review') {
                membership_fee_submission_status = 'pending_review';
            } else if (latest.status === 'approved') {
                membership_fee_submission_status = 'approved';
            } else {
                membership_fee_submission_status = 'rejected';
            }
        }
        return {
            requires_membership_payment: true,
            membership_fee_submission_status,
            membership_fee_amount_pkr: amount,
        };
    }

    private latestSubmissionForUserOrOrganization(
        user: User,
        status?: OrganizationMembershipFee['status'],
    ): Promise<OrganizationMembershipFee | null> {
        const organizationId = user.organization?.id;
        const qb = this.feeRepo
            .createQueryBuilder('fee')
            .where(
                new Brackets((sub) => {
                    sub.where('fee.userId = :userId', { userId: user.id });
                    if (organizationId) {
                        sub.orWhere('fee.organizationId = :organizationId', { organizationId });
                    }
                }),
            );
        if (status) {
            qb.andWhere('fee.status = :status', { status });
        }
        return qb.orderBy('fee.createdAt', 'DESC').getOne();
    }

    private async activateMembershipAccounts(userId: string, organizationId?: string | null) {
        await this.userRepo.update(userId, { status: 'active' });
        if (organizationId) {
            await this.userRepo
                .createQueryBuilder()
                .update(User)
                .set({ status: 'active' })
                .where('organizationId = :organizationId', { organizationId })
                .andWhere('status = :status', { status: 'pending_membership_payment' })
                .execute();
        }
    }

    async submitProof(userId: string, proofUrl: string, paidAmountRaw?: string): Promise<{ success: boolean; message: string }> {
        const user = await this.userRepo.findOne({
            where: { id: userId },
            relations: ['organization'],
        });
        if (!user) {
            throw new NotFoundException('User not found');
        }
        if (!(await this.roleRequiresMembershipPayment(user.role))) {
            throw new BadRequestException('Membership fee does not apply to this account');
        }
        if (user.status !== 'pending_membership_payment') {
            throw new BadRequestException('No membership payment is required for this account');
        }
        const existingPending = await this.feeRepo.findOne({
            where: { userId, status: 'pending_review' },
        });
        if (existingPending) {
            throw new ConflictException('A payment proof is already awaiting review');
        }
        const expected = await this.getExpectedFeePkr(user.role);
        let paidAmount = expected;
        if (paidAmountRaw !== undefined && paidAmountRaw !== '') {
            const parsed = parseInt(String(paidAmountRaw).replace(/[^\d]/g, ''), 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new BadRequestException('Invalid paid_amount');
            }
            paidAmount = parsed;
        }
        const row = this.feeRepo.create({
            userId,
            organizationId: user.organization?.id ?? null,
            paidAmountPkr: paidAmount,
            proofUrl,
            status: 'pending_review',
        });
        await this.feeRepo.save(row);
        return {
            success: true,
            message: 'Payment proof submitted. An administrator will review it shortly.',
        };
    }

    async listPendingReview(): Promise<AdminMembershipFeeRowDto[]> {
        const rows = await this.feeRepo.find({
            where: { status: 'pending_review' },
            relations: ['user', 'user.organization'],
            order: { createdAt: 'ASC' },
        });
        return rows.map((r) => this.formatAdminMembershipRow(r));
    }

    async listHistoryForAdmin(take = 150): Promise<AdminMembershipFeeRowDto[]> {
        const rows = await this.feeRepo.find({
            where: { status: In(['approved', 'rejected']) },
            relations: ['user', 'user.organization'],
            order: { reviewedAt: 'DESC' },
            take,
        });
        return rows.map((r) => this.formatAdminMembershipRow(r));
    }

    private formatAdminMembershipRow(r: OrganizationMembershipFee): AdminMembershipFeeRowDto {
        const u = r.user;
        const org = u?.organization ?? null;
        return {
            id: r.id,
            userId: r.userId,
            organizationId: r.organizationId,
            paidAmountPkr: r.paidAmountPkr,
            proofUrl: r.proofUrl,
            status: r.status,
            createdAt: r.createdAt,
            reviewedAt: r.reviewedAt ?? null,
            adminFeedback: r.adminFeedback ?? null,
            reviewedByUserId: r.reviewedByUserId ?? null,
            user: u
                ? {
                      id: u.id,
                      name: u.name,
                      email: u.email,
                      role: u.role,
                      accountStatus: u.status,
                      phone: u.phone ?? null,
                      city: u.city ?? null,
                      orgName: u.orgName ?? null,
                      orgType: u.orgType ?? null,
                      contactPerson: u.contactPerson ?? null,
                      institution: u.institution ?? null,
                      university: u.university ?? null,
                      department: u.department ?? null,
                  }
                : null,
            organization: org
                ? {
                      id: org.id,
                      name: org.name,
                      orgType: org.orgType,
                      description: org.description ?? null,
                      city: org.city ?? null,
                      region: org.region ?? null,
                      address: org.address ?? null,
                      country: org.country,
                      websiteUrl: org.websiteUrl ?? null,
                      logoUrl: org.logoUrl ?? null,
                      contactName: org.contactName ?? null,
                      contactEmail: org.contactEmail ?? null,
                      contactPhone: org.contactPhone ?? null,
                      verificationStatus: org.verificationStatus,
                      safeguardingAcknowledged: org.safeguardingAcknowledged,
                      dataPolicyAcknowledged: org.dataPolicyAcknowledged,
                  }
                : null,
        };
    }

    async approveSubmission(id: string, adminUserId: string): Promise<OrganizationMembershipFee> {
        const row = await this.feeRepo.findOne({
            where: { id },
            relations: ['user'],
        });
        if (!row) {
            throw new NotFoundException('Submission not found');
        }
        if (row.status !== 'pending_review') {
            throw new BadRequestException('This submission is not pending review');
        }
        row.status = 'approved';
        row.reviewedByUserId = adminUserId;
        row.reviewedAt = new Date();
        await this.feeRepo.save(row);
        await this.activateMembershipAccounts(row.userId, row.organizationId);
        return row;
    }

    async rejectSubmission(id: string, adminUserId: string, feedback?: string): Promise<OrganizationMembershipFee> {
        const row = await this.feeRepo.findOne({
            where: { id },
            relations: ['user'],
        });
        if (!row) {
            throw new NotFoundException('Submission not found');
        }
        if (row.status !== 'pending_review') {
            throw new BadRequestException('This submission is not pending review');
        }
        row.status = 'rejected';
        row.adminFeedback = feedback?.trim() || null;
        row.reviewedByUserId = adminUserId;
        row.reviewedAt = new Date();
        await this.feeRepo.save(row);
        return row;
    }
}

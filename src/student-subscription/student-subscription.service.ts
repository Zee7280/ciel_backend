import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StudentSubscriptionFee } from './entities/student-subscription-fee.entity';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  normalizeUniversityName,
  universityNamesMatch,
  parseStudentSubscriptionFeePkr,
  parseStudentSubscriptionRequiredSettingValue,
  PENDING_SUBSCRIPTION_STATUS,
  STUDENT_SUBSCRIPTION_FEE_PKR_KEY,
  STUDENT_SUBSCRIPTION_REQUIRED_KEY,
} from './student-subscription.util';

export type SubscriptionSubmissionUi =
  | 'none'
  | 'pending_review'
  | 'approved'
  | 'rejected';

export type StudentSubscriptionUiFlags = {
  requires_subscription_payment: boolean;
  subscription_fee_submission_status: SubscriptionSubmissionUi | null;
  subscription_fee_amount_pkr: number | null;
  /** Why the fee applies, for the payment screen. */
  subscription_reason: string | null;
};

export type AdminStudentSubscriptionRow = {
  id: string;
  userId: string;
  universityName: string | null;
  paidAmountPkr: number;
  expectedAmountPkr: number | null;
  amountMismatch: boolean;
  proofUrl: string;
  status: string;
  adminFeedback: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    role: string | null;
    accountStatus: string | null;
    phone: string | null;
    city: string | null;
    institution: string | null;
    university: string | null;
    department: string | null;
  } | null;
};

const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;

@Injectable()
export class StudentSubscriptionService {
  constructor(
    @InjectRepository(StudentSubscriptionFee)
    private readonly feeRepo: Repository<StudentSubscriptionFee>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly organizationRepo: Repository<Organization>,
    private readonly platformSettings: PlatformSettingsService,
    @Optional() private readonly mailService?: MailService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /* ------------------------------------------------------------------ settings */

  async isRequired(): Promise<boolean> {
    return parseStudentSubscriptionRequiredSettingValue(
      await this.platformSettings.getString(STUDENT_SUBSCRIPTION_REQUIRED_KEY),
      true,
    );
  }

  async getFeePkr(): Promise<number> {
    return parseStudentSubscriptionFeePkr(
      await this.platformSettings.getString(STUDENT_SUBSCRIPTION_FEE_PKR_KEY),
    );
  }

  /* ------------------------------------------------------------------ eligibility */

  /**
   * A "member university" is an approved Organization of university type that matches the student's
   * declared university. Names are compared tolerantly: exact (normalized), the acronym in parentheses
   * (e.g. "Beaconhouse National University (BNU)" ↔ an org named "BNU"), or one name containing the
   * other, because university organizations are sometimes registered under a short name.
   * Students of member universities never pay the subscription fee.
   */
  async isMemberUniversity(
    ...names: Array<string | null | undefined>
  ): Promise<boolean> {
    const candidates = Array.from(
      new Set(names.map((n) => normalizeUniversityName(n)).filter(Boolean)),
    );
    if (candidates.length === 0) return false;
    const orgs = await this.organizationRepo.find({
      select: ['name', 'orgType', 'verificationStatus'],
    });
    const memberNames = orgs
      .filter(
        (o) =>
          String(o.orgType || '')
            .toLowerCase()
            .includes('university') &&
          String(o.verificationStatus || '').toUpperCase() === 'APPROVED',
      )
      .map((o) => normalizeUniversityName(o.name))
      .filter(Boolean);
    return candidates.some((c) =>
      memberNames.some((m) => universityNamesMatch(c, m)),
    );
  }

  /**
   * Signup decision: does this new student start in `pending_subscription_payment`?
   * Only students, only while the admin switch is on, and only when their university is not a member.
   */
  async studentNeedsSubscriptionAtSignup(input: {
    role: string;
    institution?: string | null;
    university?: string | null;
  }): Promise<boolean> {
    const role = String(input.role || '').toLowerCase() as UserRole;
    if (role !== UserRole.STUDENT) return false;
    if (!(await this.isRequired())) return false;
    return !(await this.isMemberUniversity(
      input.institution,
      input.university,
    ));
  }

  /** Admin turned the switch off: every student still waiting on the fee gets full access. */
  async releasePendingStudentAccounts(): Promise<number> {
    const result = await this.userRepo.update(
      { role: UserRole.STUDENT, status: PENDING_SUBSCRIPTION_STATUS },
      { status: 'active' },
    );
    return result.affected ?? 0;
  }

  /* ------------------------------------------------------------------ student side */

  private latestSubmission(
    userId: string,
    status?: StudentSubscriptionFee['status'],
  ): Promise<StudentSubscriptionFee | null> {
    return this.feeRepo.findOne({
      where: status ? { userId, status } : { userId },
      order: { createdAt: 'DESC' },
    });
  }

  private async activateAccount(userId: string): Promise<void> {
    // Only release an account still waiting on the fee — never re-activate one an admin suspended.
    await this.userRepo.update(
      { id: userId, status: PENDING_SUBSCRIPTION_STATUS },
      { status: 'active' },
    );
  }

  /** Flags merged into `/users/me` and the login/signup user payload. */
  async getUiFlags(user: User): Promise<StudentSubscriptionUiFlags> {
    const none: StudentSubscriptionUiFlags = {
      requires_subscription_payment: false,
      subscription_fee_submission_status: null,
      subscription_fee_amount_pkr: null,
      subscription_reason: null,
    };
    if (user.role !== UserRole.STUDENT) return none;
    if (user.status !== PENDING_SUBSCRIPTION_STATUS) return none;

    const amount = await this.getFeePkr();
    const approved = await this.latestSubmission(user.id, 'approved');
    if (approved) {
      // Approved but the status update was missed (or the row was approved out of band): self-heal.
      await this.activateAccount(user.id);
      user.status = 'active';
      return {
        ...none,
        subscription_fee_submission_status: 'approved',
        subscription_fee_amount_pkr: amount,
      };
    }
    // The fee no longer applies: the admin switched it off (possibly on another instance), or the
    // student's university has since become an approved member. Release without a payment.
    if (
      !(await this.isRequired()) ||
      (await this.isMemberUniversity(user.university, user.institution))
    ) {
      await this.activateAccount(user.id);
      user.status = 'active';
      return none;
    }
    const latest = await this.latestSubmission(user.id);
    let submission: SubscriptionSubmissionUi = 'none';
    if (latest) {
      submission =
        latest.status === 'pending_review'
          ? 'pending_review'
          : latest.status === 'approved'
            ? 'approved'
            : 'rejected';
    }
    const uniRaw = (user.university || user.institution || '').trim();
    // "Other" is the catch-all option in the signup list, not a university name.
    const uni = uniRaw.toLowerCase() === 'other' ? '' : uniRaw;
    return {
      requires_subscription_payment: true,
      subscription_fee_submission_status: submission,
      subscription_fee_amount_pkr: amount,
      subscription_reason: uni
        ? `${uni} is not a CIEL member university, so a one-time subscription fee applies.`
        : 'Your university is not a CIEL member university, so a one-time subscription fee applies.',
    };
  }

  async getStatusForStudent(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const flags = await this.getUiFlags(user);
    const latest = await this.latestSubmission(userId);
    return {
      ...flags,
      account_status: user.status,
      latest_submission: latest
        ? {
            id: latest.id,
            status: latest.status,
            paid_amount_pkr: latest.paidAmountPkr,
            admin_feedback: latest.adminFeedback,
            created_at: latest.createdAt,
            reviewed_at: latest.reviewedAt,
          }
        : null,
    };
  }

  async submitProof(
    userId: string,
    proofUrl: string,
    paidAmountRaw?: string,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== UserRole.STUDENT) {
      throw new BadRequestException(
        'The subscription fee only applies to student accounts',
      );
    }
    if (user.status !== PENDING_SUBSCRIPTION_STATUS) {
      throw new BadRequestException(
        'No subscription payment is required for this account',
      );
    }
    const existingPending = await this.feeRepo.findOne({
      where: { userId, status: 'pending_review' },
    });
    if (existingPending) {
      throw new ConflictException('A payment proof is already awaiting review');
    }
    const expected = await this.getFeePkr();
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
      universityName:
        (user.university || user.institution || '').trim() || null,
      paidAmountPkr: paidAmount,
      expectedAmountPkr: expected,
      proofUrl,
      status: 'pending_review',
    });
    await this.feeRepo.save(row);
    return {
      success: true,
      message:
        'Payment proof submitted. An administrator will review it shortly.',
    };
  }

  /* ------------------------------------------------------------------ admin side */

  private formatRow(row: StudentSubscriptionFee): AdminStudentSubscriptionRow {
    const u = row.user;
    const expected = row.expectedAmountPkr ?? null;
    return {
      id: row.id,
      userId: row.userId,
      universityName: row.universityName,
      paidAmountPkr: row.paidAmountPkr,
      expectedAmountPkr: expected,
      amountMismatch:
        expected != null && expected > 0 && expected !== row.paidAmountPkr,
      proofUrl: row.proofUrl,
      status: row.status,
      adminFeedback: row.adminFeedback,
      reviewedByUserId: row.reviewedByUserId,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      user: u
        ? {
            id: u.id,
            name: u.name ?? null,
            email: u.email ?? null,
            role: u.role ?? null,
            accountStatus: u.status ?? null,
            phone: u.phone ?? null,
            city: u.city ?? null,
            institution: u.institution ?? null,
            university: u.university ?? null,
            department: u.department ?? null,
          }
        : null,
    };
  }

  async listPendingReview(): Promise<AdminStudentSubscriptionRow[]> {
    const rows = await this.feeRepo.find({
      where: { status: 'pending_review' },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.formatRow(r));
  }

  async listHistoryPaged(opts?: { page?: string; limit?: string }) {
    const page = Math.max(1, parseInt(String(opts?.page ?? '1'), 10) || 1);
    const limitRaw = parseInt(String(opts?.limit ?? HISTORY_DEFAULT_LIMIT), 10);
    const limit = Math.min(
      HISTORY_MAX_LIMIT,
      Math.max(1, Number.isFinite(limitRaw) ? limitRaw : HISTORY_DEFAULT_LIMIT),
    );
    const [rows, total] = await this.feeRepo
      .createQueryBuilder('fee')
      .leftJoinAndSelect('fee.user', 'user')
      .where('fee.status IN (:...statuses)', {
        statuses: ['approved', 'rejected'],
      })
      .orderBy('fee.reviewedAt', 'DESC', 'NULLS LAST')
      .addOrderBy('fee.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { rows: rows.map((r) => this.formatRow(r)), total, page, limit };
  }

  async approveSubmission(
    id: string,
    adminUserId: string,
    opts?: { allowAmountMismatch?: boolean },
  ): Promise<StudentSubscriptionFee> {
    const row = await this.feeRepo.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!row) throw new NotFoundException('Submission not found');
    if (row.status !== 'pending_review') {
      throw new BadRequestException('This submission is not pending review');
    }
    const expected = row.expectedAmountPkr ?? (await this.getFeePkr());
    if (!opts?.allowAmountMismatch && row.paidAmountPkr !== expected) {
      throw new BadRequestException(
        `Paid amount (PKR ${row.paidAmountPkr}) does not match the expected fee (PKR ${expected}). Re-send with allowAmountMismatch=true to approve anyway.`,
      );
    }
    const reviewedAt = new Date();
    const result = await this.feeRepo.update(
      { id, status: 'pending_review' },
      { status: 'approved', reviewedByUserId: adminUserId, reviewedAt },
    );
    if (!result.affected) {
      throw new BadRequestException('This submission is not pending review');
    }
    row.status = 'approved';
    row.reviewedByUserId = adminUserId;
    row.reviewedAt = reviewedAt;
    await this.activateAccount(row.userId);
    await this.notifyDecision(row.userId, row.user?.email, 'approved');
    return row;
  }

  async rejectSubmission(
    id: string,
    adminUserId: string,
    feedback?: string,
  ): Promise<StudentSubscriptionFee> {
    const row = await this.feeRepo.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!row) throw new NotFoundException('Submission not found');
    if (row.status !== 'pending_review') {
      throw new BadRequestException('This submission is not pending review');
    }
    const reviewedAt = new Date();
    const adminFeedback = feedback?.trim() || null;
    const result = await this.feeRepo.update(
      { id, status: 'pending_review' },
      {
        status: 'rejected',
        adminFeedback,
        reviewedByUserId: adminUserId,
        reviewedAt,
      },
    );
    if (!result.affected) {
      throw new BadRequestException('This submission is not pending review');
    }
    row.status = 'rejected';
    row.adminFeedback = adminFeedback;
    row.reviewedByUserId = adminUserId;
    row.reviewedAt = reviewedAt;
    await this.notifyDecision(
      row.userId,
      row.user?.email,
      'rejected',
      adminFeedback,
    );
    return row;
  }

  /** Best-effort in-app + email notice; a failure here never fails the decision. */
  private async notifyDecision(
    userId: string,
    email: string | null | undefined,
    decision: 'approved' | 'rejected',
    feedback?: string | null,
  ): Promise<void> {
    const title =
      decision === 'approved'
        ? 'Subscription fee approved'
        : 'Subscription fee payment rejected';
    const message =
      decision === 'approved'
        ? 'Your subscription fee payment was approved. Your student portal is now active.'
        : 'Your subscription fee payment proof was rejected. Please submit a new payment proof.';
    try {
      await this.notificationsService?.createApprovalNotification(
        userId,
        title,
        message,
      );
    } catch {
      /* ignore */
    }
    try {
      if (this.mailService && email) {
        await this.mailService.sendStudentOpportunityStatusUpdate(
          email,
          'CIEL PK student subscription',
          title,
          title,
          message,
          decision === 'rejected' ? feedback : null,
        );
      }
    } catch {
      /* ignore */
    }
  }
}

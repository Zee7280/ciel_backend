import { randomUUID } from 'crypto';
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { CreateOpportunityDto } from '../opportunities/dto/create-opportunity.dto';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { ApplyOpportunityDto } from './dto/apply-opportunity.dto';
import { LogHoursDto } from './dto/log-hours.dto';
import { UpdateStudentProfileDto } from './dto/update-profile.dto';

import { Participation } from '../engagement/entities/participant.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { Otp } from './entities/otp.entity';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { EngagementService } from '../engagement/engagement.service';
import {
    LINE_STATUS,
    OpportunityWorkflowService,
    WORKFLOW_STAGE,
} from '../opportunities/opportunity-workflow.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';
import { isTeamApplyFromParticipationAndMembers } from '../opportunities/apply-team-payload.util';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { StudentReportsService } from '../reports/student-reports.service';

@Injectable()
export class StudentsService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(Timesheet)
        private timesheetsRepository: Repository<Timesheet>,
        @InjectRepository(Participation)
        private participantRepository: Repository<Participation>,
        @InjectRepository(StudentReport)
        private studentReportsRepository: Repository<StudentReport>,
        @InjectRepository(Organization)
        private orgRepository: Repository<Organization>,
        @InjectRepository(Otp)
        private otpRepository: Repository<Otp>,
        private usersService: UsersService,
        private mailService: MailService,
        private engagementService: EngagementService,
        private readonly opportunityWorkflow: OpportunityWorkflowService,
        private readonly opportunitiesService: OpportunitiesService,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
        private readonly studentReportsService: StudentReportsService,
    ) { }

    private normalize(str?: string | null) {
        return (str || '').trim().toLowerCase();
    }

    private hasMeaningfulObjectValue(value: unknown): boolean {
        if (!value || typeof value !== 'object') return false;
        return Object.values(value as Record<string, unknown>).some((v) => {
            if (Array.isArray(v)) return v.length > 0;
            if (v && typeof v === 'object') return this.hasMeaningfulObjectValue(v);
            return v !== null && v !== undefined && String(v).trim() !== '';
        });
    }

    private opportunityHasPartner(opportunity: Opportunity): boolean {
        return Boolean(
            opportunity.organizationId ||
            this.hasMeaningfulObjectValue(opportunity.partner_organization) ||
            this.hasMeaningfulObjectValue(opportunity.executing_organization) ||
            opportunity.requiresPartnerApproval,
        );
    }

    private async getOccupiedSeats(opportunityId: string): Promise<number> {
        const participationSeats = await this.participantRepository.count({
            where: {
                projectId: opportunityId,
                status: In(['pending', 'accepted', 'approved', 'verified', 'paid', 'pending_payment_approval', 'pending_ciel_approval', 'pending_faculty_approval'])
            }
        });
        const pipelineSeats = await this.opportunityApplicationsService.countSeatsInFlight(opportunityId);
        return participationSeats + pipelineSeats;
    }

    private readonly liveOpportunityStatuses = ['active', 'live', 'open', 'recruiting'];

    private normalizeOpportunityStatus(status?: string | null): string | null {
        const normalized = this.normalize(status);
        if (!normalized) return null;
        if (this.liveOpportunityStatuses.includes(normalized)) return 'live';
        if (['completed', 'complete', 'verified', 'finalized'].includes(normalized)) return 'completed';
        if (['closed', 'inactive', 'draft', 'rejected', 'cancelled', 'canceled'].includes(normalized)) {
            return 'closed';
        }
        return normalized;
    }

    private normalizeApplicationStatus(status?: string | null): string | null {
        const normalized = this.normalize(status);
        if (!normalized) return null;
        if (['pending', 'pending_payment_approval', 'pending_ciel_approval', 'pending_faculty_approval'].includes(normalized)) {
            return 'pending_approval';
        }
        if (normalized === 'verified') return 'verified';
        if (['approved', 'accepted', 'paid', 'finalized'].includes(normalized)) {
            return 'approved';
        }
        if (['rejected', 'not_approved', 'denied', 'declined'].includes(normalized)) {
            return 'rejected';
        }
        if (normalized === 'withdrawn') return 'withdrawn';
        return normalized;
    }

    /** Participation rows that mean the student is already in (or past) the program — block another apply. */
    private isParticipationActivelyEnrolled(status?: string | null): boolean {
        if (!status) return false;
        return ['approved', 'verified', 'accepted', 'finalized', 'paid'].includes(status);
    }

    private isParticipationPendingPipeline(status?: string | null): boolean {
        if (!status) return false;
        return ['pending', 'pending_payment_approval', 'pending_ciel_approval', 'pending_faculty_approval'].includes(
            status,
        );
    }

    private async findLatestParticipationForProjectAndMemberEmail(
        projectId: string,
        emailNorm: string,
    ): Promise<Participation | null> {
        const user = await this.usersRepository
            .createQueryBuilder('u')
            .where('LOWER(TRIM(COALESCE(u.email, \'\'))) = :em', { em: emailNorm })
            .getOne();

        const qb = this.participantRepository
            .createQueryBuilder('p')
            .where('p.projectId = :projectId', { projectId })
            .andWhere(
                new Brackets((w) => {
                    w.where('LOWER(TRIM(COALESCE(p.email, \'\'))) = :emailNorm', { emailNorm });
                    if (user?.id) {
                        w.orWhere('p.studentId = :studentId', { studentId: user.id });
                    }
                }),
            )
            .orderBy('p.createdAt', 'DESC');

        return qb.getOne();
    }

    /**
     * Block listing someone who already has a participation row on this project (another team / solo),
     * except when their only row was rejected (re-apply path).
     */
    private async assertTeamMembersNotAlreadySeatedOnOpportunity(
        opportunityId: string,
        members: NonNullable<ApplyOpportunityDto['team_members']>,
    ): Promise<void> {
        for (const member of members) {
            const raw = typeof member?.email === 'string' ? member.email.trim() : '';
            const emailNorm = raw.toLowerCase();
            if (!emailNorm) continue;
            const row = await this.findLatestParticipationForProjectAndMemberEmail(opportunityId, emailNorm);
            if (!row) continue;
            if (row.status === 'rejected') continue;
            const label = raw || emailNorm;
            if (this.isParticipationActivelyEnrolled(row.status)) {
                throw new BadRequestException(
                    `Team member ${label} is already enrolled on this opportunity.`,
                );
            }
            if (this.isParticipationPendingPipeline(row.status)) {
                throw new BadRequestException(
                    `Team member ${label} already has a pending seat on this opportunity.`,
                );
            }
            throw new BadRequestException(
                `Team member ${label} is already associated with this opportunity.`,
            );
        }
    }

    private isLiveOpportunityStatus(status?: string | null): boolean {
        return this.normalizeOpportunityStatus(status) === 'live';
    }

    private safeDashboardNumber(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    private resolveDisplayNameForUser(user: User): string {
        const fromUser = typeof user.name === 'string' ? user.name.trim() : '';
        if (fromUser) return fromUser;
        const fromOrg =
            user.organization?.contactName != null ? String(user.organization.contactName).trim() : '';
        return fromOrg || '';
    }

    private resolvePhoneForUser(user: User): string {
        const org = user.organization;
        return (
            (typeof user.phone === 'string' && user.phone.trim()) ||
            (org?.contactPhone && String(org.contactPhone).trim()) ||
            ''
        );
    }

    /**
     * Aligns with opportunity submission `ensureProfileComplete` checks for students
     * so completion % matches the same required fields (including conditional CNIC / profile verification flags).
     */
    private computeStudentProfileCompletion(user: User): {
        completed_required_fields: number;
        total_required_fields: number;
        profile_completion_percent: number;
    } {
        const satisfied: boolean[] = [];
        satisfied.push(Boolean(this.resolveDisplayNameForUser(user)));
        satisfied.push(Boolean(this.resolvePhoneForUser(user)));
        satisfied.push(Boolean(typeof user.email === 'string' && user.email.trim()));
        satisfied.push(Boolean(typeof user.city === 'string' && user.city.trim()));
        satisfied.push(
            Boolean(
                (typeof user.university === 'string' && user.university.trim()) ||
                    (typeof user.institution === 'string' && user.institution.trim()),
            ),
        );
        satisfied.push(Boolean(typeof user.department === 'string' && user.department.trim()));
        if (user.requires_cnic) {
            satisfied.push(Boolean(typeof user.cnic === 'string' && user.cnic.trim()));
        }
        if (user.requires_profile_verification) {
            satisfied.push(user.profile_verified === true);
        }
        const total_required_fields = satisfied.length;
        const completed_required_fields = satisfied.filter(Boolean).length;
        const profile_completion_percent =
            total_required_fields === 0
                ? 100
                : Math.round((completed_required_fields / total_required_fields) * 100);
        return { completed_required_fields, total_required_fields, profile_completion_percent };
    }

    /** Uses `timeline.expected_hours` when positive, otherwise the opportunity `requiredHours` column. */
    private resolveRequiredHoursPerStudent(project: Opportunity | null | undefined): number {
        if (!project) return 0;
        const fromTimeline = this.safeDashboardNumber(project.timeline?.expected_hours);
        if (fromTimeline > 0) return fromTimeline;
        return this.safeDashboardNumber(project.requiredHours);
    }

    /**
     * Bucket key for counting peers on the same project team (`team_id` or shared application batch).
     * Individual participations are counted alone.
     */
    private participationTeamBucketKey(
        p: Pick<Participation, 'id' | 'participationMode' | 'teamId' | 'applicationId'>,
    ): string {
        if (p.participationMode !== 'team') {
            return `ind:${p.id}`;
        }
        const tid = typeof p.teamId === 'string' ? p.teamId.trim() : '';
        if (tid) return `tid:${tid}`;
        if (p.applicationId) return `aid:${p.applicationId}`;
        return `ind:${p.id}`;
    }

    /**
     * Full roster for My Projects team modal: same join batch (`applicationId`) and, for team applies,
     * everyone with the same `teamId` on the project (teammates sometimes lack `applicationId`).
     */
    private async participationRowsForStudentProjectTeam(app: Participation): Promise<Participation[]> {
        const projectId = app.projectId;
        const merged = new Map<string, Participation>();

        if (app.applicationId) {
            const byApplication = await this.participantRepository.find({
                where: { projectId, applicationId: app.applicationId },
            });
            for (const row of byApplication) {
                merged.set(row.id, row);
            }
        }

        const teamId = typeof app.teamId === 'string' ? app.teamId.trim() : '';
        // Same-project roster by team slug — do not require participationMode === 'team' on every row (defaults stay `individual`).
        if (teamId) {
            const byTeam = await this.participantRepository.find({
                where: { projectId, teamId },
            });
            for (const row of byTeam) {
                merged.set(row.id, row);
            }
        }

        if (app.applicationId) {
            const payloadEmails =
                await this.opportunityApplicationsService.findApplyPayloadTeamMemberEmails(app.applicationId);
            if (payloadEmails.length > 0) {
                const byEmail = await this.participantRepository
                    .createQueryBuilder('p')
                    .where('p.projectId = :projectId', { projectId })
                    .andWhere('LOWER(TRIM(COALESCE(p.email, \'\'))) IN (:...emails)', { emails: payloadEmails })
                    .getMany();
                for (const row of byEmail) {
                    merged.set(row.id, row);
                }
            }
        }

        if (merged.size === 0) {
            return [app];
        }

        return Array.from(merged.values()).sort((a, b) => {
            if (a.isTeamLead !== b.isTeamLead) {
                return a.isTeamLead ? -1 : 1;
            }
            return (a.fullName || '').localeCompare(b.fullName || '');
        });
    }

    /**
     * Admin pending participation queue (`findPendingApplications`): team roster aligned with browse queue shape.
     */
    async getAdminTeamRosterForParticipation(
        participationId: string,
    ): Promise<{
        team_member_count: number;
        team_members: { name: string; email: string; is_team_lead: boolean }[];
    } | null> {
        const app = await this.participantRepository.findOne({ where: { id: participationId } });
        if (!app || app.participationMode !== 'team') {
            return null;
        }
        const rows = await this.participationRowsForStudentProjectTeam(app);
        const team_members = rows.map((row) => ({
            name: (row.fullName || '').trim() || '—',
            email: (row.email || '').trim() || '—',
            is_team_lead: !!row.isTeamLead,
        }));
        return {
            team_member_count: team_members.length,
            team_members,
        };
    }

    /** Labels include keywords the student dashboard UI derives from when overview is absent. */
    private participationToDashboardStatus(status: string | null | undefined): string {
        switch (status) {
            case 'pending':
            case 'pending_payment_approval':
            case 'pending_ciel_approval':
            case 'pending_faculty_approval':
                return 'Pending approval';
            case 'paid':
                return 'Payment received — active';
            case 'approved':
            case 'accepted':
                return 'Active — in progress';
            case 'verified':
                return 'Verified — in progress';
            case 'finalized':
                return 'Completed';
            case 'rejected':
                return 'Rejected';
            default:
                return 'In progress';
        }
    }

    /**
     * Public `report_status` for dashboard lists (distinct from legacy DB-only labels).
     * `pending_payment` = student must pay / submit proof (`partner_verified`, legacy `payment_pending`).
     */
    private dashboardPublicReportStatus(raw: string | null | undefined): string | null {
        if (!raw) return null;
        if (raw === 'continue') return 'draft';
        if (raw === 'partner_verified' || raw === 'payment_pending') return 'pending_payment';
        if (raw === 'payment_under_review') return 'payment_under_review';
        return raw;
    }

    private reportProjectKey(report: StudentReport): string | null {
        const k = report.opportunityId || report.project_id;
        return k ? String(k) : null;
    }

    private normalizeBarHeights(values: number[]): number[] {
        if (!values.length) return [];
        const max = Math.max(...values.map((v) => this.safeDashboardNumber(v)), 1);
        return values.map((h) =>
            Math.min(100, Math.round((this.safeDashboardNumber(h) / max) * 100)),
        );
    }

    private buildHoursActivityBars(timesheets: Timesheet[], weeks = 8): number[] {
        const buckets = new Array(weeks).fill(0);
        const now = Date.now();
        const msWeek = 7 * 24 * 60 * 60 * 1000;
        for (const t of timesheets) {
            const created = t.createdAt ? new Date(t.createdAt).getTime() : now;
            const weekIdx = Math.floor((now - created) / msWeek);
            if (weekIdx >= 0 && weekIdx < weeks) {
                buckets[weeks - 1 - weekIdx] += this.safeDashboardNumber(t.hours);
            }
        }
        return this.normalizeBarHeights(buckets);
    }

    private buildCompletedActivityBars(reports: StudentReport[], months = 6): number[] {
        const buckets = new Array(months).fill(0);
        const now = new Date();
        for (const r of reports) {
            if (!['paid', 'verified'].includes(r.status)) continue;
            const d = r.submission_date ? new Date(r.submission_date) : new Date(r.updatedAt);
            const monthDiff =
                (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
            if (monthDiff >= 0 && monthDiff < months) {
                buckets[months - 1 - monthDiff] += 1;
            }
        }
        return this.normalizeBarHeights(buckets);
    }

    private getWorkflowResponseFields(opportunity: Opportunity) {
        return {
            workflow_stage: opportunity.workflowStage ?? null,
            faculty_approval_status: opportunity.facultyApprovalStatus ?? null,
            partner_approval_status: opportunity.partnerApprovalStatus ?? null,
            admin_approval_status: opportunity.adminApprovalStatus ?? null,
        };
    }

    private getApiOpportunityStatus(opportunity: Opportunity): string | null {
        if (opportunity.workflowStage === 'live' && opportunity.admin_approved) return 'live';
        if (
            opportunity.workflowStage === 'pending_faculty' ||
            opportunity.workflowStage === 'pending_partner' ||
            opportunity.workflowStage === 'pending_admin' ||
            (opportunity.workflowStage === 'live' && !opportunity.admin_approved)
        ) {
            return 'pending_verification';
        }
        if (opportunity.workflowStage === 'rejected') return 'rejected';
        if (opportunity.workflowStage === 'revision') return 'revision';
        const normalized = this.normalizeOpportunityStatus(opportunity.status);
        if ((normalized === 'live' || normalized === 'active') && !opportunity.admin_approved) {
            return 'pending_approval';
        }
        return normalized;
    }

    /**
     * Same rules as before; returns a clear message when the student cannot apply (for API / UI).
     */
    private getOpportunityEligibility(
        user: User,
        opp: Opportunity,
    ): { eligible: true } | { eligible: false; message: string } {
        const userUniversity = this.normalize(user.university || user.institution || user.orgName);
        const userDept = this.normalize(user.department || user.major);

        const restrictedListMsg =
            'This opportunity is limited to certain universities. Update your profile university so it matches the allowed institution, or choose a different opportunity.';

        // Backward compatibility: restricted_universities
        if (opp.restricted_universities && opp.restricted_universities.length > 0) {
            const allowed = opp.restricted_universities.map(this.normalize);
            if (!allowed.includes(userUniversity)) {
                if (!userUniversity) {
                    return {
                        eligible: false,
                        message:
                            'Add your university to your profile first. This opportunity is only open to students from selected universities.',
                    };
                }
                return { eligible: false, message: restrictedListMsg };
            }
        }

        const scope = opp.participation_scope;
        if (!scope) return { eligible: true };

        const rule = scope.rule;
        const uniNames: string[] = scope.university_names || [];
        const creatorUni = scope.creator_university_name || '';
        const deptScope = scope.department_restriction?.scope || 'all';
        const departments: string[] = scope.department_restriction?.departments || [];

        const uniSet = uniNames.map(this.normalize);
        const creatorNorm = this.normalize(creatorUni);
        const deptSet = departments.map(this.normalize);

        const uniMatch = (names: string[]) => names.includes(userUniversity);
        const deptMatch = deptScope === 'all' || (!!userDept && deptSet.includes(userDept));

        const deptFail = (): { eligible: false; message: string } => {
            if (!userDept) {
                return {
                    eligible: false,
                    message:
                        'This opportunity is limited to selected departments. Add your department or major in your profile, then try again.',
                };
            }
            return {
                eligible: false,
                message:
                    'This opportunity is limited to selected departments, and your department or major is not on the allowed list for this activity.',
            };
        };

        const uniNotInList = (): { eligible: false; message: string } => {
            if (!userUniversity) {
                return {
                    eligible: false,
                    message:
                        'Add your university to your profile first. This opportunity is only open to students from specific institutions.',
                };
            }
            return {
                eligible: false,
                message:
                    'This opportunity is only open to students from specific institutions, and your profile university does not match the allowed list.',
            };
        };

        const ownUniFail = (): { eligible: false; message: string } => {
            const label = creatorUni.trim() || 'the host university';
            if (!userUniversity) {
                return {
                    eligible: false,
                    message: `Add your university to your profile. This opportunity is only for students at ${label}.`,
                };
            }
            return {
                eligible: false,
                message: `This opportunity is only for students at ${label}. Update your profile university if yours is the same institution (spelling must match), or choose another opportunity.`,
            };
        };

        switch (rule) {
            case 'open_all_universities':
                return deptMatch ? { eligible: true } : deptFail();
            case 'restricted_specific_universities':
                if (!uniMatch(uniSet)) return uniNotInList();
                return deptMatch ? { eligible: true } : deptFail();
            case 'own_university_only':
                if (!userUniversity || userUniversity !== creatorNorm) return ownUniFail();
                return deptMatch ? { eligible: true } : deptFail();
            case 'departments_across_universities':
                if (!uniMatch(uniSet)) return uniNotInList();
                return deptMatch ? { eligible: true } : deptFail();
            case 'own_university_departments':
                if (!userUniversity || userUniversity !== creatorNorm) return ownUniFail();
                return deptMatch ? { eligible: true } : deptFail();
            default:
                return { eligible: true };
        }
    }
    // Verification
    async sendTeamMemberOtp(email: string) {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Save OTP in DB with 10 mins expiry
        const expiresAt = new Date(Date.now() + 600000);

        // We can either update existing or create new. Given many requests might happen, 
        // let's just create or update if already exists for this email.
        let otpRecord = await this.otpRepository.findOne({ where: { email } });
        if (otpRecord) {
            otpRecord.otp = otp;
            otpRecord.expiresAt = expiresAt;
        } else {
            otpRecord = this.otpRepository.create({ email, otp, expiresAt });
        }

        await this.otpRepository.save(otpRecord);
        await this.mailService.sendTeamMemberOtp(email, otp);

        return { success: true, message: 'OTP sent successfully' };
    }

    async confirmTeamMemberOtp(email: string, otp: string) {
        const record = await this.otpRepository.findOne({
            where: { email, otp }
        });

        if (!record) {
            throw new BadRequestException('Invalid OTP');
        }

        if (record.expiresAt < new Date()) {
            throw new BadRequestException('OTP has expired');
        }

        // Success! We can delete the OTP record now to prevent reuse
        await this.otpRepository.remove(record);

        return { success: true, message: 'Email verified' };
    }

    async sendTeamMemberVerification(email: string) {
        // 1. You can check if the user is already registered (optional)
        // 2. Call MailService to send the email
        await this.mailService.sendTeamMemberInvite(email);
        return { success: true, message: 'Verification email sent' };
    }

    async getDashboard(userId: string) {
        /** Matches legacy dashboard stat: enrolled / in-flight, excluding raw application `pending`. */
        const activeCourseStatStatuses = [
            'approved',
            'verified',
            'paid',
            'pending_ciel_approval',
            'pending_faculty_approval',
            'accepted',
        ] as const;

        /** Broader list so the student still sees pipeline + payment-pending rows in activeProjects. */
        const participationDashboardStatuses = [
            ...activeCourseStatStatuses,
            'pending',
            'pending_payment_approval',
        ] as const;

        const pendingParticipationStatuses = [
            'pending',
            'pending_payment_approval',
            'pending_ciel_approval',
            'pending_faculty_approval',
        ] as const;

        const workingParticipationStatuses = ['approved', 'verified', 'paid', 'accepted'] as const;

        const reportUnderReviewStatuses = [
            'submitted',
            'partner_verified',
            'payment_under_review',
            'payment_pending',
        ] as const;

        const verifiedTimesheets = await this.timesheetsRepository.find({
            where: { studentId: userId, status: 'verified' },
            relations: ['opportunity'],
        });

        const hoursVolunteered = verifiedTimesheets.reduce(
            (sum, t) => sum + this.safeDashboardNumber(t.hours),
            0,
        );
        const completedOppIds = verifiedTimesheets
            .map((t) => t.opportunityId)
            .filter((id): id is string => !!id);
        const projectsCompleted = new Set(completedOppIds).size;
        const impactPoints = Math.round(hoursVolunteered * 10);

        const teamCountStatuses = [
            'pending',
            'pending_payment_approval',
            'paid',
            'pending_ciel_approval',
            'pending_faculty_approval',
            'approved',
            'finalized',
            'verified',
            'accepted',
        ] as const;

        const [
            activeCourses,
            activeProjectsCount,
            pendingApprovalsCount,
            activeApplications,
            studentUser,
        ] = await Promise.all([
            this.participantRepository.count({
                where: { studentId: userId, status: In([...activeCourseStatStatuses]) },
            }),
            this.participantRepository.count({
                where: { studentId: userId, status: In([...workingParticipationStatuses]) },
            }),
            this.participantRepository.count({
                where: { studentId: userId, status: In([...pendingParticipationStatuses]) },
            }),
            this.participantRepository.find({
                where: { studentId: userId, status: In([...participationDashboardStatuses]) },
                relations: ['project', 'project.organization'],
                order: { updatedAt: 'DESC' },
                take: 50,
            }),
            this.usersRepository.findOne({ where: { id: userId }, relations: ['organization'] }),
        ]);

        const studentReports = await this.studentReportsService.getMergedReportsForParticipant(userId);

        const reportsUnderReviewCount = studentReports.filter((r) =>
            (reportUnderReviewStatuses as readonly string[]).includes(r.status),
        ).length;

        const projectIdsForTeams = [...new Set(activeApplications.map((a) => a.projectId))];
        const teamSizeByKey = new Map<string, number>();
        if (projectIdsForTeams.length > 0) {
            const teamRows = await this.participantRepository.find({
                where: {
                    projectId: In(projectIdsForTeams),
                    status: In([...teamCountStatuses]),
                },
                select: ['id', 'projectId', 'teamId', 'applicationId', 'participationMode'],
            });
            for (const row of teamRows) {
                const key = `${row.projectId}|${this.participationTeamBucketKey(row)}`;
                teamSizeByKey.set(key, (teamSizeByKey.get(key) || 0) + 1);
            }
        }

        let student_analytics: {
            profile_completion_percent: number;
            completed_required_fields: number;
            total_required_fields: number;
            verified: boolean;
        };
        if (studentUser) {
            const c = this.computeStudentProfileCompletion(studentUser);
            student_analytics = {
                profile_completion_percent: c.profile_completion_percent,
                completed_required_fields: c.completed_required_fields,
                total_required_fields: c.total_required_fields,
                verified:
                    studentUser.profile_verified === true && studentUser.identity_verified === true,
            };
        } else {
            student_analytics = {
                profile_completion_percent: 0,
                completed_required_fields: 0,
                total_required_fields: 0,
                verified: false,
            };
        }

        const reportByProjectId = new Map<string, StudentReport>();
        for (const r of studentReports) {
            const key = this.reportProjectKey(r);
            if (key && !reportByProjectId.has(key)) {
                reportByProjectId.set(key, r);
            }
        }

        const activeProjects = activeApplications.map((app) => {
            const required = this.resolveRequiredHoursPerStudent(app.project);
            const hoursDone = verifiedTimesheets
                .filter((t) => t.opportunityId === app.projectId)
                .reduce((sum, t) => sum + this.safeDashboardNumber(t.hours), 0);

            let progress = 0;
            if (required > 0) {
                progress = Math.min(100, Math.round((hoursDone / required) * 100));
            }

            const sdgId = app.project?.sdg_info?.sdg_id;
            const category =
                sdgId !== undefined && sdgId !== null && String(sdgId).length > 0
                    ? String(sdgId)
                    : 'General';

            const rep = reportByProjectId.get(String(app.projectId));
            const reportStatus = rep ? this.dashboardPublicReportStatus(rep.status) : null;

            const teamSize =
                teamSizeByKey.get(`${app.projectId}|${this.participationTeamBucketKey(app)}`) ?? 1;

            return {
                id: String(app.projectId),
                title: app.project?.title || 'Project',
                category,
                assignedAt: app.createdAt.toISOString(),
                status: this.participationToDashboardStatus(app.status),
                progress,
                required_hours_per_student: required,
                participation_type: app.participationMode || 'individual',
                academic_integration_type: app.academicIntegrationType ?? null,
                team_size: teamSize,
                ...(reportStatus ? { report_status: reportStatus } : {}),
            };
        });

        const deadLinesRaw = activeApplications
            .filter((app) => app.project?.timeline?.end_date)
            .map((app) => ({
                id: String(app.projectId),
                title: `${app.project?.title || 'Project'} deadline`,
                date: new Date(app.project!.timeline!.end_date as string | Date),
                type: 'default',
            }))
            .sort((a, b) => a.date.getTime() - b.date.getTime())
            .slice(0, 12);

        const deadlines = deadLinesRaw.map((d) => {
            const now = new Date();
            const diffDays = Math.ceil((d.date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            let type = 'default';
            if (diffDays <= 3) type = 'urgent';
            else if (diffDays <= 7) type = 'warning';

            return {
                id: d.id,
                title: d.title,
                date: d.date.toISOString(),
                type,
            };
        });

        const pendingSampleRows = activeApplications
            .filter((app) =>
                (pendingParticipationStatuses as readonly string[]).includes(app.status),
            )
            .slice(0, 3);

        const pendingApprovalsSample = pendingSampleRows.map((app) => ({
            id: String(app.projectId),
            title: app.project?.title || 'Project',
            hint: this.participationToDashboardStatus(app.status),
        }));

        const reportsUnderReviewList = studentReports.filter((r) =>
            (reportUnderReviewStatuses as readonly string[]).includes(r.status),
        );
        const reportsUnderReviewSample = reportsUnderReviewList.slice(0, 3).map((r) => ({
            id: String(r.opportunityId || r.project_id || r.id),
            title: r.opportunity?.title || 'Report',
            hint: 'Under review',
        }));

        const latestPaidOrVerified = studentReports.find((r) =>
            ['paid', 'verified'].includes(r.status),
        );
        const completedSample =
            latestPaidOrVerified && (latestPaidOrVerified.opportunityId || latestPaidOrVerified.project_id)
                ? {
                      id: String(
                          latestPaidOrVerified.opportunityId || latestPaidOrVerified.project_id,
                      ),
                      title: latestPaidOrVerified.opportunity?.title || 'Project',
                  }
                : undefined;

        const draftReport = studentReports.find(
            (r) => r.status === 'draft' || r.status === 'continue',
        );
        const continueProjectId = draftReport?.opportunityId || draftReport?.project_id;

        const paymentDueReport = studentReports.find((r) =>
            ['partner_verified', 'payment_pending'].includes(r.status),
        );
        const paymentDueProjectId = paymentDueReport ? this.reportProjectKey(paymentDueReport) : null;

        const resultsReport = studentReports.find((r) => ['verified', 'paid'].includes(r.status));
        const resultsProjectId = resultsReport ? this.reportProjectKey(resultsReport) : null;

        const quickActions = {
            continueReport:
                draftReport && continueProjectId
                    ? {
                          projectId: String(continueProjectId),
                          title: draftReport.opportunity?.title || 'Continue report',
                          subtitle: 'Pick up where you left off',
                      }
                    : null,
            viewPayment:
                paymentDueReport && paymentDueProjectId
                    ? {
                          projectId: paymentDueProjectId,
                          title: paymentDueReport.opportunity?.title || 'Project',
                          subtitle: 'Fee or payment proof required',
                      }
                    : null,
            viewReportResults:
                resultsReport && resultsProjectId
                    ? {
                          projectId: resultsProjectId,
                          title: resultsReport.opportunity?.title || 'Project',
                      }
                    : null,
        };

        const urgentDeadlineNotifs = deadlines
            .filter((d) => d.type === 'urgent')
            .map((d) => ({
                id: `deadline-${d.id}`,
                title: 'Deadline approaching',
                detail: d.title,
                tone: 'urgent' as const,
                category: 'deadline' as const,
            }));

        const pendingNotifs = pendingSampleRows.map((app) => ({
            id: `pending-${app.projectId}`,
            title: app.project?.title || 'Project',
            detail: 'Awaiting approval to start or proceed.',
            tone: 'warning' as const,
            category: 'approval' as const,
        }));

        const underReviewNotifs = reportsUnderReviewList.slice(0, 5).map((r) => {
            const paymentish =
                r.status === 'payment_under_review' ||
                r.status === 'payment_pending' ||
                r.status === 'partner_verified';
            let detail = 'Submitted — review in progress.';
            if (r.status === 'payment_under_review') {
                detail = 'Payment proof is under review.';
            } else if (r.status === 'payment_pending' || r.status === 'partner_verified') {
                detail = 'Payment or fee slip is required.';
            }
            return {
                id: `report-${r.id}`,
                title: r.opportunity?.title || 'Report',
                detail,
                tone: 'neutral' as const,
                category: paymentish ? ('payment' as const) : ('report' as const),
            };
        });

        const notificationsPreview = {
            active: urgentDeadlineNotifs,
            pending: pendingNotifs,
            underReview: underReviewNotifs,
        };

        const pendingPaymentByProject = new Map<string, StudentReport>();
        for (const r of studentReports) {
            if (!['partner_verified', 'payment_pending'].includes(r.status)) continue;
            const key = this.reportProjectKey(r);
            if (key && !pendingPaymentByProject.has(key)) {
                pendingPaymentByProject.set(key, r);
            }
        }
        const paymentUnderReviewByProject = new Map<string, StudentReport>();
        for (const r of studentReports) {
            if (r.status !== 'payment_under_review') continue;
            const key = this.reportProjectKey(r);
            if (key && !paymentUnderReviewByProject.has(key)) {
                paymentUnderReviewByProject.set(key, r);
            }
        }

        const pendingPaymentsSample = Array.from(pendingPaymentByProject.values())
            .slice(0, 2)
            .map((r) => ({
                id: String(r.opportunityId || r.project_id || r.id),
                title: r.opportunity?.title || 'Project',
                hint: 'Payment required',
            }));

        const overview = {
            activeProjectsCount: activeProjectsCount,
            pendingApprovalsCount: pendingApprovalsCount,
            reportsUnderReviewCount: reportsUnderReviewCount,
            totalVerifiedHours: this.safeDashboardNumber(hoursVolunteered),
            completedCount: projectsCompleted,
            pendingApprovalsSample,
            reportsUnderReviewSample,
            hoursActivityBars: this.buildHoursActivityBars(verifiedTimesheets),
            completedActivityBars: this.buildCompletedActivityBars(studentReports),
            ...(completedSample ? { completedSample } : {}),
            impactHistoryBadgeCount: studentReports.filter((r) => r.status !== 'draft').length,
            pendingPaymentsCount: pendingPaymentByProject.size,
            paymentsUnderReviewCount: paymentUnderReviewByProject.size,
            ...(pendingPaymentsSample.length ? { pendingPaymentsSample } : {}),
        };

        const pendingSummary = {
            total:
                pendingApprovalsCount +
                reportsUnderReviewCount +
                pendingPaymentByProject.size +
                urgentDeadlineNotifs.length,
            items: [
                {
                    key: 'student_pending_approvals',
                    title: 'Pending approvals',
                    count: pendingApprovalsCount,
                    href: '/dashboard/student/projects',
                    tone: 'warning',
                    description: 'Applications or projects waiting for approval.',
                },
                {
                    key: 'student_reports_under_review',
                    title: 'Reports under review',
                    count: reportsUnderReviewCount,
                    href: '/dashboard/student/projects',
                    tone: 'neutral',
                    description: 'Submitted reports currently being checked.',
                },
                {
                    key: 'student_pending_payments',
                    title: 'Payment required',
                    count: pendingPaymentByProject.size,
                    href: '/dashboard/student/payments',
                    tone: 'urgent',
                    description: 'Projects where fee or payment proof is still needed.',
                },
                {
                    key: 'student_deadlines',
                    title: 'Urgent deadlines',
                    count: urgentDeadlineNotifs.length,
                    href: '/dashboard/student/projects',
                    tone: 'urgent',
                    description: 'Upcoming deadlines that need attention.',
                },
            ],
        };

        return {
            success: true,
            data: {
                stats: {
                    activeCourses: this.safeDashboardNumber(activeCourses),
                    impactPoints: this.safeDashboardNumber(impactPoints),
                    projectsCompleted: this.safeDashboardNumber(projectsCompleted),
                    hoursVolunteered: this.safeDashboardNumber(hoursVolunteered),
                },
                activeProjects,
                deadlines,
                overview,
                quickActions,
                notificationsPreview,
                pendingSummary,
                student_analytics,
            },
        };
    }

    async getOpportunities(query: any, userId?: string) {
        const { sdg, location, type, status, page = 1, limit = 10 } = query;
        const pageNumber = Math.max(1, Number(page) || 1);
        const limitNumber = Math.max(1, Number(limit) || 10);
        const skip = (pageNumber - 1) * limitNumber;
        const requestedStatus = this.normalize(status);

        let dbStatuses: string[];
        let requireAdminApproval = false;
        /** Matches `OpportunitiesService.getPublicOpportunities`: CIEL-approved live workflow rows can still use legacy status (e.g. `pending_execution`). */
        let useDefaultLiveBrowseOr = false;

        if (!requestedStatus || ['approved', 'active', 'live'].includes(requestedStatus)) {
            dbStatuses = this.liveOpportunityStatuses;
            requireAdminApproval = true;
            useDefaultLiveBrowseOr = true;
        } else if (['open', 'recruiting'].includes(requestedStatus)) {
            dbStatuses = [requestedStatus];
            requireAdminApproval = true;
        } else if (requestedStatus === 'completed') {
            dbStatuses = ['completed'];
        } else if (requestedStatus === 'closed') {
            dbStatuses = ['closed'];
        } else {
            dbStatuses = [requestedStatus];
            requireAdminApproval = this.liveOpportunityStatuses.includes(requestedStatus);
        }

        let opportunities: Opportunity[];
        if (useDefaultLiveBrowseOr && requireAdminApproval) {
            opportunities = await this.opportunitiesRepository.find({
                where: [
                    { status: In(dbStatuses), admin_approved: true },
                    { workflowStage: WORKFLOW_STAGE.LIVE, admin_approved: true },
                ],
                relations: ['organization'],
                order: { createdAt: 'DESC' },
            });
        } else {
            const whereClause: { status: ReturnType<typeof In>; admin_approved?: boolean } = {
                status: In(dbStatuses),
            };
            if (requireAdminApproval) {
                whereClause.admin_approved = true;
            }
            opportunities = await this.opportunitiesRepository.find({
                where: whereClause,
                relations: ['organization'],
                order: { createdAt: 'DESC' },
            });
        }

        const participationByOpp = new Map<string, Participation>();
        const studentContextId = query?.student_id || query?.studentId || userId;

        let appByOpp = new Map<string, OpportunityApplication>();
        if (studentContextId && opportunities.length > 0) {
            const opportunityIds = opportunities.map(o => o.id);
            const applications = await this.participantRepository.find({
                where: {
                    studentId: studentContextId,
                    projectId: In(opportunityIds)
                }
            });

            applications.forEach(app => {
                participationByOpp.set(app.projectId, app);
            });

            appByOpp = await this.opportunityApplicationsService.mapCurrentApplicationsForOpportunities(
                studentContextId,
                opportunityIds,
            );
        }

        const normalizedLocation = this.normalize(location);
        const normalizedType = this.normalize(type);
        const normalizedSdg = this.normalize(sdg);

        // Participation scope is enforced in applyToOpportunity, not on the browse list.
        const filtered = opportunities.filter((opportunity) => {
            const matchesSdg =
                !normalizedSdg ||
                this.normalize(opportunity.sdg) === normalizedSdg ||
                this.normalize(opportunity.sdg_info?.sdg_id) === normalizedSdg;
            const matchesLocation =
                !normalizedLocation || this.normalize(opportunity.location?.city) === normalizedLocation;
            const matchesType =
                !normalizedType ||
                (Array.isArray(opportunity.types) &&
                    opportunity.types.some((entry) => this.normalize(entry) === normalizedType));

            return matchesSdg && matchesLocation && matchesType;
        });

        const total = filtered.length;
        const paginated = filtered.slice(skip, skip + limitNumber);

        return {
            success: true,
            data: await Promise.all(paginated.map(async o => {
                const part = participationByOpp.get(o.id);
                const app = appByOpp.get(o.id);
                const occupiedSeats = await this.getOccupiedSeats(o.id);
                const volunteersRequired = o.timeline?.volunteers_required || 0;
                const applicationStatus = app
                    ? this.opportunityApplicationsService.toPublicApplicationStatus(app.internalStatus, part)
                    : this.normalizeApplicationStatus(part?.status || null);
                const hasApplied = !!(app || part);
                const organizationName = o.organization?.name || 'Unknown';

                return {
                    ...o,
                    organization: organizationName,
                    organization_name: organizationName,
                    volunteersNeeded: volunteersRequired,
                    remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
                    description: o.objectives?.description || 'No description',
                    application_status: applicationStatus,
                    application_stage: app ? this.opportunityApplicationsService.applicationStage(app.internalStatus) : null,
                    has_applied: hasApplied,
                    hasApplied,
                    payment_status: part ? part.paymentStatus : null,
                    payment_proof_url: part ? part.paymentProofUrl : null,
                    status: this.getApiOpportunityStatus(o),
                    ...this.getWorkflowResponseFields(o),
                    teamMembers: [] // We no longer fetch team members in a list view for performance, or we can fetch them if needed.
                };
            })),
            pagination: {
                total,
                page: pageNumber,
                limit: limitNumber,
            },
        };
    }

    async getOpportunityById(id: string, userId?: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: [
                { id, status: In(this.liveOpportunityStatuses), admin_approved: true },
                { id, workflowStage: WORKFLOW_STAGE.LIVE, admin_approved: true },
            ],
            relations: ['organization'],
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        let applicationStatus: string | null = null;
        let paymentStatus: string | null = null;
        let paymentProofUrl: string | null = null;
        let hasApplied = false;
        let applicationStage: 'faculty' | 'partner' | 'admin' | null = null;

        if (userId) {
            const part = await this.participantRepository.findOne({
                where: {
                    studentId: userId,
                    projectId: id,
                },
            });
            const app = await this.opportunityApplicationsService.findLatestForStudentOpportunity(userId, id);

            if (app) {
                applicationStage = this.opportunityApplicationsService.applicationStage(app.internalStatus);
                applicationStatus = this.opportunityApplicationsService.toPublicApplicationStatus(
                    app.internalStatus,
                    part,
                );
            } else if (part) {
                applicationStatus = this.normalizeApplicationStatus(part.status);
            }

            if (app || part) {
                hasApplied = true;
                paymentStatus = part?.paymentStatus ?? null;
                paymentProofUrl = part?.paymentProofUrl ?? null;
            }
        }

        const occupiedSeats = await this.getOccupiedSeats(id);
        const volunteersRequired = opportunity.timeline?.volunteers_required || 0;

        return {
            success: true,
            data: {
                ...opportunity,
                application_status: applicationStatus,
                application_stage: applicationStage,
                payment_status: paymentStatus,
                payment_proof_url: paymentProofUrl,
                has_applied: hasApplied,
                hasApplied: hasApplied,
                remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
                volunteersNeeded: volunteersRequired,
                status: this.getApiOpportunityStatus(opportunity),
                ...this.getWorkflowResponseFields(opportunity),
            },
        };
    }

    async getRecommendedOpportunities(userId: string) {
        // Simple implementation - can be enhanced with ML
        const opportunities = await this.opportunitiesRepository.find({
            where: [
                { status: In(this.liveOpportunityStatuses), admin_approved: true },
                { workflowStage: WORKFLOW_STAGE.LIVE, admin_approved: true },
            ],
            relations: ['organization'],
            take: 5,
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: opportunities,
        };
    }

    async getStudentProjects(studentId: string) {
        const applications = await this.participantRepository.find({
            where: { studentId },
            relations: ['project', 'project.organization'],
            order: { createdAt: 'DESC' },
        });

        const pipelineApps = await this.opportunityApplicationsService.findNonWithdrawnApplicationsForStudent(
            studentId,
        );
        const latestAppByOpp = new Map<string, (typeof pipelineApps)[0]>();
        for (const row of pipelineApps) {
            if (!latestAppByOpp.has(row.opportunityId)) {
                latestAppByOpp.set(row.opportunityId, row);
            }
        }

        const appliedIds = new Set(applications.map((a) => a.projectId));

        const createdOpportunities = await this.opportunitiesRepository.find({
            where: { creatorId: studentId },
            relations: ['organization'],
            order: { createdAt: 'DESC' },
        });

        const ownNotApplied = createdOpportunities.filter((o) => !appliedIds.has(o.id));

        const fromCreator = ownNotApplied.map((opp) =>
            this.opportunityWorkflow.toStudentProjectCard(opp, { teamMembers: [] }),
        );

        const fromParticipants = await Promise.all(
            applications.map(async (app) => {
                const roster = await this.participationRowsForStudentProjectTeam(app);
                const teamMembers = roster.map((m) => ({
                    name: m.fullName,
                    role: m.isTeamLead ? 'Leader' : 'Member',
                    cnic: m.cnicLast4 ? `••••${m.cnicLast4}` : '',
                    email: m.email,
                    mobile: m.mobile,
                    university: m.universityName,
                    is_verified: Boolean(m.emailVerified),
                }));

                const base = this.opportunityWorkflow.toStudentProjectCard(app.project, { teamMembers });
                const participationStatus =
                    app.status === 'approved' || app.status === 'verified' ? 'active' : app.status;

                const oa = latestAppByOpp.get(app.projectId);
                const applicationStatus = oa
                    ? this.opportunityApplicationsService.toPublicApplicationStatus(oa.internalStatus, app)
                    : this.normalizeApplicationStatus(app.status);

                return {
                    ...base,
                    status: participationStatus,
                    organization: app.project.organization?.name || 'Unknown',
                    payment_status: app.paymentStatus,
                    payment_proof_url: app.paymentProofUrl,
                    application_status: applicationStatus,
                    application_stage: oa
                        ? this.opportunityApplicationsService.applicationStage(oa.internalStatus)
                        : null,
                    has_applied: true,
                    hasApplied: true,
                };
            }),
        );

        const participantOppIds = new Set(applications.map((p) => p.projectId));

        const fromPipelineOnly: Record<string, unknown>[] = [];
        for (const oa of latestAppByOpp.values()) {
            if (participantOppIds.has(oa.opportunityId)) continue;
            if (!oa.opportunity) continue;
            const st = this.opportunityApplicationsService.toPublicApplicationStatus(oa.internalStatus, null);
            const base = this.opportunityWorkflow.toStudentProjectCard(oa.opportunity, { teamMembers: [] });
            fromPipelineOnly.push({
                ...base,
                status: st,
                organization: oa.opportunity.organization?.name || 'Unknown',
                application_status: st,
                application_stage: this.opportunityApplicationsService.applicationStage(oa.internalStatus),
                has_applied: true,
                hasApplied: true,
            });
        }

        return {
            success: true,
            data: [...fromCreator, ...fromParticipants, ...fromPipelineOnly],
        };
    }

    async getProjectById(opportunityId: string, studentUserId?: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId },
            relations: ['organization'],
        });

        if (!opportunity) {
            throw new NotFoundException(`Project with ID ${opportunityId} not found`);
        }

        let statusForReport = (opportunity.status || '').toLowerCase();

        if (studentUserId) {
            const oa = await this.opportunityApplicationsService.findLatestForStudentOpportunity(
                studentUserId,
                opportunityId,
            );
            const part = await this.participantRepository.findOne({
                where: { studentId: studentUserId, projectId: opportunityId },
            });
            const joinApproved =
                oa?.internalStatus === 'approved' ||
                (!!part && ['approved', 'verified'].includes(part.status));

            if (joinApproved) {
                if (part?.status === 'verified') {
                    statusForReport = 'verified';
                } else {
                    statusForReport = 'approved';
                }
            }
        }

        return {
            success: true,
            data: {
                id: opportunity.id,
                title: opportunity.title,
                organization: opportunity.organization?.name || 'Unknown',
                organizationId: opportunity.organizationId,
                logoUrl: opportunity.organization?.logoUrl || null,
                status: statusForReport,
                mode: opportunity.mode,
                types: opportunity.types,
                location: opportunity.location,
                timeline: opportunity.timeline,
                sdg_info: opportunity.sdg_info,
                objectives: opportunity.objectives,
                activity_details: opportunity.activity_details,
                supervision: opportunity.supervision,
                verification_method: opportunity.verification_method,
                createdAt: opportunity.createdAt,
                updatedAt: opportunity.updatedAt,
            }
        };
    }

    async findSimilarStudentOpportunitiesForCreate(
        userId: string,
        title: string,
        options?: { excludeOpportunityId?: string; university?: string },
    ) {
        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');

        const university =
            options?.university?.trim() ||
            user.university?.trim() ||
            user.institution?.trim() ||
            '';

        const similar = await this.opportunitiesService.findSimilarStudentCreatedOpportunities(
            title,
            university,
            { excludeOpportunityId: options?.excludeOpportunityId, limit: 8 },
        );

        return {
            success: true,
            data: similar,
        };
    }

    async createStudentOpportunity(userId: string, dto: CreateOpportunityDto) {
        // Single CIEL workflow (faculty token + stages); avoids duplicate liaison-only rows that never sync with the dashboard.
        const result = await this.opportunitiesService.createStudentOpportunity(userId, dto);
        return {
            ...result,
            message: 'Opportunity submitted successfully',
        };
    }

    async updateStudentOpportunity(userId: string, opportunityId: string, dto: Partial<CreateOpportunityDto>) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId },
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        if (opportunity.creatorId !== userId) {
            throw new ForbiddenException('You do not have access to this opportunity');
        }

        if (opportunity.admin_approved || this.isLiveOpportunityStatus(opportunity.status)) {
            throw new BadRequestException('Approved opportunities cannot be updated');
        }

        const patchableFields: (keyof CreateOpportunityDto)[] = [
            'title',
            'types',
            'mode',
            'student_contact',
            'location',
            'timeline',
            'sdg_info',
            'secondary_sdgs',
            'objectives',
            'activity_details',
            'supervision',
            'verification_method',
            'visibility',
            'restricted_universities',
            'executing_context',
            'safety_declaration',
            'submission_confirmations',
            'participation_scope',
            'executing_organization',
            'partner_organization',
            'safety_supervision_declaration',
            'visibility_and_academic_linkage',
            'external_partner_collaboration',
            'academic_linkage',
        ];

        const patch: Partial<Opportunity> = {};
        for (const field of patchableFields) {
            const value = dto[field];
            if (value !== undefined) {
                patch[field as keyof Opportunity] = value as Opportunity[keyof Opportunity];
            }
        }

        const nextRestricted =
            dto.restricted_universities && dto.restricted_universities.length > 0
                ? dto.restricted_universities
                : dto.participation_scope?.creator_university_name
                    ? [dto.participation_scope.creator_university_name]
                    : undefined;

        if (nextRestricted !== undefined) {
            patch.restricted_universities = nextRestricted;
        }

        Object.assign(opportunity, patch);

        if (dto.sdg_info) {
            opportunity.sdg = dto.sdg_info.sdg_id || opportunity.sdg;
        }

        // Edit & resubmit: restore actionable queue after faculty/partner rejection.
        let notifyPartnerAfterStudentResubmit = false;
        if (opportunity.isStudentCreated && opportunity.workflowStage === WORKFLOW_STAGE.REJECTED) {
            const requiresPartnerNow = this.opportunitiesService.studentCreatedPayloadRequiresPartner(
                opportunity as unknown as CreateOpportunityDto,
            );
            opportunity.requiresPartnerApproval = requiresPartnerNow;

            const wasPartnerRejected = opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED;
            const wasFacultyRejected =
                opportunity.facultyApprovalStatus === LINE_STATUS.REJECTED ||
                opportunity.faculty_verification_status === 'rejected';
            const needsFacultyReview =
                wasFacultyRejected ||
                (!opportunity.faculty_verified &&
                    (opportunity.facultyApprovalStatus === LINE_STATUS.PENDING ||
                        opportunity.faculty_verification_status === WORKFLOW_STAGE.PENDING_FACULTY));

            if (needsFacultyReview) {
                opportunity.workflowStage = WORKFLOW_STAGE.PENDING_FACULTY;
                opportunity.status = WORKFLOW_STAGE.PENDING_FACULTY;
                opportunity.facultyApprovalStatus = LINE_STATUS.PENDING;
                opportunity.faculty_verification_status = WORKFLOW_STAGE.PENDING_FACULTY;
                opportunity.faculty_verified = false;
                opportunity.partnerApprovalStatus = requiresPartnerNow ? LINE_STATUS.PENDING : LINE_STATUS.NOT_APPLICABLE;
            } else if (wasPartnerRejected) {
                opportunity.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
                opportunity.status = WORKFLOW_STAGE.PENDING_PARTNER;
                opportunity.partnerApprovalStatus = LINE_STATUS.PENDING;
                opportunity.partnerVerified = false;
            } else if (opportunity.adminApprovalStatus === LINE_STATUS.REJECTED) {
                opportunity.admin_approved = false;
                const needsPartnerBeforeAdmin =
                    requiresPartnerNow &&
                    (!opportunity.partnerVerified || opportunity.partnerApprovalStatus !== LINE_STATUS.APPROVED);

                if (needsPartnerBeforeAdmin) {
                    opportunity.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
                    opportunity.status = WORKFLOW_STAGE.PENDING_PARTNER;
                    opportunity.partnerApprovalStatus = LINE_STATUS.PENDING;
                    opportunity.partnerVerified = false;
                    opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
                    if (!opportunity.partnerToken) {
                        opportunity.partnerToken = randomUUID();
                    }
                    notifyPartnerAfterStudentResubmit = true;
                } else {
                    opportunity.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
                    opportunity.status = 'pending_approval';
                    opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
                }
            }

            // Keep admin lane as pending while resubmission goes back through review queues.
            if (wasPartnerRejected || needsFacultyReview) {
                opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
                opportunity.admin_approved = false;
            }
        }

        const saved = await this.opportunitiesRepository.save(opportunity);

        if (notifyPartnerAfterStudentResubmit) {
            await this.opportunitiesService.notifyPartnerForStudentOpportunityPartnerQueue(saved);
        }

        return {
            success: true,
            data: saved,
            message: 'Opportunity updated successfully',
        };
    }

    // Applications (using Timesheets as applications)
    async getApplications(userId: string, status?: string) {
        const whereClause: any = { studentId: userId };
        if (status) whereClause.status = status;

        const applications = await this.timesheetsRepository.find({
            where: whereClause,
            relations: ['opportunity', 'opportunity.organization'],
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: applications.map(a => ({
                id: a.id,
                opportunityId: a.opportunityId,
                opportunityTitle: a.opportunity?.title || 'Unknown',
                organization: a.opportunity?.organization?.name || 'Unknown',
                status: a.status,
                appliedDate: a.createdAt,
                hours: a.hours,
            })),
        };
    }

    async applyToOpportunity(userId: string, dto: ApplyOpportunityDto) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: dto.opportunityId },
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }
        if (!this.isLiveOpportunityStatus(opportunity.status) || !opportunity.admin_approved) {
            throw new BadRequestException('This opportunity is not open for applications yet');
        }

        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');
        const eligibility = this.getOpportunityEligibility(user, opportunity);
        if (!eligibility.eligible) {
            throw new ForbiddenException(eligibility.message);
        }

        if (await this.opportunityApplicationsService.hasOpenPipelineApplication(userId, dto.opportunityId)) {
            throw new BadRequestException('Already applied to this opportunity');
        }

        const latestPipelineApp = await this.opportunityApplicationsService.findLatestForStudentOpportunity(
            userId,
            dto.opportunityId,
        );
        const pipelineWasRejected =
            !!latestPipelineApp && this.opportunityApplicationsService.isTerminalRejection(latestPipelineApp.internalStatus);

        const existingParticipation = await this.participantRepository.findOne({
            where: {
                studentId: userId,
                projectId: dto.opportunityId,
            },
        });

        if (existingParticipation) {
            if (this.isParticipationActivelyEnrolled(existingParticipation.status)) {
                throw new BadRequestException('Already applied to this opportunity');
            }
            if (existingParticipation.status === 'rejected') {
                // OK: re-apply after participation rejection
            } else if (this.isParticipationPendingPipeline(existingParticipation.status)) {
                if (!pipelineWasRejected) {
                    throw new BadRequestException('Already applied to this opportunity');
                }
                // Stale pending participation while latest opportunity_application is terminal-rejected — allow new row
            } else {
                throw new BadRequestException('Already applied to this opportunity');
            }
        }

        const claimedEmailsOnOpenApplications =
            await this.opportunityApplicationsService.collectClaimedEmailsOnOpenApplications(dto.opportunityId);
        const leadEmailNorm = (user.email ?? '').trim().toLowerCase();
        if (leadEmailNorm && claimedEmailsOnOpenApplications.has(leadEmailNorm)) {
            throw new BadRequestException(
                'You are already listed on another application for this opportunity (as lead or team member). Withdraw that application first if you want to change teams.',
            );
        }

        /** Must match payload reality: omitting participation_type must not bypass team checks if members are sent. */
        const isTeamApply = isTeamApplyFromParticipationAndMembers(dto.participation_type, dto.team_members);

        const attendanceApproverType = this.opportunityHasPartner(opportunity) ? 'partner' : 'faculty';
        if (attendanceApproverType === 'faculty' && !dto.primary_faculty_email) {
            throw new BadRequestException('Primary faculty email is required when attendance approval is routed to faculty');
        }

        let teamMembersPayload = dto.team_members;
        if (isTeamApply && Array.isArray(dto.team_members) && dto.team_members.length > 0) {
            const leadNorm = (user.email ?? '').trim().toLowerCase();
            const seenEmails = new Set<string>();
            const sanitized: NonNullable<ApplyOpportunityDto['team_members']> = [];
            for (const member of dto.team_members) {
                const em =
                    typeof member?.email === 'string' ? member.email.trim().toLowerCase() : '';
                if (!em) continue;
                if (em === leadNorm) {
                    continue;
                }
                if (seenEmails.has(em)) {
                    throw new BadRequestException(
                        'Each team member email must appear only once.',
                    );
                }
                seenEmails.add(em);
                sanitized.push(member);
            }
            teamMembersPayload = sanitized;
        }

        let resolvedTeamId = (dto.team_id || '').trim();
        if (isTeamApply && !resolvedTeamId) {
            do {
                resolvedTeamId = randomUUID();
            } while (
                await this.opportunityApplicationsService.isTeamSlugInUseOnOpportunity(
                    dto.opportunityId,
                    resolvedTeamId,
                )
            );
        }

        if (
            isTeamApply &&
            Array.isArray(teamMembersPayload) &&
            teamMembersPayload.length > 0
        ) {
            for (const member of teamMembersPayload) {
                const em =
                    typeof member?.email === 'string' ? member.email.trim().toLowerCase() : '';
                if (em && claimedEmailsOnOpenApplications.has(em)) {
                    throw new BadRequestException(
                        `${member.email} is already listed on another application for this opportunity.`,
                    );
                }
            }
            await this.assertTeamMembersNotAlreadySeatedOnOpportunity(dto.opportunityId, teamMembersPayload);
        }

        if (isTeamApply && resolvedTeamId) {
            const slugTaken = await this.opportunityApplicationsService.isTeamSlugInUseOnOpportunity(
                dto.opportunityId,
                resolvedTeamId,
            );
            if (slugTaken) {
                throw new BadRequestException(
                    'This team_id is already used on this opportunity. Use a different team identifier.',
                );
            }
        }

        const applyPayload: Record<string, unknown> = {
            participation_type: isTeamApply ? 'team' : dto.participation_type,
            primary_faculty_email: dto.primary_faculty_email,
            secondary_faculty_email: dto.secondary_faculty_email,
            team_id: isTeamApply ? resolvedTeamId : dto.team_id,
            team_members: teamMembersPayload,
            contact_phone_e164: dto.contact_phone_e164,
            attendance_approver_type: attendanceApproverType,
        };

        const saved = await this.opportunityApplicationsService.createApplication({
            studentUserId: userId,
            opportunityId: dto.opportunityId,
            primaryFacultyEmail: dto.primary_faculty_email,
            secondaryFacultyEmail: dto.secondary_faculty_email,
            attendanceApproverType,
            applyPayload,
        });

        if (dto.primary_faculty_email) {
            await this.mailService.sendFacultyApprovalRequest(
                dto.primary_faculty_email,
                user.name,
                opportunity.title,
                saved.id,
            );
        }

        if (dto.secondary_faculty_email) {
            await this.mailService.sendFacultyCollaboratorNotice(
                dto.secondary_faculty_email,
                user.name,
                opportunity.title,
            );
        }

        await this.mailService.sendApplicationSubmitted(user.email, user.name, opportunity.title);

        return {
            success: true,
            data: {
                application_id: saved.id,
                application_status: 'pending_approval',
            },
            message: 'Application submitted successfully',
        };
    }

    async withdrawApplication(userId: string, id: string) {
        const pipelineWithdraw = await this.opportunityApplicationsService.withdraw(userId, id);
        if (pipelineWithdraw) {
            return pipelineWithdraw;
        }

        const application = await this.participantRepository.findOne({
            where: { id, studentId: userId },
        });

        if (!application) {
            throw new NotFoundException('Application not found');
        }

        if (application.status !== 'pending') {
            throw new BadRequestException('Can only withdraw pending applications');
        }

        await this.participantRepository.remove(application);

        return {
            success: true,
            message: 'Application withdrawn successfully',
        };
    }

    // Timesheets
    async getTimesheets(userId: string, query: any) {
        const { status, opportunityId } = query;
        const whereClause: any = { studentId: userId };
        if (status) whereClause.status = status;
        if (opportunityId) whereClause.opportunityId = opportunityId;

        const timesheets = await this.timesheetsRepository.find({
            where: whereClause,
            relations: ['opportunity'],
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: timesheets,
        };
    }

    async getReports(userId: string, organisationId: string) {
        // Find all applications/participants for this user in opportunities from this organisation
        const activeApplications = await this.participantRepository.find({
            where: {
                studentId: userId,
                project: {
                    organizationId: organisationId
                }
            },
            relations: ['project', 'project.organization']
        });

        // Fetch verified timesheets for these opportunities
        const verifiedTimesheets = await this.timesheetsRepository.find({
            where: { studentId: userId, status: 'verified' },
            relations: ['opportunity']
        });

        // Format data
        const reports = activeApplications.map(app => {
            const requiredHours = app.project.timeline?.expected_hours || 0;
            const hoursDone = verifiedTimesheets
                .filter(t => t.opportunityId === app.projectId)
                .reduce((sum, t) => sum + t.hours, 0);

            // Determine report status based on hours
            let reportStatus = 'Pending';
            if (hoursDone >= requiredHours && requiredHours > 0) reportStatus = 'Completed';
            else if (hoursDone > 0) reportStatus = 'In Progress';

            return {
                id: app.id,
                opportunityId: app.project.id,
                projectName: app.project.title,
                startDate: app.createdAt,
                endDate: app.project.timeline?.end_date || null,
                totalHours: hoursDone,
                requiredHours: requiredHours,
                status: reportStatus,
                partnerName: app.project.organization?.name || 'Unknown Partner',
                partnerLogo: app.project.organization?.logoUrl || null,
                certificateUrl: null, // Logic for certificate can go here
            };
        });

        return {
            success: true,
            data: reports
        };
    }

    async logHours(userId: string, dto: LogHoursDto) {
        const timesheet = this.timesheetsRepository.create({
            studentId: userId,
            opportunityId: dto.opportunityId,
            hours: dto.hours,
            description: dto.description,
            status: 'pending',
        });

        await this.timesheetsRepository.save(timesheet);

        return {
            success: true,
            data: timesheet,
            message: 'Hours logged successfully',
        };
    }

    async updateTimesheet(userId: string, id: string, dto: Partial<LogHoursDto>) {
        const timesheet = await this.timesheetsRepository.findOne({
            where: { id },
        });

        if (!timesheet) {
            throw new NotFoundException('Timesheet not found');
        }

        if (timesheet.studentId !== userId) {
            throw new ForbiddenException('Not your timesheet');
        }

        if (timesheet.status === 'verified') {
            throw new BadRequestException('Cannot update verified timesheets');
        }

        Object.assign(timesheet, dto);
        await this.timesheetsRepository.save(timesheet);

        return {
            success: true,
            data: timesheet,
        };
    }

    async deleteTimesheet(userId: string, id: string) {
        const timesheet = await this.timesheetsRepository.findOne({
            where: { id },
        });

        if (!timesheet) {
            throw new NotFoundException('Timesheet not found');
        }

        if (timesheet.studentId !== userId) {
            throw new ForbiddenException('Not your timesheet');
        }

        if (timesheet.status === 'verified') {
            throw new BadRequestException('Cannot delete verified timesheets');
        }

        await this.timesheetsRepository.remove(timesheet);

        return {
            success: true,
            message: 'Timesheet deleted successfully',
        };
    }

    // Impact
    async getImpact(userId: string) {
        const timesheets = await this.timesheetsRepository.find({
            where: { studentId: userId, status: 'verified' },
            relations: ['opportunity'],
        });

        const totalHours = timesheets.reduce((sum, t) => sum + t.hours, 0);

        const sdgContributions = timesheets.reduce((acc, t) => {
            const sdg = t.opportunity?.sdg || 'Unknown';
            acc[sdg] = (acc[sdg] || 0) + t.hours;
            return acc;
        }, {});

        // Monthly trend
        const monthlyTrend: Array<{ month: string; hours: number }> = timesheets.reduce((acc, t) => {
            const month = new Date(t.createdAt).toLocaleString('default', { month: 'short' });
            const existing = acc.find(m => m.month === month);
            if (existing) {
                existing.hours += t.hours;
            } else {
                acc.push({ month, hours: t.hours });
            }
            return acc;
        }, [] as Array<{ month: string; hours: number }>);

        return {
            success: true,
            data: {
                totalHours,
                totalBeneficiaries: totalHours * 5, // Estimate
                sdgContributions,
                monthlyTrend,
                certificates: [],
            },
        };
    }

    private resolveImpactStudentId(
        requestingUserId: string,
        role: string | undefined,
        body?: { student_id?: string; studentId?: string },
    ): string {
        const requested = (body?.student_id || body?.studentId || '').trim();
        if (requested && (role === UserRole.SUPER_ADMIN || requested === requestingUserId)) {
            return requested;
        }
        return requestingUserId;
    }

    private hasMeaningfulImpactObjectValue(value: unknown): boolean {
        if (!value || typeof value !== 'object') return false;
        return Object.values(value as Record<string, unknown>).some((v) => {
            if (Array.isArray(v)) return v.length > 0;
            if (v && typeof v === 'object') return this.hasMeaningfulImpactObjectValue(v);
            return v !== null && v !== undefined && String(v).trim() !== '';
        });
    }

    private reportRequiresPartnerApproval(report: StudentReport): boolean {
        const partners = Array.isArray(report.section7?.partners) ? report.section7.partners : [];
        const hasDeclaredPartner =
            report.section7?.has_partners === 'yes' ||
            report.section8?.partner_verification === true ||
            partners.some((partner) => this.hasMeaningfulImpactObjectValue(partner));

        return Boolean(
            report.opportunity?.requiresPartnerApproval ||
            hasDeclaredPartner ||
            report.partner_status === 'approved',
        );
    }

    private isApprovedImpactReport(r: StudentReport): boolean {
        if (r.status === 'rejected' || r.partner_status === 'rejected' || r.admin_status === 'rejected') {
            return false;
        }

        const hasFinalStatus =
            r.status === 'verified' ||
            r.status === 'paid' ||
            (r.admin_status === 'approved' && ['submitted', 'partner_verified'].includes(r.status));
        const partnerApproved = !this.reportRequiresPartnerApproval(r) || r.partner_status === 'approved';

        return hasFinalStatus && partnerApproved && r.admin_status === 'approved';
    }

    /** UI status for CII rows that are not fully certified yet. */
    private deriveImpactReportPipelineStatus(r: StudentReport): string {
        if (r.status === 'rejected' || r.partner_status === 'rejected' || r.admin_status === 'rejected') {
            return 'rejected';
        }
        if (r.status === 'verified' && (r.partner_status !== 'approved' || r.admin_status !== 'approved')) {
            return 'under_review';
        }
        return 'under_review';
    }

    private toImpactNumber(value: unknown): number | null {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : null;
        }
        if (typeof value !== 'string') {
            return null;
        }
        const match = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
        if (!match) {
            return null;
        }
        const parsed = Number(match[0]);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private getReportProjectId(report: StudentReport): string | null {
        return report.opportunityId || report.project_id || null;
    }

    private getImpactReportDate(report: StudentReport): Date {
        return report.submission_date
            ? new Date(report.submission_date)
            : new Date(report.createdAt);
    }

    private getImpactReportHours(report: StudentReport): number {
        const section1 = report.section1 as
            | {
                metrics?: { total_verified_hours?: unknown };
                attendance_logs?: Array<{ hours?: unknown }>;
                team_lead?: { hours?: unknown };
            }
            | undefined;
        const section4 = report.section4 as { my_hours?: unknown } | undefined;

        const metricHours = this.toImpactNumber(section1?.metrics?.total_verified_hours);
        if (metricHours && metricHours > 0) {
            return metricHours;
        }

        const attendanceHours = Array.isArray(section1?.attendance_logs)
            ? section1.attendance_logs.reduce(
                (sum, log) => sum + (this.toImpactNumber(log?.hours) ?? 0),
                0,
            )
            : 0;
        if (attendanceHours > 0) {
            return attendanceHours;
        }

        return (
            this.toImpactNumber(section4?.my_hours) ??
            this.toImpactNumber(section1?.team_lead?.hours) ??
            0
        );
    }

    private isPendingImpactReport(report: StudentReport): boolean {
        return (
            report.status !== 'draft' &&
            report.status !== 'rejected' &&
            report.partner_status !== 'rejected' &&
            report.admin_status !== 'rejected' &&
            !this.isApprovedImpactReport(report)
        );
    }

    private collectStringsDeep(value: unknown, acc: string[]) {
        if (value == null) return;
        if (typeof value === 'string') {
            acc.push(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((v) => this.collectStringsDeep(v, acc));
            return;
        }
        if (typeof value === 'object') {
            for (const v of Object.values(value as Record<string, unknown>)) {
                this.collectStringsDeep(v, acc);
            }
        }
    }

    private collectHttpsUrls(value: unknown): string[] {
        const strings: string[] = [];
        this.collectStringsDeep(value, strings);
        return strings.filter((s) => /^https?:\/\//i.test(s));
    }

    private pickPdfUrlFromReport(report: StudentReport): string | null {
        const buckets = [
            report.section8,
            report.section2,
            report.section5,
            report.section7,
            report.section10,
        ];
        const urls = buckets.flatMap((b) => this.collectHttpsUrls(b));
        return urls.find((u) => /\.pdf($|\?)/i.test(u)) ?? null;
    }

    private pickCertificateUrlFromReport(report: StudentReport): string | null {
        const buckets = [
            report.section8,
            report.section2,
            report.section3,
            report.section5,
            report.section11,
        ];
        const urls = buckets.flatMap((b) => this.collectHttpsUrls(b));
        return (
            urls.find((u) => /certificat/i.test(u) || /\/certificates?\//i.test(u)) ?? null
        );
    }

    private impactActivityStatus(
        kind: 'hours_log' | 'cii_report',
        participation: Participation | undefined,
        opportunity: Opportunity | undefined,
    ): 'verified' | 'certified' | 'archived' {
        if (kind === 'cii_report') {
            return 'certified';
        }
        const oppStatus = (opportunity?.status || '').toLowerCase();
        const closedOpp = ['closed', 'completed', 'complete', 'verified', 'finalized'].includes(
            oppStatus,
        );
        if (participation?.status === 'finalized' && closedOpp) {
            return 'archived';
        }
        return 'verified';
    }

    /** Matches student-reports team canonical rules (DB `participations`). */
    private looksLikeImpactUuid(value?: string | null): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            (value || '').trim(),
        );
    }

    private async getTeamLeadParticipantStudentId(projectId: string): Promise<string | null> {
        const pid = projectId.trim();
        if (!this.looksLikeImpactUuid(pid)) return null;
        const leadRow = await this.participantRepository.findOne({
            where: { projectId: pid, participationMode: 'team', isTeamLead: true },
        });
        return leadRow?.studentId ?? null;
    }

    /**
     * Canonical `student_reports` row for a project (team lead's) when the viewer is a teammate.
     * Mirrors `StudentReportsService.resolveReportRecordForParticipantRead` for impact APIs.
     */
    private async resolveImpactReportCandidate(
        viewerStudentId: string,
        projectKey: string,
    ): Promise<StudentReport | null> {
        const key = projectKey.trim();
        if (!this.looksLikeImpactUuid(key)) return null;

        const mine = await this.participantRepository.findOne({
            where: { studentId: viewerStudentId, projectId: key },
        });

        const fetchLatestRow = async (sid: string) =>
            this.studentReportsRepository.findOne({
                where: [
                    { studentId: sid, opportunityId: key },
                    { studentId: sid, project_id: key },
                ],
                relations: ['opportunity', 'opportunity.organization'],
                order: { createdAt: 'DESC' },
            });

        if (mine?.participationMode === 'team' && !mine.isTeamLead) {
            const leadId = await this.getTeamLeadParticipantStudentId(key);
            if (leadId) {
                const leaderReport = await fetchLatestRow(leadId);
                if (leaderReport) return leaderReport;
            }
        }

        return fetchLatestRow(viewerStudentId);
    }

    /** Teammates may read approved CII / certificates for the team lead's report on the same project. */
    private async participantMayAccessApprovedTeamImpactReport(
        requestingStudentId: string,
        report: StudentReport,
    ): Promise<boolean> {
        if (!requestingStudentId || !report.studentId) return false;
        if (report.studentId === requestingStudentId) return true;

        const projKey = this.getReportProjectId(report);
        const pid = (projKey || '').trim();
        if (!this.looksLikeImpactUuid(pid)) return false;

        const mine = await this.participantRepository.findOne({
            where: { studentId: requestingStudentId, projectId: pid },
        });
        if (!mine || mine.participationMode !== 'team') return false;

        const leadId = await this.getTeamLeadParticipantStudentId(pid);
        return Boolean(leadId && leadId === report.studentId);
    }

    private async getApprovedOwnedReport(
        requestingUserId: string,
        role: string | undefined,
        reportId: string,
        query?: { student_id?: string; studentId?: string },
    ): Promise<StudentReport> {
        const studentId = this.resolveImpactStudentId(requestingUserId, role, query);
        const report = await this.studentReportsRepository.findOne({
            where: { id: reportId },
            relations: ['opportunity', 'opportunity.organization'],
        });
        if (!report) {
            throw new NotFoundException('Report not found');
        }
        const mayAccess =
            report.studentId === studentId ||
            (await this.participantMayAccessApprovedTeamImpactReport(studentId, report));
        if (!mayAccess) {
            throw new ForbiddenException('Access denied');
        }
        if (!this.isApprovedImpactReport(report)) {
            throw new NotFoundException('Report not available');
        }
        return report;
    }

    async getImpactHistory(
        requestingUserId: string,
        role: string | undefined,
        body?: { student_id?: string; studentId?: string },
    ) {
        const studentId = this.resolveImpactStudentId(requestingUserId, role, body);

        const [timesheets, reports, participations] = await Promise.all([
            this.timesheetsRepository.find({
                where: { studentId, status: In(['verified', 'pending']) },
                relations: ['opportunity', 'opportunity.organization'],
                order: { createdAt: 'DESC' },
            }),
            this.studentReportsRepository.find({
                where: { studentId },
                relations: ['opportunity', 'opportunity.organization'],
                order: { createdAt: 'DESC' },
            }),
            this.participantRepository.find({
                where: { studentId },
            }),
        ]);

        const participationByProject = new Map(participations.map((p) => [p.projectId, p]));
        const ownedApprovedReports = reports.filter((r) => this.isApprovedImpactReport(r));
        const seenApprovedId = new Set(ownedApprovedReports.map((r) => r.id));
        const approvedReports = [...ownedApprovedReports];
        for (const p of participations) {
            const pid = (p.projectId ?? '').trim();
            if (!this.looksLikeImpactUuid(pid)) {
                continue;
            }
            const cand = await this.resolveImpactReportCandidate(studentId, pid);
            if (cand && this.isApprovedImpactReport(cand) && !seenApprovedId.has(cand.id)) {
                seenApprovedId.add(cand.id);
                approvedReports.push(cand);
            }
        }
        approvedReports.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

        const verifiedTimesheets = timesheets.filter((t) => t.status === 'verified');
        const pendingTimesheets = timesheets.filter((t) => t.status === 'pending');
        const visibleReports = reports.filter((r) => r.status !== 'draft');
        const pendingReports = visibleReports.filter((r) => this.isPendingImpactReport(r));

        const verifiedTimesheetProjectIds = new Set(
            verifiedTimesheets.map((t) => t.opportunityId).filter(Boolean) as string[],
        );
        const pendingTimesheetProjectIds = new Set(
            pendingTimesheets.map((t) => t.opportunityId).filter(Boolean) as string[],
        );
        const reportHoursForTotals = (report: StudentReport, coveredProjectIds: Set<string>) => {
            const projectId = this.getReportProjectId(report);
            if (projectId && coveredProjectIds.has(projectId)) {
                return 0;
            }
            return this.getImpactReportHours(report);
        };

        const reportTotalHours = approvedReports.reduce(
            (sum, r) => sum + reportHoursForTotals(r, verifiedTimesheetProjectIds),
            0,
        );
        const reportPendingHours = pendingReports.reduce(
            (sum, r) => sum + reportHoursForTotals(r, pendingTimesheetProjectIds),
            0,
        );

        const totalHours = verifiedTimesheets.reduce((sum, t) => sum + t.hours, 0) + reportTotalHours;
        const pendingHours = pendingTimesheets.reduce((sum, t) => sum + t.hours, 0) + reportPendingHours;

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const reportHoursThisMonth = approvedReports
            .filter((r) => this.getImpactReportDate(r) >= startOfMonth)
            .reduce((sum, r) => sum + reportHoursForTotals(r, verifiedTimesheetProjectIds), 0);
        const reportPendingHoursThisMonth = pendingReports
            .filter((r) => this.getImpactReportDate(r) >= startOfMonth)
            .reduce((sum, r) => sum + reportHoursForTotals(r, pendingTimesheetProjectIds), 0);
        const hoursThisMonth = verifiedTimesheets
            .filter((t) => new Date(t.createdAt) >= startOfMonth)
            .reduce((sum, t) => sum + t.hours, 0) + reportHoursThisMonth;
        const pendingHoursThisMonth = pendingTimesheets
            .filter((t) => new Date(t.createdAt) >= startOfMonth)
            .reduce((sum, t) => sum + t.hours, 0) + reportPendingHoursThisMonth;

        const projectIdsFromHours = new Set(
            verifiedTimesheets.map((t) => t.opportunityId).filter(Boolean) as string[],
        );
        const projectIdsFromReports = new Set(
            approvedReports.map((r) => this.getReportProjectId(r)).filter(Boolean) as string[],
        );
        const projectsCompleted = new Set([...projectIdsFromHours, ...projectIdsFromReports]).size;

        const scoresFromReports = approvedReports
            .map((r) => Number((r.section11 as { ai_generated_impact_score?: number } | undefined)?.ai_generated_impact_score))
            .filter((n) => Number.isFinite(n));
        const maxReportScore = scoresFromReports.length ? Math.max(...scoresFromReports) : null;

        const impactScore =
            maxReportScore != null
                ? Math.round(maxReportScore)
                : Math.round(totalHours * 10 + projectsCompleted * 50);

        const impactPercentile = 'Top 10%';

        const basePrefix = '/api/v1/students/impact';

        const latestApprovedReportByOpp = new Map<string, StudentReport>();
        for (const r of approvedReports) {
            const oid = this.getReportProjectId(r);
            if (oid && !latestApprovedReportByOpp.has(oid)) {
                latestApprovedReportByOpp.set(oid, r);
            }
        }

        const activities: Record<string, unknown>[] = [];

        for (const t of timesheets) {
            const oppId = t.opportunityId;
            const part = oppId ? participationByProject.get(oppId) : undefined;
            const baseRecordStatus = oppId
                ? this.impactActivityStatus('hours_log', part, t.opportunity)
                : 'verified';
            const recordStatus =
                t.status === 'pending' ? 'pending_verification' : baseRecordStatus;
            const participationMode =
                part?.participationMode === 'team' || part?.participationMode === 'individual'
                    ? part.participationMode
                    : null;
            const linkedReport = oppId ? latestApprovedReportByOpp.get(oppId) : undefined;
            const certFromReport = linkedReport ? this.pickCertificateUrlFromReport(linkedReport) : null;
            const pdfFromReport = linkedReport ? this.pickPdfUrlFromReport(linkedReport) : null;

            activities.push({
                id: t.id,
                title: t.opportunity?.title || 'Logged hours',
                organization: t.opportunity?.organization?.name || 'Unknown Org',
                date: t.createdAt.toISOString().split('T')[0],
                hours: t.hours,
                sdg: t.opportunity?.sdg || 'General',
                record_type: 'hours_log',
                status: recordStatus,
                timesheet_status: t.status,
                participation: participationMode,
                project_id: oppId ?? null,
                opportunity_id: oppId ?? null,
                report_id: linkedReport?.id ?? null,
                actions: {
                    certificate_url:
                        linkedReport && t.status === 'verified'
                            ? certFromReport ?? `${basePrefix}/certificates/${linkedReport.id}/download`
                            : null,
                    pdf_url:
                        linkedReport && t.status === 'verified'
                            ? pdfFromReport ?? `${basePrefix}/reports/${linkedReport.id}/pdf`
                            : null,
                    cii_url:
                        linkedReport && t.status === 'verified'
                            ? `${basePrefix}/cii/${linkedReport.id}`
                            : null,
                    ai_report_url:
                        linkedReport && t.status === 'verified'
                            ? `${basePrefix}/ai-reports/${linkedReport.id}`
                            : null,
                    results_url: oppId ? `${basePrefix}/projects/${oppId}/results` : null,
                },
            });
        }

        for (const r of visibleReports) {
            const oppId = this.getReportProjectId(r);
            const part = oppId ? participationByProject.get(oppId) : undefined;
            const participationMode =
                part?.participationMode === 'team' || part?.participationMode === 'individual'
                    ? part.participationMode
                    : null;
            const s11 = (r.section11 || {}) as {
                ai_generated_impact_score?: number;
                institutional_alignment_score?: number;
            };
            const isApproved = this.isApprovedImpactReport(r);
            const pdfDirect = this.pickPdfUrlFromReport(r);
            const certDirect = this.pickCertificateUrlFromReport(r);

            if (isApproved) {
                activities.push({
                    id: r.id,
                    title: r.opportunity?.title || 'Impact report',
                    organization: r.opportunity?.organization?.name || 'Unknown Org',
                    date: r.submission_date
                        ? new Date(r.submission_date).toISOString().split('T')[0]
                        : r.createdAt.toISOString().split('T')[0],
                    hours: this.getImpactReportHours(r),
                    sdg: r.opportunity?.sdg || 'General',
                    record_type: 'cii_report',
                    status: 'certified',
                    report_status: r.status,
                    partner_status: r.partner_status,
                    admin_status: r.admin_status,
                    report_submitted_at: r.reportSubmittedAt ?? null,
                    partner_approved_at: r.partnerApprovedAt ?? null,
                    admin_approved_at: r.adminApprovedAt ?? null,
                    participation: participationMode,
                    project_id: oppId,
                    opportunity_id: oppId,
                    report_id: r.id,
                    cii_score: s11.ai_generated_impact_score ?? null,
                    institutional_alignment_score: s11.institutional_alignment_score ?? null,
                    actions: {
                        certificate_url: certDirect ?? `${basePrefix}/certificates/${r.id}/download`,
                        pdf_url: pdfDirect ?? `${basePrefix}/reports/${r.id}/pdf`,
                        cii_url: `${basePrefix}/cii/${r.id}`,
                        ai_report_url: `${basePrefix}/ai-reports/${r.id}`,
                        results_url: oppId ? `${basePrefix}/projects/${oppId}/results` : null,
                    },
                });
            } else {
                const pipelineStatus = this.deriveImpactReportPipelineStatus(r);
                activities.push({
                    id: r.id,
                    title: r.opportunity?.title || 'Impact report',
                    organization: r.opportunity?.organization?.name || 'Unknown Org',
                    date: r.submission_date
                        ? new Date(r.submission_date).toISOString().split('T')[0]
                        : r.createdAt.toISOString().split('T')[0],
                    hours: this.getImpactReportHours(r),
                    sdg: r.opportunity?.sdg || 'General',
                    record_type: 'cii_report',
                    status: pipelineStatus,
                    report_status: r.status,
                    partner_status: r.partner_status,
                    admin_status: r.admin_status,
                    report_submitted_at: r.reportSubmittedAt ?? null,
                    partner_approved_at: r.partnerApprovedAt ?? null,
                    admin_approved_at: r.adminApprovedAt ?? null,
                    participation: participationMode,
                    project_id: oppId,
                    opportunity_id: oppId,
                    report_id: r.id,
                    cii_score: s11.ai_generated_impact_score ?? null,
                    institutional_alignment_score: s11.institutional_alignment_score ?? null,
                    actions: {
                        certificate_url: null,
                        pdf_url: null,
                        cii_url: null,
                        ai_report_url: null,
                        results_url: oppId ? `${basePrefix}/projects/${oppId}/results` : null,
                    },
                });
            }
        }

        activities.sort((a, b) => String(b.date).localeCompare(String(a.date)));

        return {
            success: true,
            data: {
                total_hours: totalHours,
                pending_hours: pendingHours,
                total_logged_hours: totalHours + pendingHours,
                hours_this_month: hoursThisMonth,
                pending_hours_this_month: pendingHoursThisMonth,
                projects_completed: projectsCompleted,
                impact_score: impactScore,
                impact_percentile: impactPercentile,
                activities,
            },
        };
    }

    async getImpactCertificateDownload(
        requestingUserId: string,
        role: string | undefined,
        reportId: string,
        query?: { student_id?: string; studentId?: string },
    ) {
        const report = await this.getApprovedOwnedReport(requestingUserId, role, reportId, query);
        const url = this.pickCertificateUrlFromReport(report);
        if (!url) {
            throw new NotFoundException('Certificate not available');
        }
        return { success: true, data: { url } };
    }

    async getImpactReportPdf(
        requestingUserId: string,
        role: string | undefined,
        reportId: string,
        query?: { student_id?: string; studentId?: string },
    ) {
        const report = await this.getApprovedOwnedReport(requestingUserId, role, reportId, query);
        const url = this.pickPdfUrlFromReport(report);
        if (!url) {
            throw new NotFoundException('PDF not available');
        }
        return { success: true, data: { url } };
    }

    async getImpactCiiView(
        requestingUserId: string,
        role: string | undefined,
        reportId: string,
        query?: { student_id?: string; studentId?: string },
    ) {
        const report = await this.getApprovedOwnedReport(requestingUserId, role, reportId, query);
        const s11 = (report.section11 || {}) as {
            ai_generated_impact_score?: number;
            institutional_alignment_score?: number;
            verified_narrative?: string;
        };
        return {
            success: true,
            data: {
                report_id: report.id,
                opportunity_id: report.opportunityId,
                scores: {
                    ai_generated_impact_score: s11.ai_generated_impact_score ?? null,
                    institutional_alignment_score: s11.institutional_alignment_score ?? null,
                },
                verified_narrative: s11.verified_narrative ?? null,
            },
        };
    }

    async getImpactAiReportView(
        requestingUserId: string,
        role: string | undefined,
        reportId: string,
        query?: { student_id?: string; studentId?: string },
    ) {
        const report = await this.getApprovedOwnedReport(requestingUserId, role, reportId, query);
        const s11 = report.section11 || {};
        return {
            success: true,
            data: {
                report_id: report.id,
                opportunity_id: report.opportunityId,
                section11: s11,
            },
        };
    }

    async getImpactProjectResults(
        requestingUserId: string,
        role: string | undefined,
        opportunityId: string,
        query?: { student_id?: string; studentId?: string },
    ) {
        const studentId = this.resolveImpactStudentId(requestingUserId, role, query);
        const verifiedTs = await this.timesheetsRepository.findOne({
            where: { studentId, opportunityId, status: 'verified' },
        });
        const canonical = await this.resolveImpactReportCandidate(studentId, opportunityId);
        const approvedReport =
            canonical && this.isApprovedImpactReport(canonical) ? canonical : undefined;
        if (!verifiedTs && !approvedReport) {
            throw new NotFoundException('Results not available');
        }
        const projectPayload = await this.getProjectById(opportunityId, studentId);
        return {
            success: true,
            data: {
                ...projectPayload.data,
                completion: {
                    report_id: approvedReport?.id ?? null,
                    impact_score:
                        (approvedReport?.section11 as { ai_generated_impact_score?: number } | undefined)
                            ?.ai_generated_impact_score ?? null,
                    verified_hours: verifiedTs?.hours ?? null,
                    has_verified_report: !!approvedReport,
                },
            },
        };
    }

    // Profile
    async getProfile(userId: string) {
        const user = await this.usersRepository.findOne({
            where: { id: userId },
            relations: ['organization'],
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        return {
            success: true,
            data: await this.usersService.formatUserResponse(user),
        };
    }

    async updateProfile(userId: string, dto: UpdateStudentProfileDto) {
        const user = await this.usersRepository.findOne({
            where: { id: userId },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        Object.assign(user, dto);
        await this.usersRepository.save(user);

        return {
            success: true,
            data: await this.usersService.formatUserResponse(user),
        };
    }

    // Settings
    async getSettings(userId: string) {
        // Mock settings for now
        return {
            success: true,
            data: {
                notifications: {
                    email: true,
                    push: false,
                    sms: false,
                },
                privacy: {
                    profileVisibility: 'public',
                    showEmail: false,
                },
                language: 'en',
                theme: 'light',
            },
        };
    }

    async updateSettings(userId: string, settings: any) {
        // Mock implementation
        return {
            success: true,
            data: settings,
        };
    }
}

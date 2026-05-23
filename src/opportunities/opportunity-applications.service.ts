import {
    Injectable,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Not, Repository } from 'typeorm';
import { OpportunityApplication, OpportunityApplicationInternalStatus } from './entities/opportunity-application.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { EngagementService } from '../engagement/engagement.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Opportunity } from './entities/opportunity.entity';
import { WORKFLOW_STAGE } from './opportunity-workflow.service';
import { isTeamApplyFromParticipationAndMembers } from './apply-team-payload.util';
import { AdminPatchTeamMemberDto } from './dto/admin-patch-team-member.dto';

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
        @InjectRepository(Opportunity)
        private readonly opportunityRepo: Repository<Opportunity>,
        @InjectRepository(Participation)
        private readonly participationRepo: Repository<Participation>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        @InjectRepository(StudentReport)
        private readonly studentReportRepo: Repository<StudentReport>,
        @InjectRepository(AttendanceLog)
        private readonly attendanceLogRepo: Repository<AttendanceLog>,
        private readonly engagementService: EngagementService,
        private readonly usersService: UsersService,
        private readonly facultyUniversityScopeService: FacultyUniversityScopeService,
    ) {}

    normalizeEmail(email?: string | null) {
        return (email || '').trim().toLowerCase();
    }

    /**
     * Teammates from join `apply_payload` for faculty lists (lead/applicant is shown separately via student_user).
     */
    private facultyJoinApplicationTeamMembersForDisplay(app: OpportunityApplication): {
        participation_type: string;
        team_members: { name: string; email: string }[];
    } {
        const payload =
            app.applyPayload && typeof app.applyPayload === 'object'
                ? (app.applyPayload as Record<string, unknown>)
                : {};
        const ptRaw = typeof payload['participation_type'] === 'string' ? payload['participation_type'].trim() : '';
        let participation_type = ptRaw ? ptRaw.toLowerCase() : 'individual';
        const leadNorm = this.normalizeEmail(app.studentUser?.email ?? '');
        const raw = Array.isArray(payload['team_members'])
            ? (payload['team_members'] as { email?: unknown; name?: unknown }[])
            : [];
        if (isTeamApplyFromParticipationAndMembers(payload['participation_type'], raw)) {
            participation_type = 'team';
        }
        const team_members: { name: string; email: string }[] = [];
        const seenNorm = new Set<string>();
        for (const m of raw) {
            const rawEmail = typeof m?.email === 'string' ? m.email.trim() : '';
            if (!rawEmail) continue;
            const norm = this.normalizeEmail(rawEmail);
            if (seenNorm.has(norm)) continue;
            seenNorm.add(norm);
            if (norm === leadNorm) continue;
            const name = typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : '—';
            team_members.push({ name, email: rawEmail });
        }
        return { participation_type, team_members };
    }

    /**
     * Admin pending queue (`findPendingApplications`): lead + `apply_payload` teammates for browse/join team apps.
     */
    adminBrowseApplicationTeamSummaryForQueue(app: OpportunityApplication): {
        team_member_count: number;
        team_members: { name: string; email: string; is_team_lead: boolean }[];
    } | null {
        const { participation_type, team_members } = this.facultyJoinApplicationTeamMembersForDisplay(app);
        if (participation_type !== 'team') {
            return null;
        }
        const leadName = (app.studentUser?.name || '').trim() || '—';
        const leadEmail = (app.studentUser?.email || '').trim() || '—';
        const roster: { name: string; email: string; is_team_lead: boolean }[] = [
            { name: leadName, email: leadEmail, is_team_lead: true },
        ];
        for (const m of team_members) {
            roster.push({
                name: m.name,
                email: m.email,
                is_team_lead: false,
            });
        }
        return {
            team_member_count: roster.length,
            team_members: roster,
        };
    }

    /**
     * Normalized emails of everyone already tied to a non-withdrawn application:
     * the applicant (lead) plus every email listed in apply_payload.team_members.
     */
    async collectClaimedEmailsOnOpenApplications(opportunityId: string): Promise<Set<string>> {
        const rows = await this.appRepo.find({
            where: { opportunityId, withdrawnAt: IsNull() },
            relations: ['studentUser'],
        });
        const out = new Set<string>();
        for (const row of rows) {
            const lead = this.normalizeEmail(row.studentUser?.email ?? '');
            if (lead) out.add(lead);
            const raw = row.applyPayload?.team_members;
            if (Array.isArray(raw)) {
                for (const m of raw) {
                    const em = typeof (m as { email?: unknown })?.email === 'string'
                        ? this.normalizeEmail((m as { email: string }).email)
                        : '';
                    if (em) out.add(em);
                }
            }
        }
        return out;
    }

    /** True if this team slug is used by active seat rows or another in-flight application. */
    async isTeamSlugInUseOnOpportunity(
        opportunityId: string,
        rawTeamId: string | undefined | null,
    ): Promise<boolean> {
        const teamId = (rawTeamId || '').trim();
        if (!teamId) return false;

        const existingSeats = await this.participationRepo.count({
            where: {
                projectId: opportunityId,
                teamId,
                status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
            },
        });
        if (existingSeats > 0) return true;

        const inflight = await this.appRepo
            .createQueryBuilder('a')
            .where('a.opportunity_id = :oid', { oid: opportunityId })
            .andWhere('a.withdrawn_at IS NULL')
            .andWhere(`TRIM(COALESCE(a.apply_payload->>'team_id','')) = :teamId`, { teamId })
            .getCount();
        return inflight > 0;
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

    /** Matches `TeamOverviewRow.id` emitted by {@link adminListOpportunityTeams} for DELETE/PATCH routing. */
    private participationListingGroupId(p: Participation): string {
        const tid = (p.teamId || '').trim();
        return tid || `individual:${((p.studentId || p.id) || '').trim()}`;
    }

    private formatPakCnicDigitsDisplay(digits: string): string | null {
        const d = (digits || '').replace(/\D/g, '');
        if (d.length !== 13) {
            return d.length ? d : null;
        }
        return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
    }

    private participationMobileAndCnicSnapshot(member: Participation) {
        const decrypted = member.cnic ? this.engagementService.decryptCnicInternal(member.cnic) : '';
        const digitCnic = (decrypted || '').replace(/\D/g, '');
        return {
            phone_number: member.mobile?.trim() || null,
            cnic_display: this.formatPakCnicDigitsDisplay(digitCnic),
        };
    }

    private academicSnapshot(member: Participation) {
        return {
            university_id: member.universityId ?? null,
            university_name: member.universityName ?? null,
            academic_program: member.academicProgram ?? null,
            department: member.department ?? null,
            year_of_study: member.yearOfStudy ?? null,
            academic_integration_type: member.academicIntegrationType ?? null,
        };
    }

    /** `pending:${applicationId}:m:${normalizedEmail}` teammate rows emitted by {@link adminListOpportunityTeams}. */
    private parsePendingRosterSyntheticTeammateId(memberId: string): { applicationId: string; emailNormalized: string } | null {
        const prefix = 'pending:';
        if (!memberId.startsWith(prefix)) return null;
        const sep = ':m:';
        const k = memberId.indexOf(sep);
        if (k < 0) return null;
        const applicationId = memberId.slice(prefix.length, k).trim();
        const emailNormalized = memberId.slice(k + sep.length).trim();
        if (!applicationId || !emailNormalized) return null;
        return { applicationId, emailNormalized };
    }

    /** Participation primary keys are UUIDs — never bind synthetic roster ids to `uuid` columns. */
    private looksLikeUuidParam(value: string): boolean {
        const s = value.trim();
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    }

    /** Pending pipeline rows belong to exactly one roster team id carried in apply payload. */
    private ensurePendingApplyPayloadMatchesTeam(payload: Record<string, unknown>, teamIdParam: string): void {
        const rawTeamId = typeof payload['team_id'] === 'string' ? payload['team_id'].trim() : '';
        const paramNorm = decodeURIComponent((teamIdParam || '').trim()).trim();
        if (!rawTeamId || rawTeamId !== paramNorm) {
            throw new BadRequestException(
                `Team grouping mismatch (${paramNorm}). Refresh the roster and retry from the latest team id.`,
            );
        }
    }

    /** Lead-only academic fields stored on draft apply payload (`admin_correction`) until enrollment exists. */
    private mergeLeadPayloadAdminCorrection(
        payload: Record<string, unknown>,
        dto: AdminPatchTeamMemberDto,
    ): Record<string, unknown> {
        const next = { ...payload };
        const prev =
            typeof next['admin_correction'] === 'object' &&
            next['admin_correction'] !== null &&
            !Array.isArray(next['admin_correction']) ?
                { ...(next['admin_correction'] as Record<string, unknown>) }
            :   {};
        let changed = Boolean(Object.keys(prev).length);
        if (dto.year_of_study) {
            prev['year_of_study'] = dto.year_of_study;
            changed = true;
        }
        if (dto.academic_integration_type) {
            prev['academic_integration_type'] = dto.academic_integration_type;
            changed = true;
        }
        if (changed) next['admin_correction'] = prev;
        else delete next['admin_correction'];
        return next;
    }

    private async adminPatchPendingSyntheticTeammate(
        opportunityId: string,
        teamIdParam: string,
        decodedMemberId: string,
        applicationId: string,
        emailNormalized: string,
        dto: AdminPatchTeamMemberDto,
    ) {
        const app = await this.appRepo.findOne({
            where: { id: applicationId, opportunityId, withdrawnAt: IsNull() },
            relations: ['studentUser'],
        });
        if (!app || !PENDING_PIPELINE.includes(app.internalStatus)) {
            throw new NotFoundException('Pending application roster entry not found for this opportunity');
        }
        let payloadCopy: Record<string, unknown> = {
            ...(app.applyPayload && typeof app.applyPayload === 'object' ? app.applyPayload : {}),
        } as Record<string, unknown>;

        this.ensurePendingApplyPayloadMatchesTeam(payloadCopy, teamIdParam);

        const leadNorm = this.normalizeEmail(app.studentUser?.email ?? '');
        if (leadNorm === this.normalizeEmail(emailNormalized)) {
            throw new BadRequestException('Lead row is patched with the application member id — use Update on the lead line instead.');
        }

        const teamMembersRaw =
            Array.isArray(payloadCopy['team_members']) ?
                ([...(payloadCopy['team_members'] as Array<Record<string, unknown>>)] as Array<Record<string, unknown>>)
            :   [];
        const ix = teamMembersRaw.findIndex(
            (row) =>
                typeof row?.['email'] === 'string'
                && this.normalizeEmail(row['email'] as string) === this.normalizeEmail(emailNormalized),
        );
        if (ix < 0) {
            throw new NotFoundException('That teammate email is not on this application roster');
        }
        const row = { ...(teamMembersRaw[ix] as Record<string, unknown>) };
        if (dto.full_name?.trim()) {
            row.name = dto.full_name.trim();
        }
        if (dto.mobile !== undefined && dto.mobile.trim().length >= 6) {
            row.mobile = dto.mobile.trim();
        }
        if (dto.cnic?.trim()) {
            row.admin_cnic = dto.cnic.trim();
        }
        teamMembersRaw[ix] = row;
        payloadCopy['team_members'] = teamMembersRaw;

        const syncLinkedUserProfile = dto.sync_linked_user_profile !== false;
        const mateEmailRaw = typeof row['email'] === 'string' ? (row['email'] as string).trim() : '';
        const mateNorm = mateEmailRaw ? this.normalizeEmail(mateEmailRaw) : this.normalizeEmail(emailNormalized);
        let linked: User | null = null;
        if (syncLinkedUserProfile && mateNorm) {
            linked = await this.userRepo
                .createQueryBuilder('u')
                .where('LOWER(TRIM(u.email)) = :e', { e: mateNorm })
                .getOne();
        }
        if (linked) {
            const patch: Record<string, unknown> = {};
            if (dto.full_name?.trim()) patch.name = dto.full_name.trim();
            if (dto.mobile !== undefined && dto.mobile.trim().length >= 6) {
                const raw = dto.mobile.trim();
                if (raw.startsWith('+')) {
                    patch.phone = raw;
                    patch.countryCode = null;
                } else {
                    patch.phone = raw;
                }
            }
            if (dto.cnic?.trim()) {
                const digitsUser = dto.cnic.replace(/\D/g, '');
                if (digitsUser.length === 13) patch.cnic = digitsUser;
            }
            if (dto.university_name?.trim()) patch.university = dto.university_name.trim();
            if (dto.academic_program?.trim()) patch.major = dto.academic_program.trim();
            if (dto.department?.trim()) patch.department = dto.department.trim();
            if (Object.keys(patch).length) await this.usersService.update(linked.id, patch);
        }

        app.applyPayload = payloadCopy;
        await this.appRepo.save(app);

        const hydrateNeedle = mateNorm;
        let prof: User | null = null;
        if (hydrateNeedle) {
            prof =
                linked
                ?? (await this.userRepo
                    .createQueryBuilder('u')
                    .where('LOWER(TRIM(u.email)) = :e', { e: hydrateNeedle })
                    .getOne());
        }
        const jsonPhone =
            typeof row.mobile === 'string' && row.mobile.trim() ?
                row.mobile.trim()
            :   '';
        const rawCnic =
            typeof row.admin_cnic === 'string' && row.admin_cnic.trim()
                ? row.admin_cnic.trim()
                :   '';
        const phoneMate =
            prof?.phone?.trim().length ?
                `${(prof.countryCode || '').trim()}${prof.phone.trim()}`.trim()
            :   '';

        const memberPayload: Record<string, unknown> = {
            id: decodedMemberId,
            supports_admin_patch: true,
            member_source: 'pending_application',
            name: typeof row.name === 'string' ? row.name : null,
            email: mateEmailRaw || null,
            role: 'member',
            report_status: 'not_started',
            report_available: false,
            phone_number: jsonPhone || phoneMate || null,
            cnic_display:
                rawCnic ?
                    this.formatPakCnicDigitsDisplay(rawCnic.replace(/\D/g, ''))
                : prof?.cnic ?
                    this.formatPakCnicDigitsDisplay(prof.cnic.replace(/\D/g, ''))
                : null,
            university_id: null,
            university_name: prof?.university ?? prof?.institution ?? null,
            academic_program: prof?.major ?? null,
            department: prof?.department ?? null,
            year_of_study: null,
            academic_integration_type: null,
        };

        return { success: true, data: { member: memberPayload } };
    }

    private async adminPatchPendingApplicationLead(
        app: OpportunityApplication,
        teamIdParam: string,
        dto: AdminPatchTeamMemberDto,
        decodedMemberId: string,
    ) {
        if (!PENDING_PIPELINE.includes(app.internalStatus)) {
            throw new NotFoundException('Pending application roster entry not found for this opportunity');
        }
        const payloadCopy: Record<string, unknown> = {
            ...(app.applyPayload && typeof app.applyPayload === 'object' ? app.applyPayload : {}),
        };

        this.ensurePendingApplyPayloadMatchesTeam(payloadCopy, teamIdParam);

        if (dto.cnic?.trim()) {
            const normalizedCnicDigits = dto.cnic.replace(/\D/g, '');
            const hash = this.engagementService.getCnicHashForNormalizedDigits(normalizedCnicDigits);
            const conflict = await this.participationRepo.findOne({
                where: { projectId: app.opportunityId, cnicHash: hash },
            });
            if (conflict) {
                throw new BadRequestException(
                    'Another enrollment on this project already uses this CNIC. Withdraw or correct that seat first.',
                );
            }
        }

        let nextPayload =
            dto.year_of_study || dto.academic_integration_type
                ? this.mergeLeadPayloadAdminCorrection(payloadCopy, dto)
                : payloadCopy;

        if (dto.mobile !== undefined && dto.mobile.trim().length >= 6) {
            nextPayload = { ...nextPayload, contact_phone_e164: dto.mobile.trim() };
        }

        const syncLinkedUserProfile = dto.sync_linked_user_profile !== false;
        if (syncLinkedUserProfile && app.studentUserId) {
            const uPatch: Record<string, unknown> = {};
            if (dto.full_name?.trim()) uPatch.name = dto.full_name.trim();
            if (dto.mobile !== undefined && dto.mobile.trim().length >= 6) {
                const raw = dto.mobile.trim();
                if (raw.startsWith('+')) {
                    uPatch.phone = raw;
                    uPatch.countryCode = null;
                } else {
                    uPatch.phone = raw;
                }
            }
            if (dto.cnic?.trim()) {
                const digitsUser = dto.cnic.replace(/\D/g, '');
                if (digitsUser.length === 13) uPatch.cnic = digitsUser;
            }
            if (dto.university_name?.trim()) uPatch.university = dto.university_name.trim();
            if (dto.academic_program?.trim()) uPatch.major = dto.academic_program.trim();
            if (dto.department?.trim()) uPatch.department = dto.department.trim();
            if (Object.keys(uPatch).length) {
                await this.usersService.update(app.studentUserId, uPatch);
            }
        }

        app.applyPayload = nextPayload;
        await this.appRepo.save(app);

        const fresh = await this.appRepo.findOne({
            where: { id: app.id },
            relations: ['studentUser'],
        });
        if (!fresh?.studentUser) {
            throw new NotFoundException('Application no longer exists after update');
        }
        const mergedPayload =
            fresh.applyPayload && typeof fresh.applyPayload === 'object'
                ? (fresh.applyPayload as Record<string, unknown>)
                : {};
        const leadProfile = fresh.studentUser;
        const leadUser = leadProfile;

        const phoneFromApply =
            typeof mergedPayload['contact_phone_e164'] === 'string'
                ? (mergedPayload['contact_phone_e164'] as string).trim()
                : '';
        const phoneFromUser =
            leadProfile?.phone?.trim().length ?
                `${(leadProfile.countryCode || '').trim()}${leadProfile.phone.trim()}`.trim()
            :   '';
        const adminCorr =
            typeof mergedPayload['admin_correction'] === 'object'
            && mergedPayload['admin_correction'] !== null
            && !Array.isArray(mergedPayload['admin_correction']) ?
                (mergedPayload['admin_correction'] as Record<string, unknown>)
            :   {};
        const yearFromCorr =
            typeof adminCorr.year_of_study === 'string' && (adminCorr.year_of_study as string).trim() ?
                (adminCorr.year_of_study as string).trim()
            :   null;
        const integFromCorr =
            typeof adminCorr.academic_integration_type === 'string'
            && (adminCorr.academic_integration_type as string).trim() ?
                (adminCorr.academic_integration_type as string).trim()
            :   null;

        const memberPayload: Record<string, unknown> = {
            id: decodedMemberId,
            supports_admin_patch: true,
            member_source: 'pending_application',
            name: leadUser?.name ?? null,
            email: leadUser?.email ?? null,
            role: 'lead',
            report_status: 'not_started',
            report_available: false,
            phone_number: phoneFromApply || phoneFromUser || null,
            cnic_display: leadProfile?.cnic
                ? this.formatPakCnicDigitsDisplay(leadProfile.cnic.replace(/\D/g, ''))
                : null,
            university_id: null,
            university_name: leadProfile?.university ?? leadProfile?.institution ?? null,
            academic_program: leadProfile?.major ?? null,
            department: leadProfile?.department ?? null,
            year_of_study: yearFromCorr,
            academic_integration_type: integFromCorr,
        };

        return { success: true, data: { member: memberPayload } };
    }

    private pickLatestReportForStudent(reports: StudentReport[], studentId: string): StudentReport | null {
        const forStudent = reports.filter((r) => r.studentId === studentId);
        if (!forStudent.length) return null;
        return [...forStudent].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
    }

    private attendanceLogNeedsPartnerOrFacultyReview(log: AttendanceLog): boolean {
        const route = log.approvalStatus?.trim() || '';
        if (route === 'approved' || route === 'rejected') return false;
        if (route === 'pending' || route === 'flagged') return true;
        return log.entryStatus === 'pending' || log.entryStatus === 'flagged';
    }

    private async rollupAttendanceReviewsForParticipants(
        projectId: string,
        participantIds: string[],
    ): Promise<Map<string, { sessions_total: number; sessions_pending_review: number }>> {
        const out = new Map<string, { sessions_total: number; sessions_pending_review: number }>();
        const dedup = [...new Set(participantIds.filter((id) => Boolean(id?.trim())))];
        for (const id of dedup) {
            out.set(id, { sessions_total: 0, sessions_pending_review: 0 });
        }
        if (!dedup.length) return out;

        const logs = await this.attendanceLogRepo.find({
            where: { projectId, participantId: In(dedup) },
            select: ['participantId', 'entryStatus', 'approvalStatus'],
        });

        for (const log of logs) {
            const agg = out.get(log.participantId);
            if (!agg) continue;
            agg.sessions_total += 1;
            if (this.attendanceLogNeedsPartnerOrFacultyReview(log)) {
                agg.sessions_pending_review += 1;
            }
        }

        return out;
    }

    /** Per-session breakdown for admin project tracker (newest first, capped per seat). */
    private serializeAttendanceSessionForTracker(log: AttendanceLog): Record<string, unknown> {
        const desc = (log.description || '').trim();
        return {
            id: log.id,
            date_of_engagement: log.dateOfEngagement,
            start_time: log.startTime,
            end_time: log.endTime,
            session_hours: Number(log.sessionHours),
            activity_type: log.activityType ?? null,
            organization_name: log.organizationName ?? null,
            description: desc.length > 280 ? `${desc.slice(0, 277)}…` : desc || null,
            entry_status: log.entryStatus,
            approval_status: log.approvalStatus ?? null,
            assigned_approver_type: log.assignedApproverType ?? null,
            evidence_uploaded: log.evidenceUploaded,
            needs_review: this.attendanceLogNeedsPartnerOrFacultyReview(log),
        };
    }

    private async attendanceSessionsPreviewByParticipant(
        projectId: string,
        participantIds: string[],
        maxPerSeat: number,
    ): Promise<Map<string, Record<string, unknown>[]>> {
        const empty = new Map<string, Record<string, unknown>[]>();
        const dedup = [...new Set(participantIds.filter((id) => Boolean(id?.trim())))];
        for (const id of dedup) {
            empty.set(id, []);
        }
        if (!dedup.length) return empty;

        const logs = await this.attendanceLogRepo.find({
            where: { projectId, participantId: In(dedup) },
        });

        const grouped = new Map<string, AttendanceLog[]>();
        for (const l of logs) {
            const pid = l.participantId;
            if (!grouped.has(pid)) grouped.set(pid, []);
            grouped.get(pid)!.push(l);
        }

        const cap = Math.max(1, Math.min(maxPerSeat, 60));
        const out = new Map<string, Record<string, unknown>[]>();
        for (const id of dedup) {
            const arr = grouped.get(id) ?? [];
            arr.sort((a, b) => {
                const da = String(a.dateOfEngagement || '');
                const db = String(b.dateOfEngagement || '');
                if (da !== db) return db.localeCompare(da);
                const sa = String(a.startTime || '');
                const sb = String(b.startTime || '');
                if (sa !== sb) return sb.localeCompare(sa);
                return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
            });
            out.set(id, arr.slice(0, cap).map((log) => this.serializeAttendanceSessionForTracker(log)));
        }
        return out;
    }

    /** Admin tracker: human join-queue label (never null for enrollments workflow). */
    private trackerJoinApplicationsStageLabel(internal: OpportunityApplicationInternalStatus): string {
        switch (internal) {
            case 'approved':
                return 'Approved — enrollment complete';
            case 'pending_faculty':
                return 'Join queue · awaiting faculty';
            case 'pending_partner':
                return 'Join queue · awaiting partner / org';
            case 'pending_admin':
                return 'Join queue · awaiting admin';
            case 'faculty_rejected':
                return 'Rejected · faculty';
            case 'partner_rejected':
                return 'Rejected · partner / org';
            case 'admin_rejected':
                return 'Rejected · admin';
            default:
                return String(internal || 'unknown').replace(/_/g, ' ');
        }
    }

    private trackerImpactReportEnrollmentFields(report: StudentReport | null): Record<string, unknown> {
        if (!report) {
            return {
                impact_report_started: false,
                impact_report_status: null,
                impact_report_summary: 'No impact report yet',
                impact_report_partner_status: null,
                impact_report_admin_status: null,
                impact_report_faculty_status: null,
            };
        }
        const st = this.mapReportStatusForAdminList(report.status);
        const ps = report.partner_status || 'pending';
        const ads = report.admin_status || 'pending';
        const fs = report.faculty_status || 'pending';

        let summary: string;
        if (st === 'verified' || st === 'paid') {
            summary = 'Impact report verified · complete';
        } else if (st === 'rejected') {
            summary = 'Impact report rejected';
        } else if (st === 'draft' || !st) {
            summary = 'Impact report draft / not submitted';
        } else if (st === 'payment_pending' || st === 'payment_under_review') {
            summary = 'Payment / final review pending';
        } else if (st === 'submitted') {
            if (ps === 'pending') {
                summary = 'Submitted · partner approval pending';
            } else if (ads === 'pending') {
                summary = 'Submitted · admin approval pending';
            } else {
                summary = `Submitted (${st})`;
            }
        } else {
            summary = `In progress (${st})`;
        }

        return {
            impact_report_started: true,
            impact_report_status: st,
            impact_report_summary: summary,
            impact_report_partner_status: ps,
            impact_report_admin_status: ads,
            impact_report_faculty_status: fs,
        };
    }

    async adminListOpportunityTeams(opportunityId: string) {
        const rows = await this.participationRepo
            .createQueryBuilder('p')
            .leftJoinAndSelect('p.student', 'student')
            .where('p.projectId = :opportunityId', { opportunityId })
            .andWhere('p.status IN (:...statuses)', { statuses: [...TEAM_ACTIVE_PARTICIPATION_STATUSES] })
            .orderBy('p.createdAt', 'ASC')
            .getMany();

        const rowsByTeamId = new Map<string, Participation[]>();
        for (const row of rows) {
            const normalizedTeamId = (row.teamId || '').trim();
            const groupId = normalizedTeamId || `individual:${row.studentId || row.id}`;
            if (!rowsByTeamId.has(groupId)) {
                rowsByTeamId.set(groupId, []);
            }
            rowsByTeamId.get(groupId)!.push(row);
        }

        const studentIds = rows
            .map((r) => r.studentId)
            .filter((id): id is string => Boolean(id));
        const reports = await this.findReportsForOpportunityAndStudents(opportunityId, studentIds);

        const data: Array<Record<string, unknown>> = [];
        let completedReports = 0;
        let reportsAvailable = 0;

        for (const [groupId, members] of rowsByTeamId.entries()) {
            const actualTeamId = (members[0]?.teamId || '').trim() || null;
            const isIndividualEntry = !actualTeamId;
            const lead = members.find((m) => m.isTeamLead) ?? members[0];

            /** One dashboard row per person (legacy duplicates share email / student id). */
            const dedupMembers: Participation[] = [];
            const seenMemberKeys = new Set<string>();
            for (const member of members) {
                const sid = member.studentId?.trim();
                const ek = sid
                    ? `s:${sid}`
                    : (() => {
                          const raw = member.student?.email ?? member.email ?? '';
                          const n = this.normalizeEmail(raw);
                          return n ? `e:${n}` : `id:${member.id}`;
                      })();
                if (!isIndividualEntry && seenMemberKeys.has(ek)) {
                    continue;
                }
                if (!isIndividualEntry) {
                    seenMemberKeys.add(ek);
                }
                dedupMembers.push(member);
            }

            const memberPayload = dedupMembers.map((member) => {
                const rep = member.studentId
                    ? this.pickLatestReportForStudent(reports, member.studentId)
                    : null;
                const reportStatus = this.toTeamReportStatus(rep?.status);
                const snap = this.participationMobileAndCnicSnapshot(member);
                return {
                    id: member.id,
                    supports_admin_patch: true,
                    name: member.student?.name ?? member.fullName ?? null,
                    email: member.student?.email ?? member.email ?? null,
                    role: isIndividualEntry || member.isTeamLead ? 'lead' : 'member',
                    report_status: reportStatus,
                    report_available: reportStatus !== 'not_started',
                    phone_number: snap.phone_number,
                    cnic_display: snap.cnic_display,
                    ...this.academicSnapshot(member),
                };
            });
            const teamReportStatus = this.aggregateTeamReportStatus(
                memberPayload.map((m) => m.report_status as 'not_started' | 'in_progress' | 'completed'),
            );
            const teamReportAvailable = teamReportStatus !== 'not_started';
            if (teamReportStatus === 'completed') completedReports += 1;
            if (teamReportAvailable) reportsAvailable += 1;

            const fallbackTeamName = lead?.student?.name ?? lead?.fullName ?? 'Individual Participant';
            data.push({
                id: actualTeamId || groupId,
                team_id: actualTeamId || groupId,
                team_name: actualTeamId ? `Team ${actualTeamId.slice(0, 8)}` : fallbackTeamName,
                lead_name: lead?.student?.name ?? lead?.fullName ?? null,
                participation_mode: isIndividualEntry ? 'individual' : 'team',
                report_status: teamReportStatus,
                report_available: teamReportAvailable,
                members: memberPayload,
            });
        }

        const coveredTeamIds = new Set(
            data.map((row) => String(row['team_id'] ?? '').trim()).filter(Boolean),
        );

        const pendingPipelineApps = await this.appRepo.find({
            where: {
                opportunityId,
                withdrawnAt: IsNull(),
                internalStatus: In(PENDING_PIPELINE),
            },
            relations: ['studentUser'],
            order: { createdAt: 'ASC' },
        });

        /** Best-effort profile hints while team is still awaiting approval/seat creation. */
        const pendingHydrationEmails = new Set<string>();
        for (const app of pendingPipelineApps) {
            const payload = app.applyPayload || {};
            const teamMembersRaw = Array.isArray(payload['team_members'])
                ? (payload['team_members'] as Array<{ email?: string; name?: string }>)
                : [];
            const ln = this.normalizeEmail(app.studentUser?.email ?? '');
            if (ln) pendingHydrationEmails.add(ln);
            for (const m of teamMembersRaw) {
                const em = typeof m?.email === 'string' ? this.normalizeEmail(m.email) : '';
                if (em) pendingHydrationEmails.add(em);
            }
        }
        const hydrationNeedles = [...pendingHydrationEmails].filter(Boolean);
        const pendingUserByEmail = new Map<string, User>();
        if (hydrationNeedles.length) {
            const usersBatch = await this.userRepo
                .createQueryBuilder('u')
                .where(`LOWER(TRIM(u.email)) IN (:...emails)`, {
                    emails: hydrationNeedles,
                })
                .getMany();
            for (const u of usersBatch) {
                pendingUserByEmail.set(this.normalizeEmail(u.email), u);
            }
        }

        for (const app of pendingPipelineApps) {
            const payload = app.applyPayload || {};
            const rawTeamId =
                typeof payload['team_id'] === 'string' ? payload['team_id'].trim() : '';
            const teamMembersRaw = Array.isArray(payload['team_members'])
                ? (payload['team_members'] as Array<{ email?: string; name?: string }>)
                : [];
            const isTeamApply = isTeamApplyFromParticipationAndMembers(
                payload['participation_type'],
                teamMembersRaw,
            );
            if (!rawTeamId || !isTeamApply || coveredTeamIds.has(rawTeamId)) {
                continue;
            }
            coveredTeamIds.add(rawTeamId);

            const leadUser = app.studentUser;
            const leadEmail = this.normalizeEmail(leadUser?.email ?? '');
            const leadProfile = leadEmail ? pendingUserByEmail.get(leadEmail) : undefined;
            const phoneFromApply =
                typeof payload['contact_phone_e164'] === 'string'
                    ? payload['contact_phone_e164'].trim()
                    : '';
            const phoneFromUser =
                leadProfile?.phone?.trim().length ?
                    `${(leadProfile.countryCode || '').trim()}${leadProfile.phone.trim()}`.trim()
                :   '';
            const adminCorr =
                typeof payload['admin_correction'] === 'object' &&
                payload['admin_correction'] !== null &&
                !Array.isArray(payload['admin_correction']) ?
                    (payload['admin_correction'] as Record<string, unknown>)
                :   {};
            const yearFromCorr =
                typeof adminCorr.year_of_study === 'string' && adminCorr.year_of_study.trim() ?
                    adminCorr.year_of_study.trim()
                :   null;
            const integFromCorr =
                typeof adminCorr.academic_integration_type === 'string' && adminCorr.academic_integration_type.trim() ?
                    adminCorr.academic_integration_type.trim()
                :   null;
            const memberPayload: Array<Record<string, unknown>> = [
                {
                    id: app.id,
                    supports_admin_patch: true,
                    member_source: 'pending_application',
                    name: leadUser?.name ?? null,
                    email: leadUser?.email ?? null,
                    role: 'lead',
                    report_status: 'not_started',
                    report_available: false,
                    phone_number: phoneFromApply || phoneFromUser || null,
                    cnic_display: leadProfile?.cnic
                        ? this.formatPakCnicDigitsDisplay(leadProfile.cnic.replace(/\D/g, ''))
                        : null,
                    university_id: null,
                    university_name: leadProfile?.university ?? leadProfile?.institution ?? null,
                    academic_program: leadProfile?.major ?? null,
                    department: leadProfile?.department ?? null,
                    year_of_study: yearFromCorr,
                    academic_integration_type: integFromCorr,
                },
            ];
            for (const m of teamMembersRaw) {
                const em = typeof m?.email === 'string' ? this.normalizeEmail(m.email) : '';
                if (!em || em === leadEmail) continue;
                const prof = pendingUserByEmail.get(em);
                const mExt = m as Record<string, unknown>;
                const jsonPhone =
                    typeof mExt.mobile === 'string' && mExt.mobile.trim() ?
                        mExt.mobile.trim()
                    :   '';
                const rawCnic =
                    typeof mExt.admin_cnic === 'string' && mExt.admin_cnic.trim() ?
                        mExt.admin_cnic.trim()
                    :   '';
                const phoneMate =
                    prof?.phone?.trim().length ?
                        `${(prof.countryCode || '').trim()}${prof.phone.trim()}`.trim()
                    :   '';
                memberPayload.push({
                    id: `pending:${app.id}:m:${em}`,
                    supports_admin_patch: true,
                    member_source: 'pending_application',
                    name: typeof m?.name === 'string' ? m.name : null,
                    email: typeof m?.email === 'string' ? m.email.trim() : null,
                    role: 'member',
                    report_status: 'not_started',
                    report_available: false,
                    phone_number: jsonPhone || phoneMate || null,
                    cnic_display:
                        rawCnic ?
                            this.formatPakCnicDigitsDisplay(rawCnic.replace(/\D/g, ''))
                        : prof?.cnic ?
                            this.formatPakCnicDigitsDisplay(prof.cnic.replace(/\D/g, ''))
                        : null,
                    university_id: null,
                    university_name: prof?.university ?? prof?.institution ?? null,
                    academic_program: prof?.major ?? null,
                    department: prof?.department ?? null,
                    year_of_study: null,
                    academic_integration_type: null,
                });
            }

            data.push({
                id: rawTeamId,
                team_id: rawTeamId,
                team_name: `Team ${rawTeamId.slice(0, 8)}`,
                lead_name: leadUser?.name ?? null,
                participation_mode: 'team',
                report_status: 'not_started',
                report_available: false,
                members: memberPayload,
            });
        }

        const opp = await this.opportunityRepo.findOne({
            where: { id: opportunityId },
            relations: ['organization'],
        });
        const pipelineCountRows = await this.appRepo
            .createQueryBuilder('a')
            .select('a.internalStatus', 'status')
            .addSelect('COUNT(*)', 'cnt')
            .where('a.opportunityId = :oid', { oid: opportunityId })
            .andWhere('a.withdrawnAt IS NULL')
            .groupBy('a.internalStatus')
            .getRawMany();

        const appsByStatus: Record<string, number> = {
            pending_faculty: 0,
            pending_partner: 0,
            pending_admin: 0,
            approved: 0,
            faculty_rejected: 0,
            partner_rejected: 0,
            admin_rejected: 0,
        };
        for (const r of pipelineCountRows) {
            const key = String((r as { status?: unknown }).status ?? '').trim();
            if (key in appsByStatus) appsByStatus[key] = Number((r as { cnt?: unknown }).cnt) || 0;
        }
        const awaitingSide =
            opp?.faculty_verification_status === 'pending_faculty'
                ? 'faculty_gate'
                : opp && !opp.execution_verified && opp.execution_verification_status === 'pending_execution'
                  ? 'execution_partner_gate'
                  : null;

        const allApplications = await this.appRepo.find({
            where: { opportunityId, withdrawnAt: IsNull() },
            relations: ['studentUser'],
            order: { createdAt: 'ASC' },
        });

        const participantPkIds = [...new Set(rows.map((pr) => pr.id).filter((id): id is string => Boolean(id)))];
        const attendanceRollupByParticipant =
            participantPkIds.length > 0
                ? await this.rollupAttendanceReviewsForParticipants(opportunityId, participantPkIds)
                : new Map<string, { sessions_total: number; sessions_pending_review: number }>();

        const attendancePreviewByParticipant =
            participantPkIds.length > 0
                ? await this.attendanceSessionsPreviewByParticipant(opportunityId, participantPkIds, 35)
                : new Map<string, Record<string, unknown>[]>();

        const participationByApplicationId = new Map<string, Participation>();
        const participationByStudentUserIdFirst = new Map<string, Participation>();
        for (const seat of rows) {
            const aid = (seat.applicationId || '').trim();
            if (aid && !participationByApplicationId.has(aid)) {
                participationByApplicationId.set(aid, seat);
            }
            const sid = seat.studentId?.trim();
            if (sid && !participationByStudentUserIdFirst.has(sid)) {
                participationByStudentUserIdFirst.set(sid, seat);
            }
        }

        const applications_roster = allApplications.map((a) => {
            const { participation_type, team_members } = this.facultyJoinApplicationTeamMembersForDisplay(a);
            let enrollment_tracking: Record<string, unknown> | null = null;

            const seatRow =
                participationByApplicationId.get(a.id)
                ?? (a.studentUserId ? participationByStudentUserIdFirst.get(a.studentUserId) : undefined);

            if (a.internalStatus === 'approved') {
                if (seatRow) {
                    const latestReport = seatRow.studentId
                        ? this.pickLatestReportForStudent(reports, seatRow.studentId)
                        : null;
                    const att = attendanceRollupByParticipant.get(seatRow.id) ?? {
                        sessions_total: 0,
                        sessions_pending_review: 0,
                    };
                    enrollment_tracking = {
                        participation_id: seatRow.id,
                        attendance_sessions_total: att.sessions_total,
                        attendance_sessions_pending_review: att.sessions_pending_review,
                        attendance_sessions_preview:
                            attendancePreviewByParticipant.get(seatRow.id) ?? [],
                        attendance_approver_type: seatRow.attendanceApproverType ?? null,
                        ...this.trackerImpactReportEnrollmentFields(latestReport),
                    };
                } else {
                    enrollment_tracking = {
                        enrollment_warning:
                            'Application marked approved — participation seat not matched (reload or reconcile).',
                        attendance_sessions_total: 0,
                        attendance_sessions_pending_review: 0,
                        attendance_sessions_preview: [],
                        ...this.trackerImpactReportEnrollmentFields(null),
                    };
                }
            }

            return {
                id: a.id,
                student_name: a.studentUser?.name ?? null,
                student_email: a.studentUser?.email ?? null,
                internal_status: a.internalStatus,
                application_status: this.toPublicApplicationStatus(a.internalStatus, seatRow),
                application_stage: this.applicationStage(a.internalStatus),
                join_stage_display: this.trackerJoinApplicationsStageLabel(a.internalStatus),
                participation_type,
                team_members,
                created_at: a.createdAt,
                enrollment_tracking,
            };
        });

        const execOrg =
            opp?.executing_organization && typeof opp.executing_organization === 'object'
                ? (opp.executing_organization as Record<string, unknown>)
                : null;
        const partnerOrg =
            opp?.partner_organization && typeof opp.partner_organization === 'object'
                ? (opp.partner_organization as Record<string, unknown>)
                : null;
        const supervision =
            opp?.supervision && typeof opp.supervision === 'object'
                ? (opp.supervision as Record<string, unknown>)
                : null;

        return {
            summary: {
                registered_teams: data.length,
                completed_reports: completedReports,
                reports_available: reportsAvailable,
                opportunity: opp
                    ? {
                          title: opp.title,
                          status: opp.status,
                          mode: opp.mode ?? null,
                          location: opp.location ?? null,
                          timeline: opp.timeline ?? null,
                          admin_approved: opp.admin_approved,
                          faculty_verification_status: opp.faculty_verification_status,
                          faculty_verified: opp.faculty_verified,
                          execution_verification_status: opp.execution_verification_status,
                          execution_verified: opp.execution_verified,
                          organization_id: opp.organizationId ?? null,
                          organization_name: opp.organization?.name ?? null,
                          executing_organization_name:
                              typeof execOrg?.name === 'string' && execOrg.name.trim()
                                  ? execOrg.name.trim()
                                  : typeof execOrg?.organization_name === 'string' && execOrg.organization_name.trim()
                                    ? execOrg.organization_name.trim()
                                    : null,
                          executing_organization_email:
                              typeof execOrg?.official_email === 'string' && execOrg.official_email.trim()
                                  ? execOrg.official_email.trim()
                                  : null,
                          partner_organization_name:
                              typeof partnerOrg?.organization_name === 'string' && partnerOrg.organization_name.trim()
                                  ? partnerOrg.organization_name.trim()
                                  : typeof partnerOrg?.name === 'string' && partnerOrg.name.trim()
                                    ? partnerOrg.name.trim()
                                    : typeof supervision?.partner_org_name === 'string' && supervision.partner_org_name.trim()
                                      ? supervision.partner_org_name.trim()
                                      : null,
                          partner_organization_email:
                              typeof partnerOrg?.official_email === 'string' && partnerOrg.official_email.trim()
                                  ? partnerOrg.official_email.trim()
                                  : typeof supervision?.partner_email === 'string' && supervision.partner_email.trim()
                                    ? supervision.partner_email.trim()
                                    : null,
                          faculty_supervisor_name:
                              typeof supervision?.supervisor_name === 'string' && supervision.supervisor_name.trim()
                                  ? supervision.supervisor_name.trim()
                                  : null,
                          faculty_supervisor_email:
                              typeof supervision?.contact === 'string' && supervision.contact.trim()
                                  ? supervision.contact.trim()
                                  : null,
                          /** Human hint: coarse approval lane for the listing (detail still in applications_by_internal_status). */
                          awaiting_partner_or_faculty: awaitingSide,
                      }
                    : null,
                applications_by_internal_status: appsByStatus,
                applications_pipeline_total_non_withdrawn: Object.values(appsByStatus).reduce((s, n) => s + n, 0),
                applications_roster,
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
        const decodedMemberId = decodeURIComponent((memberId || '').trim());
        if (decodedMemberId.startsWith('pending:')) {
            throw new BadRequestException(
                'This line is roster-only until seats are issued. Withdraw the student application instead of deleting a member seat.',
            );
        }
        if (!this.looksLikeUuidParam(decodedMemberId)) {
            throw new BadRequestException('Invalid member id for removal.');
        }
        await this.appRepo.manager.transaction(async (em) => {
            const member = await em.findOne(Participation, {
                where: {
                    id: decodedMemberId,
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

    async adminPatchOpportunityTeamMember(
        opportunityId: string,
        teamIdParam: string,
        memberId: string,
        dto: AdminPatchTeamMemberDto,
    ) {
        const decodedMemberId = decodeURIComponent((memberId || '').trim());

        const pendingSynth = this.parsePendingRosterSyntheticTeammateId(decodedMemberId);
        if (pendingSynth) {
            return this.adminPatchPendingSyntheticTeammate(
                opportunityId,
                teamIdParam,
                decodedMemberId,
                pendingSynth.applicationId,
                pendingSynth.emailNormalized,
                dto,
            );
        }

        if (!this.looksLikeUuidParam(decodedMemberId)) {
            throw new BadRequestException(
                'Invalid member identifier. Reload Teams & enrollments and retry from the current roster.',
            );
        }

        const participation = await this.participationRepo.findOne({
            where: {
                id: decodedMemberId,
                projectId: opportunityId,
                status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
            },
            relations: ['student'],
        });

        if (!participation) {
            // Application PK is uuid — never query with synthetic `pending:…` roster ids (avoids PG 500).
            if (this.looksLikeUuidParam(decodedMemberId)) {
                const pendingLead = await this.appRepo.findOne({
                    where: {
                        id: decodedMemberId,
                        opportunityId,
                        withdrawnAt: IsNull(),
                        internalStatus: In(PENDING_PIPELINE),
                    },
                    relations: ['studentUser'],
                });
                if (pendingLead) {
                    return this.adminPatchPendingApplicationLead(pendingLead, teamIdParam, dto, decodedMemberId);
                }
            }

            throw new NotFoundException('Team member enrollment not found for this opportunity');
        }

        const expectedGroupId = this.participationListingGroupId(participation);
        const paramNorm = decodeURIComponent(teamIdParam || '').trim();
        if (paramNorm !== expectedGroupId) {
            throw new BadRequestException(
                `Team grouping mismatch (${paramNorm}). Refresh the roster and retry from the newest team id.`,
            );
        }

        if (dto.cnic?.trim()) {
            const normalizedCnicDigits = dto.cnic.replace(/\D/g, '');
            const hash = this.engagementService.getCnicHashForNormalizedDigits(normalizedCnicDigits);
            const conflict = await this.participationRepo.findOne({
                where: { projectId: opportunityId, cnicHash: hash },
            });
            if (conflict && conflict.id !== participation.id) {
                throw new BadRequestException(
                    'Another enrollment on this project already uses this CNIC. Withdraw or correct that seat first.',
                );
            }
        }

        const syncLinkedUserProfile = dto.sync_linked_user_profile !== false;

        if (dto.full_name?.trim()) {
            participation.fullName = dto.full_name.trim();
            if (syncLinkedUserProfile && participation.studentId) {
                await this.usersService.update(participation.studentId, { name: dto.full_name.trim() });
            }
        }

        if (dto.mobile !== undefined && dto.mobile.trim().length >= 6) {
            participation.mobile = dto.mobile.trim();
            if (syncLinkedUserProfile && participation.studentId) {
                const raw = dto.mobile.trim();
                if (raw.startsWith('+')) {
                    await this.usersService.update(participation.studentId, { phone: raw, countryCode: null });
                } else {
                    await this.usersService.update(participation.studentId, { phone: raw });
                }
            }
        }

        if (dto.cnic?.trim()) {
            this.engagementService.applyNormalizedCnicToParticipation(participation, dto.cnic);
            const digitsUser = dto.cnic.replace(/\D/g, '');
            if (syncLinkedUserProfile && participation.studentId && digitsUser.length === 13) {
                await this.usersService.update(participation.studentId, { cnic: digitsUser });
            }
        }

        if (dto.university_id !== undefined) {
            const v = dto.university_id.trim();
            participation.universityId = v || null;
        }
        if (dto.university_name?.trim()) {
            participation.universityName = dto.university_name.trim();
            if (syncLinkedUserProfile && participation.studentId) {
                await this.usersService.update(participation.studentId, {
                    university: dto.university_name.trim(),
                });
            }
        }
        if (dto.academic_program?.trim()) {
            participation.academicProgram = dto.academic_program.trim();
            if (syncLinkedUserProfile && participation.studentId) {
                await this.usersService.update(participation.studentId, { major: dto.academic_program.trim() });
            }
        }
        if (dto.department?.trim()) {
            participation.department = dto.department.trim();
            if (syncLinkedUserProfile && participation.studentId) {
                await this.usersService.update(participation.studentId, {
                    department: dto.department.trim(),
                });
            }
        }
        if (dto.year_of_study) {
            participation.yearOfStudy = dto.year_of_study;
        }
        if (dto.academic_integration_type) {
            participation.academicIntegrationType = dto.academic_integration_type;
        }

        await this.participationRepo.save(participation);

        const refreshed = await this.participationRepo.findOne({
            where: { id: participation.id },
            relations: ['student'],
        });
        const p = refreshed ?? participation;

        let reportStatusRet: 'not_started' | 'in_progress' | 'completed' = 'not_started';
        if (p.studentId) {
            const reports = await this.findReportsForOpportunityAndStudents(opportunityId, [
                p.studentId,
            ]);
            const latest = this.pickLatestReportForStudent(reports, p.studentId);
            reportStatusRet = this.toTeamReportStatus(latest?.status);
        }

        const snap = this.participationMobileAndCnicSnapshot(p);
        const mode = String(p.participationMode ?? '')
            .trim()
            .toLowerCase();
        const isIndividualSeat = !(p.teamId || '').trim().length || mode === 'individual';

        const memberPayload: Record<string, unknown> = {
            id: p.id,
            supports_admin_patch: true,
            name: p.student?.name ?? p.fullName ?? null,
            email: p.student?.email ?? p.email ?? null,
            role: isIndividualSeat || p.isTeamLead ? 'lead' : 'member',
            report_status: reportStatusRet,
            report_available: reportStatusRet !== 'not_started',
            phone_number: snap.phone_number,
            cnic_display: snap.cnic_display,
            ...this.academicSnapshot(p),
        };

        return {
            success: true,
            data: { member: memberPayload },
        };
    }

    /**
     * Enrollments that still need student report work before submitted / verified / paid (etc.).
     * Uses active participations (team members + solo) so listing is non-empty even when only the
     * team lead row exists in opportunity_applications; merges approved applications when present.
     */
    async adminListIncompleteReportApplicants(opportunityId: string) {
        const participations = await this.participationRepo.find({
            where: {
                projectId: opportunityId,
                studentId: Not(IsNull()),
                status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
            },
            relations: ['student'],
            order: { createdAt: 'ASC' },
        });

        type Row = {
            applicationId: string | null;
            student_name: string | null;
            student_email: string | null;
        };
        const byStudent = new Map<string, Row>();

        for (const p of participations) {
            if (!p.studentId) continue;
            const prev = byStudent.get(p.studentId);
            const next: Row = {
                applicationId: p.applicationId ?? null,
                student_name: p.student?.name ?? p.fullName ?? null,
                student_email: p.student?.email ?? p.email ?? null,
            };
            if (!prev) {
                byStudent.set(p.studentId, next);
            } else if (!prev.applicationId && next.applicationId) {
                byStudent.set(p.studentId, next);
            }
        }

        const apps = await this.appRepo.find({
            where: {
                opportunityId,
                internalStatus: 'approved',
                withdrawnAt: IsNull(),
            },
            relations: ['studentUser'],
            order: { createdAt: 'DESC' },
        });
        for (const a of apps) {
            const existing = byStudent.get(a.studentUserId);
            if (existing) {
                if (!existing.applicationId) {
                    existing.applicationId = a.id;
                }
            } else {
                byStudent.set(a.studentUserId, {
                    applicationId: a.id,
                    student_name: a.studentUser?.name ?? null,
                    student_email: a.studentUser?.email ?? null,
                });
            }
        }

        if (!byStudent.size) {
            return { data: [] as Array<Record<string, unknown>> };
        }

        const studentIds = [...byStudent.keys()];
        const reports = await this.findReportsForOpportunityAndStudents(opportunityId, studentIds);

        const data: Array<Record<string, unknown>> = [];
        for (const [studentUserId, row] of byStudent) {
            const rep = this.pickLatestReportForStudent(reports, studentUserId);
            if (rep && REPORT_STATUSES_EXCLUDED_FROM_INCOMPLETE_LIST.includes(rep.status)) continue;
            data.push({
                application_id: row.applicationId,
                student_name: row.student_name,
                student_email: row.student_email,
                report_status: rep ? this.mapReportStatusForAdminList(rep.status) : 'not_started',
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

    private static readonly LIVE_LISTING_STATUSES = ['active', 'live', 'open', 'recruiting'];

    /** Student owns a listing that has passed admin review and is publicly live. */
    isCreatorOwnLiveListing(
        opportunity: Pick<Opportunity, 'creatorId' | 'admin_approved' | 'workflowStage' | 'status'>,
        studentUserId: string,
    ): boolean {
        if (!opportunity.creatorId || opportunity.creatorId !== studentUserId) return false;
        if (!opportunity.admin_approved) return false;
        if (opportunity.workflowStage === WORKFLOW_STAGE.LIVE) return true;
        const st = (opportunity.status || '').toLowerCase();
        return OpportunityApplicationsService.LIVE_LISTING_STATUSES.includes(st);
    }

    /**
     * Join / participation overlay for student UI (browse, project detail, My Projects).
     * Listing approval (`opportunities.admin_approved` + live) is separate from join pipeline rows.
     */
    async resolveStudentJoinOverlay(
        studentUserId: string,
        opportunity: Pick<Opportunity, 'id' | 'creatorId' | 'admin_approved' | 'workflowStage' | 'status'>,
        participation?: Participation | null,
    ): Promise<{
        app: OpportunityApplication | null;
        applicationStatus: string | null;
        applicationStage: 'faculty' | 'partner' | 'admin' | null;
        applicationInternalStatus: string | null;
        hasApplied: boolean;
    }> {
        const rows = await this.appRepo.find({
            where: { studentUserId, opportunityId: opportunity.id, withdrawnAt: IsNull() },
            order: { createdAt: 'DESC' },
        });

        const ownLive = this.isCreatorOwnLiveListing(opportunity, studentUserId);

        if (ownLive) {
            const pending = rows.find((r) => PENDING_PIPELINE.includes(r.internalStatus));
            if (pending) {
                return {
                    app: pending,
                    applicationStatus: this.toPublicApplicationStatus(pending.internalStatus, participation),
                    applicationStage: this.applicationStage(pending.internalStatus),
                    applicationInternalStatus: pending.internalStatus,
                    hasApplied: true,
                };
            }
            const approvedApp = rows.find((r) => r.internalStatus === 'approved');
            return {
                app: approvedApp ?? rows[0] ?? null,
                applicationStatus: this.toPublicApplicationStatus('approved', participation),
                applicationStage: approvedApp ? this.applicationStage(approvedApp.internalStatus) : null,
                applicationInternalStatus: approvedApp?.internalStatus ?? null,
                hasApplied: !!(rows.length || participation),
            };
        }

        const app = rows[0] ?? null;
        if (app) {
            return {
                app,
                applicationStatus: this.toPublicApplicationStatus(app.internalStatus, participation),
                applicationStage: this.applicationStage(app.internalStatus),
                applicationInternalStatus: app.internalStatus,
                hasApplied: true,
            };
        }

        if (participation) {
            const st = (participation.status || '').toLowerCase();
            let applicationStatus: string | null = null;
            if (['pending', 'pending_payment_approval', 'pending_ciel_approval', 'pending_faculty_approval'].includes(st)) {
                applicationStatus = 'pending_approval';
            } else if (st === 'verified') {
                applicationStatus = 'verified';
            } else if (['approved', 'accepted', 'paid', 'finalized'].includes(st)) {
                applicationStatus = 'approved';
            } else if (['rejected', 'not_approved', 'denied', 'declined'].includes(st)) {
                applicationStatus = 'rejected';
            } else if (st === 'withdrawn') {
                applicationStatus = 'withdrawn';
            } else if (st) {
                applicationStatus = st;
            }
            return {
                app: null,
                applicationStatus,
                applicationStage: null,
                applicationInternalStatus: null,
                hasApplied: true,
            };
        }

        return {
            app: null,
            applicationStatus: null,
            applicationStage: null,
            applicationInternalStatus: null,
            hasApplied: false,
        };
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
        opportunitiesById?: Map<string, Pick<Opportunity, 'id' | 'creatorId' | 'admin_approved' | 'workflowStage' | 'status'>>,
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
            const opp = opportunitiesById?.get(oppId);
            let current = sorted[0];
            if (opp && this.isCreatorOwnLiveListing(opp, studentUserId)) {
                current =
                    sorted.find((r) => r.internalStatus === 'approved') ??
                    sorted.find((r) => PENDING_PIPELINE.includes(r.internalStatus)) ??
                    sorted[0];
            }
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

    /**
     * People represented by pending (non‑withdrawn) applications on this opportunity.
     * Team applies count lead + teammate emails in `apply_payload.team_members`; individual applies count as 1.
     * Approved applications are omitted — those seats should appear under participations instead.
     */
    async countSeatsInFlight(opportunityId: string): Promise<number> {
        const apps = await this.appRepo.find({
            where: {
                opportunityId,
                withdrawnAt: IsNull(),
                internalStatus: In(PENDING_PIPELINE),
            },
            relations: ['studentUser'],
        });

        let total = 0;
        for (const app of apps) {
            const teamSummary = this.adminBrowseApplicationTeamSummaryForQueue(app);
            if (teamSummary && teamSummary.team_member_count >= 1) {
                total += teamSummary.team_member_count;
            } else {
                total += 1;
            }
        }
        return total;
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
            const saved = await this.appRepo.save(row);
            return await this.autoCompleteFacultyStepForNewApplication(saved, primary);
        } catch (e: any) {
            if (e?.code === '23505') {
                throw new BadRequestException('Already applied to this opportunity');
            }
            throw e;
        }
    }

    /**
     * Join/apply pipeline auto-advances past faculty (individual and team): same next step as {@link facultyApprove}
     * without requiring a manual faculty click.
     */
    private async autoCompleteFacultyStepForNewApplication(
        saved: OpportunityApplication,
        primaryEmail: string | null,
    ): Promise<OpportunityApplication> {
        if (saved.internalStatus !== 'pending_faculty') {
            return saved;
        }
        const decidedBy = primaryEmail ? await this.resolveFacultyUserIdByPrimaryEmail(primaryEmail) : null;
        saved.internalStatus = 'pending_admin';
        saved.facultyDecidedAt = new Date();
        saved.facultyDecidedBy = decidedBy;
        saved.facultyComment = null;
        return this.appRepo.save(saved);
    }

    /** Primary supervisor on the application or official email on the opportunity listing. */
    private facultyEmailMatchesApplicationGate(
        facultyEmail: string,
        app: OpportunityApplication,
    ): boolean {
        const email = this.normalizeEmail(facultyEmail);
        if (!email) {
            return false;
        }
        if (this.normalizeEmail(app.primaryFacultyEmail) === email) {
            return true;
        }
        const opp = app.opportunity;
        const sup =
            opp?.supervision && typeof opp.supervision === 'object'
                ? (opp.supervision as Record<string, unknown>)
                : null;
        const listingContact =
            sup && typeof sup.contact === 'string' ? this.normalizeEmail(sup.contact) : '';
        return listingContact !== '' && listingContact === email;
    }

    private async resolveFacultyUserIdByPrimaryEmail(email: string): Promise<string | null> {
        const e = this.normalizeEmail(email);
        if (!e) {
            return null;
        }
        const fu = await this.userRepo
            .createQueryBuilder('u')
            .where('LOWER(TRIM(u.email)) = :em', { em: e })
            .andWhere('u.role = :r', { r: UserRole.FACULTY })
            .getOne();
        return fu?.id ?? null;
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
     * Browse/join: faculty dashboard uses opportunity id; pick an application this faculty may approve
     * (same rules as {@link facultyApprove}: primary supervisor email or university delegate).
     */
    async findActionablePendingFacultyApplicationForDashboard(
        opportunityId: string,
        facultyEmail: string,
        facultyUserId: string,
    ): Promise<OpportunityApplication | null> {
        const email = this.normalizeEmail(facultyEmail);
        const apps = await this.appRepo.find({
            where: {
                opportunityId,
                withdrawnAt: IsNull(),
                internalStatus: 'pending_faculty',
            },
            order: { createdAt: 'DESC' },
            relations: ['studentUser', 'opportunity'],
        });
        for (const app of apps) {
            if (this.facultyEmailMatchesApplicationGate(facultyEmail, app)) {
                return app;
            }
            const okDelegated =
                await this.facultyUniversityScopeService.canFacultyReviewApplicationAsUniversityDelegate(
                    facultyUserId,
                    app.studentUser,
                );
            if (okDelegated) {
                return app;
            }
        }
        return null;
    }

    async facultyList(
        facultyEmail: string,
        facultyUserId: string,
        status: 'pending' | 'history' = 'pending',
    ) {
        const email = this.normalizeEmail(facultyEmail);
        const assignment = await this.facultyUniversityScopeService.getAssignmentForFaculty(facultyUserId);
        const orgNorm = assignment?.universityOrganization?.name
            ? this.facultyUniversityScopeService.normalizeOrgName(assignment.universityOrganization.name)
            : null;

        const qb = this.appRepo
            .createQueryBuilder('a')
            .leftJoinAndSelect('a.opportunity', 'o')
            .leftJoinAndSelect('a.studentUser', 's')
            .where('a.withdrawnAt IS NULL')
            .andWhere(
                new Brackets((outer) => {
                    outer.where('lower(a.primaryFacultyEmail) = :email', { email });
                    outer.orWhere(
                        "LOWER(TRIM(COALESCE(o.supervision->>'contact', ''))) = :email",
                        { email },
                    );
                    if (orgNorm) {
                        outer.orWhere(
                            new Brackets((inner) => {
                                inner
                                    .where('s.role = :studentRole', { studentRole: UserRole.STUDENT })
                                    .andWhere(
                                        '(LOWER(TRIM(COALESCE(s.university, \'\'))) = :orgNorm OR LOWER(TRIM(COALESCE(s.institution, \'\'))) = :orgNorm)',
                                        { orgNorm },
                                    );
                            }),
                        );
                    }
                }),
            );

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
            data: rows.map((a) => {
                const { participation_type, team_members } = this.facultyJoinApplicationTeamMembersForDisplay(a);
                return {
                    id: a.id,
                    opportunity_id: a.opportunityId,
                    opportunity_title: a.opportunity?.title,
                    student_name: a.studentUser?.name,
                    student_email: a.studentUser?.email,
                    participation_type,
                    team_members,
                    internal_status: a.internalStatus,
                    application_status: this.toPublicApplicationStatus(a.internalStatus),
                    application_stage: this.applicationStage(a.internalStatus),
                    created_at: a.createdAt,
                };
            }),
        };
    }

    async facultyApprove(id: string, facultyEmail: string, facultyUserId: string) {
        const email = this.normalizeEmail(facultyEmail);
        const app = await this.appRepo.findOne({
            where: { id, withdrawnAt: IsNull() },
            relations: ['opportunity', 'studentUser'],
        });
        if (!app) throw new NotFoundException('Application not found');
        const okGate = this.facultyEmailMatchesApplicationGate(facultyEmail, app);
        const okDelegated =
            okGate ||
            (await this.facultyUniversityScopeService.canFacultyReviewApplicationAsUniversityDelegate(
                facultyUserId,
                app.studentUser,
            ));
        if (!okDelegated) {
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
        const app = await this.appRepo.findOne({
            where: { id, withdrawnAt: IsNull() },
            relations: ['studentUser', 'opportunity'],
        });
        if (!app) throw new NotFoundException('Application not found');
        const okGate = this.facultyEmailMatchesApplicationGate(facultyEmail, app);
        const okDelegated =
            okGate ||
            (await this.facultyUniversityScopeService.canFacultyReviewApplicationAsUniversityDelegate(
                facultyUserId,
                app.studentUser,
            ));
        if (!okDelegated) {
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
            data: rows.map((a) => {
                const { participation_type, team_members } = this.facultyJoinApplicationTeamMembersForDisplay(a);
                return {
                    id: a.id,
                    opportunity_id: a.opportunityId,
                    opportunity_title: a.opportunity?.title,
                    student_name: a.studentUser?.name,
                    student_email: a.studentUser?.email,
                    participation_type,
                    team_members,
                    internal_status: a.internalStatus,
                    application_status: this.toPublicApplicationStatus(a.internalStatus),
                    application_stage: this.applicationStage(a.internalStatus),
                    created_at: a.createdAt,
                };
            }),
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
            data: rows.map((a) => {
                const { participation_type, team_members } = this.facultyJoinApplicationTeamMembersForDisplay(a);
                return {
                    id: a.id,
                    opportunity_id: a.opportunityId,
                    opportunity_title: a.opportunity?.title,
                    organization: a.opportunity?.organization?.name,
                    student_name: a.studentUser?.name,
                    student_email: a.studentUser?.email,
                    primary_faculty_email: a.primaryFacultyEmail,
                    secondary_faculty_email: a.secondaryFacultyEmail,
                    participation_type,
                    team_members,
                    apply_payload: a.applyPayload,
                    created_at: a.createdAt,
                    internal_status: a.internalStatus,
                    application_status: this.toPublicApplicationStatus(a.internalStatus),
                };
            }),
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
        const rawTeamMembers = Array.isArray(payload['team_members']) ? (payload['team_members'] as any[]) : [];
        const leadEmailNorm = this.normalizeEmail(user.email);
        const teamMembersUnique: typeof rawTeamMembers = [];
        const seenMemberEmails = new Set<string>();
        for (const m of rawTeamMembers) {
            const em = typeof m?.email === 'string' ? this.normalizeEmail(m.email) : '';
            if (!em) continue;
            if (em === leadEmailNorm) continue;
            if (seenMemberEmails.has(em)) continue;
            seenMemberEmails.add(em);
            teamMembersUnique.push(m);
        }
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

        if (participationType === 'team' && teamMembersUnique.length > 0) {
            for (const m of teamMembersUnique) {
                const memberUser = await this.usersService.findByEmail(m.email);
                if (memberUser?.id && memberUser.id === app.studentUserId) {
                    continue;
                }
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

    /**
     * Lowercased emails from join `apply_payload.team_members` (not the lead). Used to reconcile My Projects
     * roster when participation rows omit shared `applicationId` / `teamId`.
     */
    async findApplyPayloadTeamMemberEmails(applicationId: string): Promise<string[]> {
        const app = await this.appRepo.findOne({
            where: { id: applicationId, withdrawnAt: IsNull() },
        });
        if (!app?.applyPayload || typeof app.applyPayload !== 'object') return [];
        const payload = app.applyPayload as Record<string, unknown>;
        const raw = payload['team_members'];
        if (!Array.isArray(raw)) return [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const m of raw) {
            if (!m || typeof m !== 'object') continue;
            const em = String((m as Record<string, unknown>).email ?? '')
                .trim()
                .toLowerCase();
            if (!em || seen.has(em)) continue;
            seen.add(em);
            out.push(em);
        }
        return out;
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

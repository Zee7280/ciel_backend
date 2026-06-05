import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { StudentReport } from './entities/student-report.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { S3Service } from '../common/s3.service';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import * as path from 'path';

import { User } from '../users/entities/user.entity';
import { MailService } from '../mail/mail.service';

import { EngagementService } from '../engagement/engagement.service';
import {
    findCanonicalTeamLeadParticipation,
    findCanonicalTeamLeadStudentId,
} from '../engagement/team-lead-canonical.util';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { formatCertificateVerificationCode } from './certificate-verification-code.util';
import { ReportPartnerApprovalSettingsService } from './report-partner-approval-settings.service';
import { isReportPartnerStepSatisfied } from './report-partner-approval.util';

@Injectable()
export class StudentReportsService {
    constructor(
        @InjectRepository(Opportunity)
        private readonly opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(Participation)
        private readonly participantRepository: Repository<Participation>,
        @InjectRepository(StudentReport)
        private studentReportsRepository: Repository<StudentReport>,
        @InjectRepository(AttendanceLog)
        private readonly attendanceLogsRepository: Repository<AttendanceLog>,
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
        @InjectRepository(Payment)
        private readonly paymentRepository: Repository<Payment>,
        private readonly s3Service: S3Service,
        private readonly engagementService: EngagementService,
        private readonly mailService: MailService,
        private readonly configService: ConfigService,
        private readonly reportPartnerApprovalSettings: ReportPartnerApprovalSettingsService,
    ) { }

    private hasMeaningfulObjectValue(value: any): boolean {
        if (!value || typeof value !== 'object') return false;
        return Object.values(value).some((v) => {
            if (Array.isArray(v)) return v.length > 0;
            if (v && typeof v === 'object') return this.hasMeaningfulObjectValue(v);
            return v !== null && v !== undefined && String(v).trim() !== '';
        });
    }

    private getPublicReportApprovalContext(report: StudentReport) {
        const partners = Array.isArray(report.section7?.partners) ? report.section7.partners : [];
        const hasSectionPartner =
            report.section7?.has_partners === 'yes' ||
            report.section8?.partner_verification === true ||
            partners.some((partner: any) => this.hasMeaningfulObjectValue(partner));
        const hasOpportunityPartner =
            Boolean(report.opportunity?.requiresPartnerApproval) ||
            this.hasMeaningfulObjectValue(report.opportunity?.partner_organization);
        const hasNgo = partners.some((partner: any) => {
            const type = String(partner?.type || partner?.name || '').toLowerCase();
            return type.includes('ngo') || type.includes('non-government');
        });
        const hasPartner = Boolean(hasSectionPartner || hasOpportunityPartner || report.opportunity?.requiresPartnerApproval);
        const requiresPartnerApproval = this.reportPartnerApprovalSettings.reportRequiresPartnerApprovalSync(
            report,
            (value) => this.hasMeaningfulObjectValue(value),
        );

        return {
            has_partner: hasPartner,
            has_ngo: hasNgo,
            requires_partner_approval: requiresPartnerApproval,
            partner_required: requiresPartnerApproval,
        };
    }

    /**
     * Single value for QR: absolute public page URL when FRONTEND_URL/APP_URL is set,
     * otherwise path-only `/impact/verify/{slug}` — resolve on the client with `new URL(impact_verify_url, NEXT_PUBLIC_APP_URL)`.
     */
    private buildImpactVerifyUrl(slug: string | null | undefined): string | null {
        const s = slug?.trim();
        if (!s) return null;
        let pathSeg = (this.configService.get<string>('IMPACT_VERIFY_PATH') || '/impact/verify').trim();
        if (!pathSeg.startsWith('/')) pathSeg = `/${pathSeg}`;
        pathSeg = pathSeg.replace(/\/+$/, '');
        const base = (this.configService.get<string>('FRONTEND_URL') || this.configService.get<string>('APP_URL') || '')
            .trim()
            .replace(/\/+$/, '');
        const pathAndSlug = `${pathSeg}/${encodeURIComponent(s)}`;
        return base ? `${base}${pathAndSlug}` : pathAndSlug;
    }

    /** QR URL + DB slug + display code for certificates (single source of truth). */
    private reportVerificationPayload(report: StudentReport) {
        const slug = report.verificationPublicSlug?.trim() || null;
        return {
            verification_public_slug: slug,
            certificate_verification_code: formatCertificateVerificationCode(slug),
            impact_verify_url: this.buildImpactVerifyUrl(slug),
        };
    }

    /** Aligns legacy DB values with student UI / frontend lifecycle names. */
    private toPublicReportStatus(raw: string | null | undefined): string {
        if (raw === 'payment_pending') return 'pending_payment';
        if (raw === 'continue') return 'draft';
        return raw ?? 'draft';
    }

    /** Statuses where draft saves must not rewind lifecycle (rejected/revision are editable). */
    private lockedReportStatusesForStudentWrite(): Set<string> {
        return new Set([
            'submitted',
            'partner_verified',
            'payment_pending',
            'payment_under_review',
            'verified',
            'paid',
        ]);
    }

    private isReportRejectedForRevision(report: Pick<StudentReport, 'status' | 'admin_status' | 'partner_status'>): boolean {
        const st = String(report.status || '').toLowerCase();
        const adm = String(report.admin_status || '').toLowerCase();
        const partner = String(report.partner_status || '').toLowerCase();
        return (
            st === 'rejected' ||
            st === 'revision' ||
            adm === 'rejected' ||
            partner === 'rejected'
        );
    }

    /** Student may edit when in draft/revision or when an approver returned the report for fixes. */
    private isReportEditableForStudent(report: Pick<StudentReport, 'status' | 'admin_status' | 'partner_status'>): boolean {
        if (this.isReportRejectedForRevision(report)) return true;
        const st = String(report.status || '').toLowerCase();
        return st === 'draft' || st === 'continue' || st === '';
    }

    /**
     * Legacy rows may have admin_status=rejected while status stayed submitted; expose revision to the UI.
     */
    private resolveStudentFacingReportStatus(
        rawReportStatus: string | null | undefined,
        adminStatus?: string | null,
        partnerStatus?: string | null,
    ): string {
        const raw = String(rawReportStatus || '').toLowerCase();
        const adm = String(adminStatus || '').toLowerCase();
        const partner = String(partnerStatus || '').toLowerCase();
        if (raw === 'rejected') return 'revision';
        if ((adm === 'rejected' || partner === 'rejected') && (raw === 'submitted' || raw === 'partner_verified')) {
            return 'revision';
        }
        if (raw === 'payment_pending') return 'pending_payment';
        if (raw === 'submitted') return 'pending_payment';
        return this.toPublicReportStatus(rawReportStatus);
    }

    /** Reporting fee approved (manual payment row or terminal paid statuses). */
    private async isReportFeeClearedForApprovals(report: StudentReport): Promise<boolean> {
        const st = String(report.status || '').toLowerCase();
        if (['paid', 'partner_verified', 'verified'].includes(st)) return true;
        const latest = await this.findLatestManualPayment(
            report.studentId,
            report.opportunityId || report.project_id,
        );
        return latest?.status === PaymentStatus.APPROVED;
    }

    private async assertReportFeeClearedBeforeApproval(report: StudentReport): Promise<void> {
        if (await this.isReportFeeClearedForApprovals(report)) return;
        throw new BadRequestException(
            'Reporting fee must be submitted and approved before partner or admin can review this report.',
        );
    }

    /** After final submit: payment is required before any partner/admin approval. */
    private applyStatusAfterStudentSubmit(report: StudentReport): void {
        report.status = 'payment_pending';
    }

    private async syncReportProjectKeys(report: StudentReport): Promise<void> {
        const oppId = report.opportunityId?.trim() || '';
        const projId = report.project_id?.trim() || '';

        if (oppId && !projId) {
            report.project_id = oppId;
            return;
        }

        if (!oppId && projId && this.looksLikeUuid(projId)) {
            const opp = await this.opportunitiesRepository.findOne({ where: { id: projId } });
            if (opp) {
                report.opportunityId = opp.id;
                report.project_id = opp.id;
            }
            return;
        }

        if (oppId && projId && oppId !== projId) {
            report.project_id = oppId;
        }
    }

    private resolveLinkedOpportunity(
        report: StudentReport,
        opportunityByProjectId?: Map<string, Opportunity>,
    ): Opportunity | null | undefined {
        if (report.opportunity) return report.opportunity;
        const projectKey = report.project_id?.trim();
        if (!projectKey || !opportunityByProjectId) return report.opportunity;
        return opportunityByProjectId.get(projectKey) ?? report.opportunity;
    }

    private async loadOpportunitiesForReports(reports: StudentReport[]): Promise<Map<string, Opportunity>> {
        const ids = new Set<string>();
        for (const report of reports) {
            if (report.opportunity) continue;
            const projectKey = report.project_id?.trim();
            if (projectKey && this.looksLikeUuid(projectKey)) {
                ids.add(projectKey);
            }
        }
        if (ids.size === 0) return new Map();

        const opportunities = await this.opportunitiesRepository.find({
            where: { id: In([...ids]) },
            relations: ['organization'],
        });
        return new Map(opportunities.map((opp) => [opp.id, opp]));
    }

    private mapReportListing(report: StudentReport, opportunityByProjectId?: Map<string, Opportunity>) {
        const section3 = report.section3 as any;
        const section4 = report.section4 as any;
        const sdgs = section3?.sdgs ?? section3?.secondary_sdgs ?? [];
        const opportunity = this.resolveLinkedOpportunity(report, opportunityByProjectId);

        return {
            id: report.id,
            student_name: report.student?.name || 'Unknown',
            student_email: report.student?.email || 'Unknown',
            project_title: opportunity?.title || report.project_id,
            organization_id: opportunity?.organizationId ?? opportunity?.organization?.id ?? null,
            organization_name: opportunity?.organization?.name || 'N/A',
            status: this.toPublicReportStatus(report.status),
            partner_status: report.partner_status,
            admin_status: report.admin_status,
            submission_date: report.submission_date,
            submitted_at: report.reportSubmittedAt ?? report.submission_date ?? report.createdAt,
            report_submitted_at: report.reportSubmittedAt,
            partner_approved_at: report.partnerApprovedAt,
            admin_approved_at: report.adminApprovedAt,
            section1: {
                metrics: {
                    total_verified_hours: report.section1?.metrics?.total_verified_hours ?? 0,
                },
            },
            section3: {
                sdgs,
            },
            section4: {
                project_summary: {
                    distinct_total_beneficiaries:
                        section4?.project_summary?.distinct_total_beneficiaries ??
                        section4?.distinct_total_beneficiaries ??
                        section4?.total_beneficiaries ??
                        null,
                },
            },
            sdgs,
            cii_score: this.resolveCiiScoreFromPayload(
                (report.section11 as Record<string, unknown> | null | undefined) ?? null,
            ),
            created_at: report.createdAt,
        };
    }

    private buildStudentReportFeedback(report: StudentReport): string | null {
        const direct = report.admin_feedback?.trim();
        if (direct) return direct;
        const section11 = report.section11 as Record<string, unknown> | null | undefined;
        const meta = section11?.audit_meta;
        if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
            const studentFeedback = (meta as { student_feedback?: unknown }).student_feedback;
            if (typeof studentFeedback === 'string' && studentFeedback.trim()) {
                return studentFeedback.trim();
            }
        }
        return null;
    }

    private isPartnerReviewerRole(role: string | null | undefined): boolean {
        return ['partner', 'ngo', 'corporate', 'organization_admin'].includes(role ?? '');
    }

    private looksLikeUuid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
    }

    /** Team projects store one report row under the canonical team lead's `studentId`. */
    private async resolveTeamReportOwnerStudentId(
        submitterId: string,
        opportunityId: string,
    ): Promise<string> {
        const mine = await this.participantRepository.findOne({
            where: { studentId: submitterId, projectId: opportunityId.trim() },
        });
        if (!mine || mine.participationMode !== 'team') {
            return submitterId;
        }
        const canonicalId = await findCanonicalTeamLeadStudentId(this.participantRepository, opportunityId, {
            teamId: mine.teamId,
            applicationId: mine.applicationId,
        });
        return canonicalId ?? submitterId;
    }

    /** Team projects: teammates may read the canonical report row owned by `team lead` (`studentId`). */
    private async participantMayAccessReport(viewerStudentId: string, report: StudentReport): Promise<boolean> {
        if (!viewerStudentId || !report.studentId) {
            return false;
        }
        if (report.studentId === viewerStudentId) {
            return true;
        }
        const projKey = report.opportunityId || report.project_id;
        if (!projKey || !this.looksLikeUuid(String(projKey).trim())) {
            return false;
        }
        const mine = await this.participantRepository.findOne({
            where: { studentId: viewerStudentId, projectId: String(projKey).trim() },
        });
        if (!mine || mine.participationMode !== 'team') {
            return false;
        }
        const scope = { teamId: mine.teamId, applicationId: mine.applicationId };
        const leadId = await findCanonicalTeamLeadStudentId(
            this.participantRepository,
            String(projKey).trim(),
            scope,
        );
        return Boolean(leadId && leadId === report.studentId);
    }

    /**
     * One canonical student_reports row per team project: readers who are teammates resolve the team lead row.
     * Attendance/logs are still keyed to `viewerStudentId`.
     */
    private async resolveReportRecordForParticipantRead(
        viewerStudentId: string,
        projectKey: string,
    ): Promise<{ report: StudentReport | null; attendanceStudentId: string }> {
        const key = projectKey.trim();
        if (!this.looksLikeUuid(key)) {
            return { report: null, attendanceStudentId: viewerStudentId };
        }

        const mine = await this.participantRepository.findOne({
            where: { studentId: viewerStudentId, projectId: key },
        });

        const fetchLatestRow = async (sid: string) =>
            this.studentReportsRepository.findOne({
                where: [
                    { studentId: sid, opportunityId: key },
                    { studentId: sid, project_id: key },
                ],
                relations: ['student', 'opportunity', 'opportunity.organization'],
                order: { createdAt: 'DESC' },
            });

        const isTeam = mine?.participationMode === 'team';
        if (isTeam && mine) {
            const leadId = await findCanonicalTeamLeadStudentId(this.participantRepository, key, {
                teamId: mine.teamId,
                applicationId: mine.applicationId,
            });
            if (leadId && leadId !== viewerStudentId) {
                const leaderReport = await fetchLatestRow(leadId);
                if (leaderReport) {
                    return { report: leaderReport, attendanceStudentId: viewerStudentId };
                }
            }
        }

        const own = await fetchLatestRow(viewerStudentId);
        return { report: own, attendanceStudentId: viewerStudentId };
    }

    private reportProjectKey(report: StudentReport): string {
        return (report.opportunityId || report.project_id || '').trim();
    }

    private participationScopeKey(projectId: string, participation: Participation): string {
        return `${projectId}|${(participation.teamId || '').trim()}|${(participation.applicationId || '').trim()}`;
    }

    /**
     * Admin/partner queues: one visible row per team project (canonical team lead report).
     * Hides teammate orphan rows and duplicate non-canonical lead reports until DB cleanup.
     */
    private async filterReportsForAdminPartnerQueue(reports: StudentReport[]): Promise<StudentReport[]> {
        if (reports.length === 0) {
            return reports;
        }

        const projectKeys = new Set<string>();
        const studentIds = new Set<string>();
        for (const report of reports) {
            studentIds.add(report.studentId);
            const key = this.reportProjectKey(report);
            if (this.looksLikeUuid(key)) {
                projectKeys.add(key);
            }
        }

        if (projectKeys.size === 0) {
            return reports;
        }

        const participations = await this.participantRepository.find({
            where: {
                studentId: In([...studentIds]),
                projectId: In([...projectKeys]),
            },
        });

        const participationByStudentProject = new Map<string, Participation>();
        for (const row of participations) {
            participationByStudentProject.set(`${row.studentId}:${row.projectId}`, row);
        }

        const canonicalLeadByScope = new Map<string, string | null>();
        const filtered: StudentReport[] = [];

        for (const report of reports) {
            const projectKey = this.reportProjectKey(report);
            if (!this.looksLikeUuid(projectKey)) {
                filtered.push(report);
                continue;
            }

            const participation = participationByStudentProject.get(`${report.studentId}:${projectKey}`);
            if (!participation || participation.participationMode !== 'team') {
                filtered.push(report);
                continue;
            }

            const scopeKey = this.participationScopeKey(projectKey, participation);
            if (!canonicalLeadByScope.has(scopeKey)) {
                const canonicalId = await findCanonicalTeamLeadStudentId(
                    this.participantRepository,
                    projectKey,
                    {
                        teamId: participation.teamId,
                        applicationId: participation.applicationId,
                    },
                );
                canonicalLeadByScope.set(scopeKey, canonicalId);
            }

            const canonicalLeadId = canonicalLeadByScope.get(scopeKey);
            if (!canonicalLeadId) {
                filtered.push(report);
                continue;
            }

            if (report.studentId === canonicalLeadId) {
                filtered.push(report);
            }
        }

        return filtered;
    }

    /**
     * Report rows the student app should list: owned rows plus the team-lead canonical row per team project.
     * Used by dashboard, `GET reports/check`, and student-scoped `findAll`.
     */
    private async loadMergedReportEntitiesForStudent(studentId: string): Promise<StudentReport[]> {
        const reportRelations = ['student', 'opportunity', 'opportunity.organization'];

        const reportsOwned = await this.studentReportsRepository.find({
            where: { studentId },
            relations: reportRelations,
            order: { createdAt: 'DESC' },
        });

        const participantRows = await this.participantRepository.find({
            where: { studentId },
        });

        const uniqOpp = new Set<string>();
        const registerOpp = (key?: string | null) => {
            const s = (key || '').trim();
            if (this.looksLikeUuid(s)) {
                uniqOpp.add(s);
            }
        };
        for (const r of reportsOwned) {
            registerOpp(r.opportunityId ?? null);
            registerOpp(r.project_id ?? null);
        }
        for (const p of participantRows) {
            registerOpp(p.projectId ?? null);
        }

        const mergedReports: StudentReport[] = [];
        const seenRep = new Set<string>();
        const oppServedCanonical = new Set<string>();

        for (const oid of uniqOpp) {
            const { report } = await this.resolveReportRecordForParticipantRead(studentId, oid);
            if (!report || seenRep.has(report.id)) {
                continue;
            }
            mergedReports.push(report);
            seenRep.add(report.id);
            oppServedCanonical.add(oid);
        }

        for (const r of reportsOwned) {
            const k = (r.opportunityId || r.project_id || '').trim();
            if (this.looksLikeUuid(k) && oppServedCanonical.has(k)) {
                continue;
            }
            if (!seenRep.has(r.id)) {
                mergedReports.push(r);
                seenRep.add(r.id);
            }
        }

        mergedReports.sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        return mergedReports;
    }

    /** @see loadMergedReportEntitiesForStudent */
    async getMergedReportsForParticipant(studentId: string): Promise<StudentReport[]> {
        return this.loadMergedReportEntitiesForStudent(studentId);
    }

    /**
     * Public, unauthenticated: resolve QR / link key to verified status only (no PII or report body).
     * Lookup order: verification_public_slug, then report id, then project_id (legacy).
     */
    async getPublicImpactReportVerification(verificationKey: string) {
        const key = (verificationKey || '').trim();
        if (!key) {
            throw new NotFoundException();
        }

        let report =
            (await this.studentReportsRepository.findOne({
                where: { verificationPublicSlug: key },
                relations: ['opportunity'],
            })) ?? null;

        if (!report && this.looksLikeUuid(key)) {
            report = await this.studentReportsRepository.findOne({
                where: { id: key },
                relations: ['opportunity'],
            });
        }

        if (!report) {
            const rows = await this.studentReportsRepository.find({
                where: { project_id: key },
                relations: ['opportunity'],
                order: { adminApprovedAt: 'DESC', updatedAt: 'DESC' },
                take: 1,
            });
            report = rows[0] ?? null;
        }

        if (!report) {
            throw new NotFoundException();
        }

        const project_title = (report.opportunity?.title || 'Impact report').trim() || 'Impact report';
        const publicStatus = this.toPublicReportStatus(report.status);
        const latestPayment = await this.findLatestManualPayment(
            report.studentId,
            report.opportunityId || report.project_id,
        );
        const paymentStatus = latestPayment?.status ?? null;
        const verified =
            report.admin_status === 'approved' && (report.status === 'verified' || report.status === 'paid');

        if (!verified) {
            const approvalContext = this.getPublicReportApprovalContext(report);
            const feeCleared = await this.isReportFeeClearedForApprovals(report);
            const paymentPending =
                !feeCleared ||
                report.status === 'payment_pending' ||
                report.status === 'payment_under_review' ||
                paymentStatus === PaymentStatus.PENDING;
            const workflowStage =
                feeCleared &&
                approvalContext.requires_partner_approval &&
                !isReportPartnerStepSatisfied(report.partner_status)
                    ? 'pending_partner'
                    : feeCleared
                      ? 'pending_admin'
                      : undefined;

            return {
                success: true,
                verified: false,
                project_title,
                workflow_stage: paymentPending ? undefined : workflowStage,
                approval_stage: paymentPending ? undefined : workflowStage,
                status: publicStatus,
                report_status: paymentPending ? 'pending_payment' : publicStatus,
                partner_approval_status: report.partner_status,
                admin_approval_status: report.admin_status,
                payment_status: paymentStatus,
                ...approvalContext,
            };
        }

        return {
            success: true,
            verified: true,
            project_title,
            verified_at: report.adminApprovedAt
                ? new Date(report.adminApprovedAt).toISOString()
                : null,
        };
    }

    private collectEvidenceUrls(report: StudentReport): string[] {
        const urls = new Set<string>();
        const sections = [
            report.section1,
            report.section2,
            report.section3,
            report.section4,
            report.section5,
            report.section6,
            report.section7,
            report.section8,
            report.section9,
            report.section10,
        ];

        for (const section of sections) {
            const mediaUrls = Array.isArray(section?.media_urls) ? section.media_urls : [];
            for (const url of mediaUrls) {
                if (url) urls.add(url);
            }
        }

        const attendanceLogs = Array.isArray(report.section1?.attendance_logs)
            ? report.section1.attendance_logs
            : [];
        for (const log of attendanceLogs) {
            const evidenceUrl = (log as any)?.evidence_url;
            if (evidenceUrl) {
                urls.add(evidenceUrl);
            }
        }

        return Array.from(urls);
    }

    private async findLatestManualPayment(studentId: string, projectId: string | null | undefined) {
        if (!projectId) return null;
        return this.paymentRepository.findOne({
            where: { studentId, projectId },
            order: { created_at: 'DESC' },
        });
    }

    private paymentDerivedFields(
        latest: Payment | null | undefined,
        rawReportStatus: string,
        adminStatus?: string | null,
    ) {
        const publicStatus = this.resolveStudentFacingReportStatus(rawReportStatus, adminStatus);
        const payment_verified =
            latest?.status === PaymentStatus.APPROVED ||
            rawReportStatus === 'paid';
        const adminApproved = adminStatus === 'approved';
        const payment_status = payment_verified ? 'paid' : latest?.status ?? null;
        const status = payment_verified ? (adminApproved ? 'verified' : 'paid') : publicStatus;

        return {
            status,
            payment_verified,
            payment_status,
            ...(payment_verified ? { report_status: status } : {}),
        };
    }

    /**
     * Student-submitted opportunities only unlock reporting after admin approval (`live` / active).
     * Does not affect org/faculty-created opportunities or legacy rows without `isStudentCreated`.
     */
    private assertStudentOpportunityReportableForWrite(opp: Opportunity | null) {
        if (!opp?.isStudentCreated) return;
        const ok =
            opp.admin_approved === true &&
            (opp.workflowStage === 'live' || opp.status === 'active');
        if (!ok) {
            throw new ForbiddenException(
                'This opportunity is not live yet. Complete faculty, partner (if any), and admin approval before starting a report.',
            );
        }
    }

    async uploadFile(file: Express.Multer.File, section: string, studentId: string): Promise<string> {
        const folder = `student-reports-temp/${studentId}/${section}`;
        return this.s3Service.uploadFile(file, folder);
    }

    private resolveSubmitIntent(parsedData: any, forceSubmit: boolean): boolean {
        if (forceSubmit) return true;
        const submitSignal =
            parsedData?.submit ??
            parsedData?.is_submit ??
            parsedData?.final_submit ??
            parsedData?.action;
        if (typeof submitSignal === 'boolean') return submitSignal;
        if (typeof submitSignal === 'string') {
            const normalized = submitSignal.trim().toLowerCase();
            return ['true', '1', 'yes', 'submit', 'submitted'].includes(normalized);
        }
        return false;
    }

    /**
     * Team applications: only `isTeamLead` may finalize submission so one canonical report is filed per team.
     * Draft saves are unchanged. No participation row, non-team mode, or no flagged lead on the project → unchanged (legacy / creators).
     */
    private async assertTeamLeadMaySubmitReport(studentId: string, opportunityId: unknown): Promise<void> {
        if (opportunityId === null || opportunityId === undefined || opportunityId === '') return;
        const oid = String(opportunityId).trim();
        if (!this.looksLikeUuid(oid)) return;

        const mine = await this.participantRepository.findOne({
            where: { studentId, projectId: oid },
        });
        if (!mine) return;
        if (mine.participationMode !== 'team') return;

        const canonicalLead = await findCanonicalTeamLeadParticipation(this.participantRepository, oid, {
            teamId: mine.teamId,
            applicationId: mine.applicationId,
        });
        if (!canonicalLead?.studentId) {
            if (mine.isTeamLead) return;
            return;
        }
        if (canonicalLead.studentId !== studentId) {
            throw new ForbiddenException(
                'Only the team lead can submit the impact report for this team project. Your team lead should submit on behalf of the team.',
            );
        }
    }

    async createReport(studentId: string, dto: any, files: any[], forceSubmit = false) {
        // Parse form data and convert dot notation to nested objects
        const parsedData = this.parseFormData(dto);
        const shouldSubmit = this.resolveSubmitIntent(parsedData, forceSubmit);

        // Determine the opportunity ID from parsed data
        const opportunityIdFromDto = parsedData.opportunityId || parsedData.project_id;

        let opportunityForPolicy: Opportunity | null = null;
        if (opportunityIdFromDto) {
            opportunityForPolicy = await this.opportunitiesRepository.findOne({
                where: { id: opportunityIdFromDto },
            });
            this.assertStudentOpportunityReportableForWrite(opportunityForPolicy);
            if (opportunityForPolicy?.timeline?.type === 'flexible') {
                const startDate = new Date(opportunityForPolicy.timeline.start_date);
                const endDate = new Date(opportunityForPolicy.timeline.end_date);
                const diffMonths =
                    (endDate.getFullYear() - startDate.getFullYear()) * 12 +
                    (endDate.getMonth() - startDate.getMonth());

                if (diffMonths > 4) {
                    console.warn(
                        `[Policy] Flexible project ${opportunityForPolicy.id} exceeds 4-month window: ${diffMonths} months.`,
                    );
                }
            }
        }

        if (shouldSubmit && opportunityIdFromDto) {
            await this.assertTeamLeadMaySubmitReport(studentId, opportunityIdFromDto);
        }

        const reportOwnerId =
            opportunityIdFromDto ?
                await this.resolveTeamReportOwnerStudentId(studentId, String(opportunityIdFromDto))
            :   studentId;

        // Upsert logic: Check if report already exists
        let report = await this.studentReportsRepository.findOne({
            where: {
                studentId: reportOwnerId,
                opportunityId: opportunityIdFromDto
            }
        });
        const priorReportStatus = report?.status ?? null;
        const lockedReportStatuses = this.lockedReportStatusesForStudentWrite();

        if (report) {
            // Update existing report
            if (shouldSubmit) {
                if (this.isReportRejectedForRevision(report)) {
                    report.admin_status = 'pending';
                    if (String(report.partner_status || '').toLowerCase() === 'rejected') {
                        report.partner_status = 'pending';
                    }
                    report.adminApprovedAt = null;
                    report.partnerApprovedAt = null;
                }
                report.status = 'submitted';
                this.applyStatusAfterStudentSubmit(report);
            } else if (!lockedReportStatuses.has(report.status)) {
                report.status = 'draft';
            } else if (this.isReportRejectedForRevision(report)) {
                report.status = 'revision';
            }
            if (parsedData.section1) report.section1 = parsedData.section1;
            if (parsedData.section2) report.section2 = parsedData.section2;
            if (parsedData.section3) report.section3 = parsedData.section3;
            if (parsedData.section4) report.section4 = parsedData.section4;
            if (parsedData.section5) report.section5 = parsedData.section5;
            if (parsedData.section6) report.section6 = parsedData.section6;
            if (parsedData.section7) report.section7 = parsedData.section7;
            if (parsedData.section8) report.section8 = parsedData.section8;
            if (parsedData.section9) report.section9 = parsedData.section9;
            if (parsedData.section10) report.section10 = parsedData.section10;
            if (parsedData.section11) report.section11 = parsedData.section11;

            // If it was already validated, maybe keep it, otherwise reset to pending if re-submitting new data
            if (report.sdg_validation_status !== 'validated') {
                report.sdg_summary_stage = 'preliminary';
                report.sdg_validation_status = 'pending';
            }
        } else {
            // Create new report entity
            report = this.studentReportsRepository.create({
                studentId: reportOwnerId,
                opportunityId: opportunityIdFromDto,
                status: shouldSubmit ? 'submitted' : 'draft',
                section1: parsedData.section1, // Participation & Attendance
                section2: parsedData.section2, // Project Context
                section3: parsedData.section3,
                section4: parsedData.section4,
                section5: parsedData.section5,
                section6: parsedData.section6,
                section7: parsedData.section7,
                section8: parsedData.section8,
                section9: parsedData.section9,
                section10: parsedData.section10,
                section11: parsedData.section11,
                sdg_summary_stage: 'preliminary',
                sdg_validation_status: 'pending'
            });
        }

        // Sync Section 3 (SDG Mapping)
        report.section3 = parsedData.section3;
        report.primary_sdg_goal = parsedData.section3?.primary_sdg?.goal_number;
        report.primary_sdg_target = parsedData.section3?.primary_sdg?.target_code;
        report.primary_sdg_indicator = parsedData.section3?.primary_sdg?.indicator_code;
        report.contribution_intent_statement = parsedData.section3?.contribution_intent_statement;

        // Regenerate Stage 1 Summary if Section 3 is present
        if (report.contribution_intent_statement) {
            report.section3.summary_text = this.generateSDGStage1Summary(report);
        }

        // Sync Summary Fields (Section 2)
        // Re-generate in backend to ensure consistency
        const opportunityForSummary = await this.opportunitiesRepository.findOne({
            where: { id: report.opportunityId },
        });

        report.problem_category = this.classifyProblem(report.section2?.problem_statement);
        report.primary_beneficiary = this.detectBeneficiary(report.section2?.problem_statement);
        report.baseline_evidence_source = (report.section2?.baseline_evidence === 'Other' ? report.section2.baseline_evidence_other : report.section2?.baseline_evidence) || 'Unknown';
        report.discipline_alignment = report.section2?.discipline || 'Not specified';

        report.summary_text_generated = this.generateSection2Summary(report, opportunityForSummary || undefined);
        if (report.section2) {
            report.section2.summary_text = report.summary_text_generated;
            report.section2.problem_category = report.problem_category;
            report.section2.primary_beneficiary = report.primary_beneficiary;
        }

        // Point 3 Clean Up: Ensure team_members is not stored in the JSON blob
        if (report.section1 && (report.section1 as any).team_members) {
            delete (report.section1 as any).team_members;
        }

        // Handle Faculty Assignment if faculty email is provided in Section 1
        if (report.section1?.faculty_supervisor_email) {
            await this.handleFacultyAssignment(report, report.section1.faculty_supervisor_email);
        }

        if (shouldSubmit) {
            const submitStamp = new Date();
            report.reportSubmittedAt = submitStamp;
            report.submission_date = submitStamp;
            if (report.status === 'submitted') {
                this.applyStatusAfterStudentSubmit(report);
            }
        }

        await this.syncReportProjectKeys(report);

        // Save report to get ID (verification_public_slug filled in entity @BeforeInsert/@BeforeUpdate)
        await this.studentReportsRepository.save(report);

        // Save files if any
        if (files && files.length > 0) {
            const filePaths = await this.saveFiles(files, report.id);

            // Update report with file paths
            this.updateReportWithFilePaths(report, filePaths);
            await this.studentReportsRepository.save(report);
        }

        const skipAdminSubmitNotify = new Set([
            'submitted',
            'partner_verified',
            'payment_pending',
            'payment_under_review',
            'verified',
            'paid',
        ]);
        const shouldEmailAdminSubmit =
            shouldSubmit && (priorReportStatus == null || !skipAdminSubmitNotify.has(priorReportStatus));
        if (shouldEmailAdminSubmit) {
            const oppForTitle =
                opportunityForPolicy ||
                (report.opportunityId
                    ? await this.opportunitiesRepository.findOne({ where: { id: report.opportunityId } })
                    : null);
            const projectTitle = oppForTitle?.title || report.project_id || 'Student project';
            const student = await this.usersRepository.findOne({ where: { id: studentId } });
            void this.mailService
                .sendAdminStudentReportSubmitted(
                    projectTitle,
                    report.opportunityId || opportunityIdFromDto || '',
                    report.id,
                    student?.name || 'Student',
                )
                .catch(() => undefined);
        }

        return {
            success: true,
            message: shouldSubmit ? 'Report submitted successfully.' : 'Report saved as draft.',
            data: {
                report_id: report.id,
                ...this.reportVerificationPayload(report),
                project_id: report.project_id,
                submitted_at: report.submission_date,
                report_submitted_at: report.reportSubmittedAt,
                partner_approved_at: report.partnerApprovedAt,
                admin_approved_at: report.adminApprovedAt,
                status: report.status,
            },
        };
    }

    async saveDraft(studentId: string, dto: any, files: any[]) {
        const parsedData = this.parseFormData(dto);

        const reportOwnerId =
            parsedData.opportunityId ?
                await this.resolveTeamReportOwnerStudentId(studentId, String(parsedData.opportunityId))
            :   studentId;

        let report = await this.studentReportsRepository.findOne({
            where: {
                studentId: reportOwnerId,
                opportunityId: parsedData.opportunityId
            }
        });

        const lockedReportStatuses = this.lockedReportStatusesForStudentWrite();

        if (report) {
            if (!lockedReportStatuses.has(report.status)) {
                report.status = 'draft';
            } else if (this.isReportRejectedForRevision(report)) {
                report.status = 'revision';
            }
            if (parsedData.project_id) report.project_id = parsedData.project_id;
            if (parsedData.section1) report.section1 = parsedData.section1;
            if (parsedData.section2) report.section2 = parsedData.section2;
            if (parsedData.section3) report.section3 = parsedData.section3;
            if (parsedData.section4) report.section4 = parsedData.section4;
            if (parsedData.section5) report.section5 = parsedData.section5;
            if (parsedData.section6) report.section6 = parsedData.section6;
            if (parsedData.section7) report.section7 = parsedData.section7;
            if (parsedData.section8) report.section8 = parsedData.section8;
            if (parsedData.section9) report.section9 = parsedData.section9;
            if (parsedData.section10) report.section10 = parsedData.section10;
            if (parsedData.section11) report.section11 = parsedData.section11;
        } else {
            if (parsedData.opportunityId) {
                const opp = await this.opportunitiesRepository.findOne({
                    where: { id: parsedData.opportunityId },
                });
                this.assertStudentOpportunityReportableForWrite(opp);
            }
            report = this.studentReportsRepository.create({
                studentId: reportOwnerId,
                project_id: parsedData.project_id,
                opportunityId: parsedData.opportunityId,
                status: 'draft',
                section1: parsedData.section1,
                section2: parsedData.section2,
                section3: parsedData.section3,
                section4: parsedData.section4,
                section5: parsedData.section5,
                section6: parsedData.section6,
                section7: parsedData.section7,
                section8: parsedData.section8,
                section9: parsedData.section9,
                section10: parsedData.section10,
                section11: parsedData.section11,
            });
        }

        // Point 3 Clean Up: Ensure team_members is not stored in the JSON blob
        if (report.section1 && (report.section1 as any).team_members) {
            delete (report.section1 as any).team_members;
        }

        // Handle Faculty Assignment if faculty email is provided in Section 1
        if (report.section1?.faculty_supervisor_email) {
            await this.handleFacultyAssignment(report, report.section1.faculty_supervisor_email);
        }

        await this.syncReportProjectKeys(report);

        await this.studentReportsRepository.save(report);

        if (files && files.length > 0) {
            const filePaths = await this.saveFiles(files, report.id);
            this.updateReportWithFilePaths(report, filePaths);
            await this.studentReportsRepository.save(report);
        }

        return {
            success: true,
            message: 'Draft saved successfully.',
            data: {
                draft_id: report.id,
                report_id: report.id,
                ...this.reportVerificationPayload(report),
                last_saved: report.updatedAt,
            },
        };
    }

    async findAll(query: any) {
        const { status, organizationId, studentId, page = 1, limit = 10 } = query;
        const limitNum =
            typeof limit === 'number' ? limit : Math.max(1, parseInt(String(limit), 10) || 10);
        const pageNum = typeof page === 'number' ? page : Math.max(1, parseInt(String(page), 10) || 1);
        const skip = (pageNum - 1) * limitNum;

        if (studentId) {
            let rows = await this.loadMergedReportEntitiesForStudent(studentId);
            if (organizationId) {
                rows = rows.filter((r) => r.opportunity?.organizationId === organizationId);
            }
            if (status) {
                rows = rows.filter((r) => r.status === status);
            }
            const total = rows.length;
            const paginated = rows.slice(skip, skip + limitNum);
            const opportunityByProjectId = await this.loadOpportunitiesForReports(paginated);
            return {
                success: true,
                data: paginated.map((r) => this.mapReportListing(r, opportunityByProjectId)),
                pagination: {
                    total,
                    page: pageNum,
                    limit: limitNum,
                    total_pages: Math.max(1, Math.ceil(total / limitNum)),
                },
            };
        }

        const whereClause: any = {};
        if (status) {
            whereClause.status = status;
        }
        if (organizationId) {
            whereClause.opportunity = { organizationId };
        }

        let reports = await this.studentReportsRepository.find({
            where: whereClause,
            relations: ['student', 'opportunity', 'opportunity.organization'],
            order: { submission_date: 'DESC', createdAt: 'DESC' },
        });

        reports = await this.filterReportsForAdminPartnerQueue(reports);

        if (organizationId) {
            const cleared: StudentReport[] = [];
            for (const row of reports) {
                if (await this.isReportFeeClearedForApprovals(row)) cleared.push(row);
            }
            reports = cleared;
        }

        const total = reports.length;
        const paginated = reports.slice(skip, skip + limitNum);

        const opportunityByProjectId = await this.loadOpportunitiesForReports(paginated);
        const mapped = paginated.map((r) => this.mapReportListing(r, opportunityByProjectId));
        mapped.sort((a, b) => {
            const aMs = new Date(a.report_submitted_at ?? a.submitted_at ?? a.submission_date ?? 0).getTime();
            const bMs = new Date(b.report_submitted_at ?? b.submitted_at ?? b.submission_date ?? 0).getTime();
            return bMs - aMs;
        });

        return {
            success: true,
            data: mapped,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                total_pages: Math.max(1, Math.ceil(total / limitNum)),
            },
        };
    }

    async findOne(id: string) {
        const report = await this.studentReportsRepository.findOne({
            where: { id },
            relations: ['student', 'opportunity'],
        });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        return await this.formatReportResponse(report);
    }

    /** Same dossier payload as admin/partner detail, for role-scoped controllers that already verified access. */
    async buildDetailResponse(report: StudentReport, attendanceParticipantStudentId?: string) {
        return this.formatReportResponse(report, attendanceParticipantStudentId);
    }

    async findOneForPartner(id: string, organizationId: string) {
        const report = await this.studentReportsRepository.findOne({
            where: { id },
            relations: ['student', 'opportunity'],
        });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        if (!organizationId || report.opportunity?.organizationId !== organizationId) {
            throw new ForbiddenException('You can only access reports linked to your organization');
        }

        return await this.formatReportResponse(report);
    }

    async findOneByOpportunityOrId(id: string, studentId: string) {
        console.log(`[StudentReportsService] findOneByOpportunityOrId search started:`);
        console.log(`  - Target ID (URL): ${id}`);
        console.log(`  - Student ID (from JWT): ${studentId}`);

        // Try finding by primary key (Report ID) first
        let report = await this.studentReportsRepository.findOne({
            where: { id, studentId },
            relations: ['student', 'opportunity'],
        });

        let attendanceParticipantId = studentId;

        if (report) {
            console.log(`  - Match found by Primary Key (Report ID)`);
        }

        if (!report && this.looksLikeUuid(id)) {
            const byPk = await this.studentReportsRepository.findOne({
                where: { id },
                relations: ['student', 'opportunity'],
            });
            if (byPk && (await this.participantMayAccessReport(studentId, byPk))) {
                report = byPk;
            }
        }

        if (!report) {
            report = await this.studentReportsRepository.findOne({
                where: { verificationPublicSlug: id, studentId },
                relations: ['student', 'opportunity'],
            });
            if (report) {
                console.log(`  - Match found by verification_public_slug`);
            }
        }

        if (!report) {
            const bySlugOnly = await this.studentReportsRepository.findOne({
                where: { verificationPublicSlug: id },
                relations: ['student', 'opportunity'],
            });
            if (bySlugOnly && (await this.participantMayAccessReport(studentId, bySlugOnly))) {
                report = bySlugOnly;
            }
        }

        // If not found, resolve canonical team report or own row by opportunityId / project_id
        if (!report) {
            console.log(`  - Not found by Report ID. Searching by opportunityId or project_id...`);
            const resolved = await this.resolveReportRecordForParticipantRead(studentId, id);
            report = resolved.report;
            attendanceParticipantId = resolved.attendanceStudentId;
        }

        if (report) {
            return await this.formatReportResponse(report, attendanceParticipantId);
        }

        // If no report found, check for an application to pre-populate
        const application = await this.participantRepository.findOne({
            where: { projectId: id, studentId },
        });

        if (application) {
            const studentProfile = await this.usersRepository.findOne({ where: { id: studentId } });
            return {
                success: true,
                data: {
                    project_id: id,
                    opportunityId: id,
                    status: 'none',
                    section1: {
                        participation_type: application.participationMode || 'individual',
                        team_lead: {
                            name: studentProfile?.name || '',
                            fullName: studentProfile?.name || '',
                            email: studentProfile?.email || '',
                            mobile: studentProfile?.phone || '',
                            cnic: studentProfile?.cnic || '',
                            university: studentProfile?.university || '',
                            program: studentProfile?.major || '',
                            verified: true
                        },
                        team_members: await this.engagementService.getProjectTeamForReportDossier(id),
                        attendance_logs: [],
                        metrics: {
                            total_verified_hours: 0,
                            total_active_days: 0,
                            engagement_span: 0,
                            attendance_frequency: 0,
                            weekly_continuity: 0,
                            eis_score: 0,
                            engagement_category: 'Introductory Engagement',
                            hec_compliance: 'below'
                        }
                    }
                }
            };
        }

        return {
            success: true,
            data: null
        };
    }

    private async formatReportResponse(report: StudentReport, attendanceParticipantStudentId?: string) {
        const pid = report.opportunityId || report.project_id;
        const attendeeId = attendanceParticipantStudentId ?? report.studentId;
        const attendanceLogs = await this.attendanceLogsRepository.find({
            where: {
                participant: { studentId: attendeeId },
                projectId: pid,
            },
            order: { dateOfEngagement: 'ASC', startTime: 'ASC' },
        });
        const projectKey = report.opportunityId || report.project_id;
        const latestPayment = await this.findLatestManualPayment(report.studentId, projectKey);
        const adminStatus = report.admin_status ?? 'pending';
        const { status, payment_verified, ...paymentRest } = this.paymentDerivedFields(
            latestPayment,
            report.status,
            adminStatus,
        );
        const approvalContext = this.getPublicReportApprovalContext(report);
        const feedback = this.buildStudentReportFeedback(report);
        const isEditable = this.isReportEditableForStudent(report);

        return {
            success: true,
            data: {
                id: report.id,
                report_id: report.id,
                ...this.reportVerificationPayload(report),
                is_editable: isEditable,
                feedback,
                admin_feedback: report.admin_feedback,
                student: {
                    id: report.student?.id,
                    name: report.student?.name,
                    email: report.student?.email,
                },
                opportunity: {
                    id: report.opportunity?.id,
                    title: report.opportunity?.title,
                    city: report.opportunity?.location?.city,
                    start_date: report.opportunity?.timeline?.start_date,
                    end_date: report.opportunity?.timeline?.end_date,
                    expected_hours: report.opportunity?.timeline?.expected_hours,
                },
                project_id: report.project_id,
                projectId: projectKey,
                opportunityId: report.opportunityId,
                status,
                payment_verified,
                ...paymentRest,
                partner_status: report.partner_status,
                ...approvalContext,
                faculty_status: report.faculty_status,
                faculty_remarks: report.faculty_remarks,
                admin_status: adminStatus,
                admin_approval_status: adminStatus,
                submission_date: report.submission_date,
                submitted_at: report.reportSubmittedAt ?? report.submission_date ?? report.createdAt,
                report_submitted_at: report.reportSubmittedAt,
                partner_approved_at: report.partnerApprovedAt,
                admin_approved_at: report.adminApprovedAt,
                evidence_urls: this.collectEvidenceUrls(report),
                section1: {
                    ...report.section1,
                    team_lead: report.section1?.team_lead ? {
                        ...report.section1.team_lead,
                        fullName: report.section1.team_lead.fullName || report.section1.team_lead.name || '',
                        cnic: this.engagementService.decryptCnicInternal(report.section1.team_lead.cnic)
                    } : undefined,
                    // Point 1 & 3: Dynamically fetch team members from the source of truth (Participants/Engagement table)
                    team_members: await this.engagementService.getProjectTeamForReportDossier(
                        report.opportunityId || report.project_id,
                    ),
                    attendance_logs:
                        attendanceLogs.length > 0
                            ? attendanceLogs.map((log) => ({
                                  id: log.id,
                                  participantId: log.participantId,
                                  date: log.dateOfEngagement,
                                  start_time: log.startTime,
                                  end_time: log.endTime,
                                  location: log.organizationName, // Mapping as location
                                  activity_type: log.activityType,
                                  description: log.description,
                                  hours: Number(log.sessionHours),
                                  evidence_url: log.evidenceUrl,
                                  entryStatus: log.entryStatus,
                                  approval_status: (log as any).approvalStatus ?? null,
                                  approval_action_reason: (log as any).approvalActionReason ?? null,
                                  assigned_approver_type: (log as any).assignedApproverType ?? null,
                                  opportunity_creator_kind: (log as any).opportunityCreatorKind ?? null,
                              }))
                            : report.section1?.attendance_logs || [],
                },
                section2: report.section2,
                section3: report.section3,
                section4: report.section4,
                section5: report.section5,
                section6: report.section6,
                section7: report.section7,
                section8: report.section8,
                section9: report.section9,
                section10: report.section10,
                section11: report.section11,
                created_at: report.createdAt,
                updated_at: report.updatedAt,
            },
        };
    }

    async removeReport(id: string) {
        const report = await this.studentReportsRepository.findOne({ where: { id } });
        if (!report) {
            throw new NotFoundException('Report not found');
        }
        await this.studentReportsRepository.remove(report);
        return { success: true, message: 'Report deleted successfully' };
    }

    async verifyReport(
        id: string,
        action: 'approve' | 'reject' | 'unlock',
        role: string = 'admin',
        reason?: string,
        organizationId?: string,
    ) {
        if (!['approve', 'reject', 'unlock'].includes(action)) {
            throw new BadRequestException('action must be approve, reject, or unlock');
        }

        const report = await this.studentReportsRepository.findOne({
            where: { id },
            relations: ['opportunity'],
        });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        const isPartnerReviewer = this.isPartnerReviewerRole(role);
        if (isPartnerReviewer) {
            if (!organizationId || report.opportunity?.organizationId !== organizationId) {
                throw new ForbiddenException('You can only verify reports linked to your organization');
            }
        }

        const decisionStamp = new Date();
        if (action === 'unlock') {
            if (isPartnerReviewer) {
                throw new ForbiddenException('Only admins can unlock reports');
            }
            report.status = 'draft';
            report.admin_status = 'pending';
            report.partner_status = 'pending';
            report.partnerApprovedAt = null;
            report.adminApprovedAt = null;
            if (reason) {
                report.admin_feedback = reason;
            }
        } else if (action === 'reject') {
            if (!reason?.trim()) {
                throw new BadRequestException('feedback or reason is required when rejecting');
            }
            report.status = 'revision';
            if (role === 'admin') report.admin_status = 'rejected';
            if (isPartnerReviewer) {
                report.partner_status = 'rejected';
                report.partnerApprovedAt = null;
            }
            report.adminApprovedAt = null;
            report.admin_feedback = reason.trim();
        } else if (action === 'approve') {
            await this.assertReportFeeClearedBeforeApproval(report);
            if (isPartnerReviewer) {
                report.partner_status = 'approved';
                report.partnerApprovedAt = decisionStamp;
                report.status = report.admin_status === 'approved' ? 'verified' : 'partner_verified';
            } else if (role === 'admin') {
                report.admin_status = 'approved';
                report.adminApprovedAt = decisionStamp;
                const requiresPartner = this.reportPartnerApprovalSettings.reportRequiresPartnerApprovalSync(
                    report,
                    (value) => this.hasMeaningfulObjectValue(value),
                );
                if (isReportPartnerStepSatisfied(report.partner_status) || !requiresPartner) {
                    report.status = 'verified';
                    if (
                        !requiresPartner &&
                        report.partner_status === 'pending'
                    ) {
                        report.partner_status = 'not_applicable';
                    }
                }
            }
        }

        await this.studentReportsRepository.save(report);

        let actionMessage = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'unlocked';

        return {
            success: true,
            message: `Report ${actionMessage} successfully.`,
            data: {
                id: report.id,
                status: report.status,
                partner_status: report.partner_status,
                admin_status: report.admin_status,
                report_submitted_at: report.reportSubmittedAt,
                partner_approved_at: report.partnerApprovedAt,
                admin_approved_at: report.adminApprovedAt,
            },
        };
    }

    async checkReportStatus(studentId: string, opportunityId?: string) {
        if (!opportunityId) {
            const mergedReports = await this.loadMergedReportEntitiesForStudent(studentId);

            const data: Record<string, unknown>[] = [];
            for (const r of mergedReports) {
                const projectKey = r.opportunityId || r.project_id;
                const latest = await this.findLatestManualPayment(
                    r.studentId,
                    projectKey,
                );
                const adminStatus = r.admin_status ?? 'pending';
                const { status, payment_verified, ...paymentRest } = this.paymentDerivedFields(
                    latest,
                    r.status,
                    adminStatus,
                );
                const feedback = this.buildStudentReportFeedback(r);
                data.push({
                    status,
                    payment_verified,
                    ...paymentRest,
                    report_id: r.id,
                    ...this.reportVerificationPayload(r),
                    project_id: r.project_id,
                    projectId: projectKey,
                    opportunity_id: r.opportunityId,
                    opportunity_title: r.opportunity?.title,
                    admin_status: adminStatus,
                    admin_approval_status: adminStatus,
                    partner_status: r.partner_status,
                    feedback,
                    admin_feedback: r.admin_feedback,
                    is_editable: this.isReportEditableForStudent(r),
                    submission_date: r.submission_date,
                    report_submitted_at: r.reportSubmittedAt,
                    partner_approved_at: r.partnerApprovedAt,
                    admin_approved_at: r.adminApprovedAt,
                });
            }

            return {
                success: true,
                data,
            };
        }

        const resolved = await this.resolveReportRecordForParticipantRead(studentId, opportunityId);
        const report = resolved.report;

        if (!report) {
            return {
                success: true,
                data: {
                    status: 'none',
                    report_id: null,
                    feedback: null,
                },
            };
        }

        const latest = await this.findLatestManualPayment(report.studentId, report.opportunityId || report.project_id);
        const adminStatus = report.admin_status ?? 'pending';
        const { status, payment_verified, ...paymentRest } = this.paymentDerivedFields(
            latest,
            report.status,
            adminStatus,
        );
        const feedback = this.buildStudentReportFeedback(report);

        return {
            success: true,
            data: {
                status,
                payment_verified,
                ...paymentRest,
                report_id: report.id,
                ...this.reportVerificationPayload(report),
                project_id: report.project_id,
                projectId: report.opportunityId || report.project_id,
                opportunity_id: report.opportunityId,
                admin_status: adminStatus,
                admin_approval_status: adminStatus,
                partner_status: report.partner_status,
                feedback,
                admin_feedback: report.admin_feedback,
                is_editable: this.isReportEditableForStudent(report),
                submission_date: report.submission_date,
                report_submitted_at: report.reportSubmittedAt,
                partner_approved_at: report.partnerApprovedAt,
                admin_approved_at: report.adminApprovedAt,
            },
        };
    }

    private generateSDGStage1Summary(report: StudentReport): string {
        const goal = report.primary_sdg_goal || report.section3?.primary_sdg?.goal_number || 4;
        const goalTitle = report.section3?.primary_sdg?.goal_title || 'Quality Education';
        const target = report.primary_sdg_target || report.section3?.primary_sdg?.target_code || '4.4';
        const indicator = report.primary_sdg_indicator || report.section3?.primary_sdg?.indicator_code || '4.4.1';

        return `This project is aligned with SDG ${goal} (${goalTitle}), Target ${target}. The planned intervention focuses on contributing toward indicator ${indicator}. Full validation of indicator-level contribution logic will be determined after measurable outputs and outcomes are submitted in Sections 4 and 5.`;
    }

    private classifyProblem(text: string): string {
        const t = (text || '').toLowerCase();
        if (t.includes("school") || t.includes("student") || t.includes("learning") || t.includes("education")) return "Education Access Gap";
        if (t.includes("skills") || t.includes("training") || t.includes("capacity") || t.includes("competency")) return "Skills Deficiency";
        if (t.includes("internet") || t.includes("digital") || t.includes("technology") || t.includes("access")) return "Digital Divide";
        if (t.includes("health") || t.includes("sanitation") || t.includes("hygiene")) return "Health Awareness Gap";
        if (t.includes("waste") || t.includes("climate") || t.includes("pollution")) return "Environmental Degradation";
        if (t.includes("policy") || t.includes("governance") || t.includes("law")) return "Policy / Governance Gap";
        if (t.includes("infrastructure") || t.includes("building") || t.includes("road")) return "Infrastructure Deficiency";
        if (t.includes("gender") || t.includes("equality")) return "Gender Inequality";
        if (t.includes("economic") || t.includes("opportunity") || t.includes("jobs") || t.includes("poverty")) return "Economic Opportunity Gap";
        if (t.includes("data") || t.includes("system") || t.includes("inefficiency")) return "Data / System Inefficiency";
        return "Other";
    }

    private detectBeneficiary(text: string): string {
        const t = (text || '').toLowerCase();
        if (t.includes("students")) return "Students";
        if (t.includes("women")) return "Women";
        if (t.includes("youth")) return "Youth";
        if (t.includes("business") || t.includes("smes")) return "Small Businesses";
        if (t.includes("rural")) return "Rural Communities";
        if (t.includes("low-income") || t.includes("household") || t.includes("poor")) return "Low-Income Households";
        if (t.includes("public") || t.includes("institution")) return "Public Institutions";
        return "Community Members";
    }

    private generateSection2Summary(report: StudentReport, opportunity?: Opportunity): string {
        const pCategory = this.classifyProblem(report.section2?.problem_statement);
        const beneficiary = this.detectBeneficiary(report.section2?.problem_statement);

        let district = opportunity?.location?.district || "District";
        let province = opportunity?.location?.province || "Province";
        let country = opportunity?.location?.country || "Pakistan";

        // Fallback to timeline if necessary
        if (!opportunity?.location?.district && opportunity?.timeline?.location_district) {
            district = opportunity.timeline.location_district;
            province = opportunity.timeline.location_province || province;
            country = opportunity.timeline.location_country || country;
        }

        const location = `${district}, ${province}, ${country}`;

        const evidence = report.section2?.baseline_evidence === 'Other'
            ? (report.section2?.baseline_evidence_other || 'Other Sources')
            : report.section2?.baseline_evidence;

        const discipline = report.section2?.discipline || "Academic Alignment";

        return `This project addresses a documented gap in ${pCategory} affecting ${beneficiary} in ${location}. Baseline assessment was informed through ${evidence}. The project demonstrates academic alignment with ${discipline}, ensuring structured and evidence-based engagement.`;
    }

    private parseFormData(formData: any): any {
        const result: any = {};

        for (const key in formData) {
            const value = formData[key];
            this.setNestedProperty(result, key, value);
        }

        return result;
    }

    private setNestedProperty(obj: any, path: string, value: any) {
        const keys = path.split('.');
        let current = obj;

        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);

            if (arrayMatch) {
                const arrayKey = arrayMatch[1];
                const index = parseInt(arrayMatch[2]);

                if (!current[arrayKey]) {
                    current[arrayKey] = [];
                }
                if (!current[arrayKey][index]) {
                    current[arrayKey][index] = {};
                }
                current = current[arrayKey][index];
            } else {
                if (!current[key]) {
                    current[key] = {};
                }
                current = current[key];
            }
        }

        const lastKey = keys[keys.length - 1];
        const arrayMatch = lastKey.match(/^(.+)\[(\d+)\]$/);

        if (arrayMatch) {
            const arrayKey = arrayMatch[1];
            const index = parseInt(arrayMatch[2]);
            if (!current[arrayKey]) {
                current[arrayKey] = [];
            }
            current[arrayKey][index] = value;
        } else {
            current[lastKey] = value;
        }
    }

    private async saveFiles(files: any[], reportId: string): Promise<{ [key: string]: string[] }> {
        const filePaths: { [key: string]: string[] } = {};

        for (const file of files) {
            const fieldName = file.fieldname;
            const section = this.getSectionFromFieldName(fieldName);
            const folder = `student-reports/${reportId}/${section}`;

            const s3Url = await this.s3Service.uploadFile(file, folder);

            if (!filePaths[section]) {
                filePaths[section] = [];
            }
            filePaths[section].push(s3Url);
        }

        return filePaths;
    }

    private getSectionFromFieldName(fieldName: string): string {
        const sectionMatch = fieldName.match(/section(\d+)/);
        return sectionMatch ? `section${sectionMatch[1]}` : 'general';
    }

    private updateReportWithFilePaths(report: StudentReport, filePaths: { [key: string]: string[] }) {
        for (const section in filePaths) {
            if (report[section]) {
                // Initialize media_urls if it doesn't exist
                if (!report[section].media_urls) {
                    report[section].media_urls = [];
                }
                // Add new URLs to the section
                report[section].media_urls.push(...filePaths[section]);
            }
        }
    }

    private async handleFacultyAssignment(report: StudentReport, email: string) {
        // 1. Search for faculty user
        const facultyUser = await this.usersRepository.findOne({
            where: { email: email.toLowerCase(), role: 'faculty' as any }
        });

        if (facultyUser) {
            // Already exists, link it
            report.facultyId = facultyUser.id;
            // No need to invite if they already have an account, but maybe notify?
            // For now, just link.
        } else {
            // Does not exist, clear any previous link and trigger invite
            report.facultyId = null;

            // Get student name and project title for the email
            const student = await this.usersRepository.findOne({ where: { id: report.studentId } });
            const opportunity = await this.opportunitiesRepository.findOne({ where: { id: report.opportunityId } });
            const projectTitle = opportunity?.title || report.project_id || 'Student Project';

            await this.mailService.sendFacultyInvite(email, student?.name || 'A Student', projectTitle);
        }
    }

    private resolveCiiScoreFromPayload(
        section11?: Record<string, unknown> | null,
        ciiIndex?: Record<string, unknown> | null,
    ): number | null {
        const readScore = (value: unknown): number | null => {
            if (typeof value === 'number' && Number.isFinite(value)) {
                return Math.min(100, Math.max(0, Math.round(value)));
            }
            if (typeof value === 'string') {
                const match = value.trim().match(/\d+(?:\.\d+)?/);
                if (!match) return null;
                const parsed = Number(match[0]);
                return Number.isFinite(parsed) ? Math.min(100, Math.max(0, Math.round(parsed))) : null;
            }
            return null;
        };

        const cii = (ciiIndex ?? section11?.cii_index) as Record<string, unknown> | undefined;
        const fromCii =
            readScore(cii?.totalScore) ??
            readScore(cii?.total_score) ??
            readScore(cii?.score) ??
            readScore(section11?.ai_generated_impact_score);

        if (fromCii !== null) return fromCii;

        const summary = typeof section11?.summary_text === 'string' ? section11.summary_text : '';
        const patterns = [
            /\bFinal\s+Adjusted\s+CII\s+Score\s*[:=-]?\s*(\d+(?:\.\d+)?)/i,
            /\bCII\s+Index\s+Score\s*[:=-]?\s*(\d+(?:\.\d+)?)/i,
            /\bCII\s+Score\s*[:=-]?\s*(\d+(?:\.\d+)?)/i,
        ];
        for (const pattern of patterns) {
            const match = summary.match(pattern);
            const score = match?.[1] ? readScore(match[1]) : null;
            if (score !== null) return score;
        }

        return null;
    }

    /** Admin-only: persist regenerated Section 11 AI audit + CII score. */
    async updateReportAiScore(
        reportId: string,
        body: { section11?: Record<string, unknown>; cii_index?: Record<string, unknown> },
    ) {
        const report = await this.studentReportsRepository.findOne({
            where: { id: reportId },
            relations: ['student', 'opportunity'],
        });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        const incomingSection11 = body.section11 && typeof body.section11 === 'object' ? body.section11 : {};
        const mergedSection11: Record<string, unknown> = {
            ...((report.section11 as Record<string, unknown> | null | undefined) ?? {}),
            ...incomingSection11,
        };

        if (body.cii_index && typeof body.cii_index === 'object') {
            mergedSection11.cii_index = body.cii_index;
        }

        const score = this.resolveCiiScoreFromPayload(mergedSection11, body.cii_index ?? null);
        if (score !== null) {
            mergedSection11.ai_generated_impact_score = score;
        }

        report.section11 = mergedSection11 as StudentReport['section11'];
        await this.studentReportsRepository.save(report);

        return this.formatReportResponse(report);
    }
}

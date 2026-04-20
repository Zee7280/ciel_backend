import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
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
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';

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
    ) { }

    /** Aligns legacy DB values with student UI / frontend lifecycle names. */
    private toPublicReportStatus(raw: string | null | undefined): string {
        if (raw === 'payment_pending') return 'payment_under_review';
        if (raw === 'continue') return 'draft';
        return raw ?? 'draft';
    }

    private async findLatestManualPayment(studentId: string, projectId: string | null | undefined) {
        if (!projectId) return null;
        return this.paymentRepository.findOne({
            where: { studentId, projectId },
            order: { created_at: 'DESC' },
        });
    }

    private paymentDerivedFields(latest: Payment | null | undefined, rawReportStatus: string) {
        const payment_verified = latest?.status === PaymentStatus.APPROVED;
        return {
            status: this.toPublicReportStatus(rawReportStatus),
            payment_verified,
            ...(payment_verified ? { report_status: 'paid' as const } : {}),
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

    async createReport(studentId: string, dto: any, files: any[]) {
        // Parse form data and convert dot notation to nested objects
        const parsedData = this.parseFormData(dto);

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

        // Upsert logic: Check if report already exists
        let report = await this.studentReportsRepository.findOne({
            where: {
                studentId,
                opportunityId: opportunityIdFromDto
            }
        });
        const priorReportStatus = report?.status ?? null;

        if (report) {
            // Update existing report
            report.status = 'submitted';
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
                studentId,
                opportunityId: opportunityIdFromDto,
                status: 'submitted',
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

        const submitStamp = new Date();
        report.reportSubmittedAt = submitStamp;
        report.submission_date = submitStamp;

        // Save report to get ID
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
            priorReportStatus == null || !skipAdminSubmitNotify.has(priorReportStatus);
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
            message: 'Report submitted successfully.',
            data: {
                report_id: report.id,
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

        let report = await this.studentReportsRepository.findOne({
            where: {
                studentId,
                opportunityId: parsedData.opportunityId
            }
        });

        const lockedReportStatuses = new Set([
            'submitted',
            'partner_verified',
            'payment_pending',
            'payment_under_review',
            'verified',
            'paid',
            'rejected',
        ]);

        if (report) {
            if (!lockedReportStatuses.has(report.status)) {
                report.status = 'draft';
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
                studentId,
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
                last_saved: report.updatedAt,
            },
        };
    }

    async findAll(query: any) {
        const { status, organizationId, studentId, page = 1, limit = 10 } = query;
        const skip = (page - 1) * limit;

        const whereClause: any = {};
        if (status) {
            whereClause.status = status;
        }
        if (organizationId) {
            whereClause.opportunity = { organizationId };
        }
        if (studentId) {
            whereClause.studentId = studentId;
        }

        const [reports, total] = await this.studentReportsRepository.findAndCount({
            where: whereClause,
            relations: ['student', 'opportunity', 'opportunity.organization'],
            skip,
            take: limit,
            order: { submission_date: 'DESC' },
        });

        return {
            success: true,
            data: reports.map(r => ({
                id: r.id,
                student_name: r.student?.name || 'Unknown',
                student_email: r.student?.email || 'Unknown',
                project_title: r.opportunity?.title || r.project_id,
                organization_name: r.opportunity?.organization?.name || 'N/A',
                status: r.status,
                partner_status: r.partner_status,
                admin_status: r.admin_status,
                submission_date: r.submission_date,
                report_submitted_at: r.reportSubmittedAt,
                partner_approved_at: r.partnerApprovedAt,
                admin_approved_at: r.adminApprovedAt,
                created_at: r.createdAt,
            })),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                total_pages: Math.ceil(total / limit),
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

        // Fetch attendance logs for this student and opportunity
        const attendanceLogs = await this.attendanceLogsRepository.find({
            where: {
                participant: { studentId: report.studentId },
                projectId: report.opportunityId
            },
            order: { dateOfEngagement: 'ASC', startTime: 'ASC' }
        });

        return await this.formatReportResponse(report, attendanceLogs);
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

        if (report) {
            console.log(`  - Match found by Primary Key (Report ID)`);
        }

        // If not found, try finding by opportunityId or project_id
        if (!report) {
            console.log(`  - Not found by Report ID. Searching by opportunityId or project_id...`);
            report = await this.studentReportsRepository.findOne({
                where: [
                    { opportunityId: id, studentId },
                    { project_id: id, studentId }
                ],
                relations: ['student', 'opportunity'],
                order: { createdAt: 'DESC' }
            });
        }

        if (report) {
            console.log(`  - Match found by Opportunity/Project ID`);
        }

        if (report) {
            const attendanceLogs = await this.attendanceLogsRepository.find({
                where: {
                    participant: { studentId: report.studentId },
                    projectId: report.opportunityId || report.project_id
                },
                order: { dateOfEngagement: 'ASC', startTime: 'ASC' }
            });
            return await this.formatReportResponse(report, attendanceLogs);
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
                        team_members: await this.engagementService.getProjectTeam(id),
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

    private async formatReportResponse(report: StudentReport, attendanceLogs?: AttendanceLog[]) {
        const projectKey = report.opportunityId || report.project_id;
        const latestPayment = await this.findLatestManualPayment(report.studentId, projectKey);
        const { status, payment_verified, ...paymentRest } = this.paymentDerivedFields(
            latestPayment,
            report.status,
        );

        return {
            success: true,
            data: {
                id: report.id,
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
                admin_status: report.admin_status,
                submission_date: report.submission_date,
                report_submitted_at: report.reportSubmittedAt,
                partner_approved_at: report.partnerApprovedAt,
                admin_approved_at: report.adminApprovedAt,
                section1: {
                    ...report.section1,
                    team_lead: report.section1?.team_lead ? {
                        ...report.section1.team_lead,
                        fullName: report.section1.team_lead.fullName || report.section1.team_lead.name || '',
                        cnic: this.engagementService.decryptCnicInternal(report.section1.team_lead.cnic)
                    } : undefined,
                    // Point 1 & 3: Dynamically fetch team members from the source of truth (Participants/Engagement table)
                    team_members: await this.engagementService.getProjectTeam(report.opportunityId || report.project_id),
                    attendance_logs: attendanceLogs ? attendanceLogs.map(log => ({
                        id: log.id,
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
                        assigned_approver_type: (log as any).assignedApproverType ?? null,
                        opportunity_creator_kind: (log as any).opportunityCreatorKind ?? null,
                    })) : (report.section1?.attendance_logs || [])
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
                admin_feedback: report.admin_feedback,
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

    async verifyReport(id: string, action: 'approve' | 'reject' | 'unlock', role: string = 'admin', reason?: string) {
        const report = await this.studentReportsRepository.findOne({ where: { id } });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        const decisionStamp = new Date();
        if (action === 'unlock') {
            report.status = 'draft';
            report.admin_status = 'pending';
            report.partner_status = 'pending';
            report.partnerApprovedAt = null;
            report.adminApprovedAt = null;
            if (reason) {
                report.admin_feedback = reason;
            }
        } else if (action === 'reject') {
            report.status = 'rejected';
            if (role === 'admin') report.admin_status = 'rejected';
            if (role === 'partner') report.partner_status = 'rejected';
            if (reason) {
                report.admin_feedback = reason; // Save feedback on reject as well (optional, but good practice based on user req)
            }
        } else if (action === 'approve') {
            if (role === 'partner') {
                report.partner_status = 'approved';
                report.partnerApprovedAt = decisionStamp;
                report.status = 'partner_verified';
            } else if (role === 'admin') {
                report.admin_status = 'approved';
                report.adminApprovedAt = decisionStamp;
                if (report.partner_status === 'approved') {
                    report.status = 'verified';
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
            // Find ALL reports for this student
            const reports = await this.studentReportsRepository.find({
                where: { studentId },
                relations: ['opportunity'],
                order: { createdAt: 'DESC' },
            });

            const oppIds = [...new Set(reports.map((r) => r.opportunityId).filter(Boolean))] as string[];
            const paymentByProject = new Map<string, Payment>();
            if (oppIds.length) {
                const pays = await this.paymentRepository.find({
                    where: { studentId, projectId: In(oppIds) },
                });
                pays.sort(
                    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
                );
                for (const p of pays) {
                    if (!paymentByProject.has(p.projectId)) {
                        paymentByProject.set(p.projectId, p);
                    }
                }
            }

            return {
                success: true,
                data: reports.map((r) => {
                    const projectKey = r.opportunityId || r.project_id;
                    const latest = projectKey ? paymentByProject.get(projectKey) : undefined;
                    const { status, payment_verified, ...paymentRest } = this.paymentDerivedFields(
                        latest,
                        r.status,
                    );
                    return {
                        status,
                        payment_verified,
                        ...paymentRest,
                        report_id: r.id,
                        project_id: r.project_id,
                        projectId: projectKey,
                        opportunity_id: r.opportunityId,
                        opportunity_title: r.opportunity?.title,
                        admin_status: r.admin_status,
                        partner_status: r.partner_status,
                        feedback: null,
                        submission_date: r.submission_date,
                        report_submitted_at: r.reportSubmittedAt,
                        partner_approved_at: r.partnerApprovedAt,
                        admin_approved_at: r.adminApprovedAt,
                    };
                }),
            };
        }

        // Existing logic for single check
        const report = await this.studentReportsRepository.findOne({
            where: {
                studentId,
                opportunityId,
            },
            order: { createdAt: 'DESC' },
        });

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

        const latest = await this.findLatestManualPayment(
            studentId,
            report.opportunityId || report.project_id,
        );
        const { status, payment_verified, ...paymentRest } = this.paymentDerivedFields(
            latest,
            report.status,
        );

        return {
            success: true,
            data: {
                status,
                payment_verified,
                ...paymentRest,
                report_id: report.id,
                project_id: report.project_id,
                projectId: report.opportunityId || report.project_id,
                opportunity_id: report.opportunityId,
                admin_status: report.admin_status,
                partner_status: report.partner_status,
                feedback: null,
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
}

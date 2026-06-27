import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { resolveAttendanceUnlockStatus, resolveParticipationForAttendanceUnlock } from '../engagement/attendance-unlock.util';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { EmailOtp } from '../auth/entities/email-otp.entity';
import { Otp } from '../students/entities/otp.entity';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import {
    filterSection1AnalyticsForStakeholder,
    sanitizeRestrictedValuesForStakeholder,
} from './section1-analytics.visibility';
import {
    Section1AnalyticsFieldValues,
    Section1AnalyticsRequestContext,
    Section1AnalyticsResponse,
    Section1AnalyticsStakeholder,
} from './section1-analytics.types';
import { Section1AnalyticsQueryDto } from './dto/section1-analytics-query.dto';
import { getProfileCompletionStatus } from '../users/profile-completion.util';

const ACTIVE_PARTICIPATION_STATUSES = [
    'pending',
    'pending_payment_approval',
    'paid',
    'pending_ciel_approval',
    'pending_faculty_approval',
    'approved',
    'verified',
    'accepted',
    'finalized',
];

const TEAM_VISIBILITY_STATUSES = [...ACTIVE_PARTICIPATION_STATUSES];

type DistributionRow = { label: string; count: number };

@Injectable()
export class Section1AnalyticsService {
    constructor(
        @InjectRepository(User) private readonly usersRepository: Repository<User>,
        @InjectRepository(Opportunity) private readonly opportunityRepository: Repository<Opportunity>,
        @InjectRepository(Participation)
        private readonly participationRepository: Repository<Participation>,
        @InjectRepository(AttendanceLog)
        private readonly attendanceLogsRepository: Repository<AttendanceLog>,
        @InjectRepository(StudentReport)
        private readonly studentReportRepository: Repository<StudentReport>,
        @InjectRepository(Organization)
        private readonly organizationsRepository: Repository<Organization>,
        @InjectRepository(EmailOtp) private readonly emailOtpRepository: Repository<EmailOtp>,
        @InjectRepository(Otp) private readonly otpRepository: Repository<Otp>,
        private readonly facultyUniversityScopeService: FacultyUniversityScopeService,
    ) {}

    resolveStakeholderFromRole(role: string, orgType?: string | null): Section1AnalyticsStakeholder {
        if (role === UserRole.SUPER_ADMIN) return 'ciel';
        if (role === UserRole.STUDENT) return 'student';
        if (role === UserRole.UNIVERSITY) return 'university';
        if (
            role === UserRole.NGO ||
            role === UserRole.CORPORATE ||
            role === UserRole.ORGANIZATION_ADMIN ||
            role === UserRole.PARTNER
        ) {
            const t = String(orgType || '').toLowerCase();
            if (t.includes('university')) return 'university';
            return 'partner';
        }
        if (role === UserRole.FACULTY) return 'university';
        return 'ciel';
    }

    async getSection1Analytics(
        requester: {
            id: string;
            role: string;
            organizationId?: string | null;
            orgType?: string | null;
        },
        query: Section1AnalyticsQueryDto,
        forcedStakeholder?: Section1AnalyticsStakeholder,
    ): Promise<Section1AnalyticsResponse> {
        let orgType = requester.orgType ?? null;
        if (!orgType && requester.organizationId) {
            const org = await this.organizationsRepository.findOne({
                where: { id: requester.organizationId },
                select: ['orgType'],
            });
            orgType = org?.orgType ?? null;
        }

        const stakeholder =
            forcedStakeholder ?? this.resolveStakeholderFromRole(requester.role, orgType);
        const scope =
            query.scope === 'aggregate' || (!query.project_id && stakeholder !== 'student')
                ? 'aggregate'
                : 'project';

        if (scope === 'project' && !query.project_id) {
            throw new BadRequestException('project_id is required for project-scoped Section 1 analytics');
        }

        const studentId =
            stakeholder === 'student'
                ? requester.id
                : (query.student_id || '').trim() || undefined;

        await this.assertAccess({
            stakeholder,
            scope,
            requesterUserId: requester.id,
            requesterRole: requester.role,
            organizationId: requester.organizationId,
            projectId: query.project_id,
            studentId,
            universityOrgId: requester.organizationId ?? undefined,
        });

        const rawValues =
            scope === 'project'
                ? await this.computeProjectMetrics(query.project_id!, studentId)
                : await this.computeAggregateMetrics(stakeholder, requester.organizationId ?? undefined, query);

        return this.buildResponse({
            stakeholder,
            scope,
            projectId: query.project_id,
            studentId,
            organizationId: requester.organizationId ?? undefined,
            rawValues,
        });
    }

    async getUnGovernmentSlice(slice: 'hec' | 'government' | 'un' = 'un'): Promise<Section1AnalyticsResponse> {
        const rawValues = await this.computeAggregateMetrics('un_government');
        const filtered = filterSection1AnalyticsForStakeholder(
            'un_government',
            sanitizeRestrictedValuesForStakeholder('un_government', rawValues),
        );

        return {
            success: true,
            data: {
                stakeholder: 'un_government',
                scope: 'aggregate',
                fields: {
                    slice,
                    ...filtered.fields,
                },
                meta: filtered.meta,
            },
        };
    }

    private buildResponse(input: {
        stakeholder: Section1AnalyticsStakeholder;
        scope: 'project' | 'aggregate';
        projectId?: string;
        studentId?: string;
        organizationId?: string;
        rawValues: Section1AnalyticsFieldValues;
    }): Section1AnalyticsResponse {
        const sanitized = sanitizeRestrictedValuesForStakeholder(input.stakeholder, input.rawValues);
        const { fields, meta } = filterSection1AnalyticsForStakeholder(input.stakeholder, sanitized);
        return {
            success: true,
            data: {
                stakeholder: input.stakeholder,
                scope: input.scope,
                project_id: input.projectId,
                student_id: input.studentId,
                organization_id: input.organizationId,
                fields,
                meta,
            },
        };
    }

    private async assertAccess(ctx: Section1AnalyticsRequestContext): Promise<void> {
        if (ctx.stakeholder === 'ciel') {
            if (ctx.requesterRole !== UserRole.SUPER_ADMIN) {
                throw new ForbiddenException('Admin access required for CIEL Section 1 analytics');
            }
            return;
        }

        if (ctx.scope === 'aggregate') {
            if (ctx.stakeholder === 'student') {
                throw new ForbiddenException('Students may only view their own project analytics');
            }
            if (ctx.stakeholder === 'partner' || ctx.stakeholder === 'university') {
                if (!ctx.organizationId) {
                    throw new ForbiddenException('Organization membership required');
                }
            }
            return;
        }

        const projectId = ctx.projectId!;
        const opportunity = await this.opportunityRepository.findOne({
            where: { id: projectId },
            relations: ['organization'],
        });
        if (!opportunity) {
            throw new NotFoundException('Project not found');
        }

        if (ctx.stakeholder === 'student') {
            const mine = await this.participationRepository.findOne({
                where: { studentId: ctx.requesterUserId, projectId },
            });
            if (!mine) {
                throw new ForbiddenException('You may only view analytics for your own projects');
            }
            return;
        }

        if (ctx.stakeholder === 'partner') {
            if (!ctx.organizationId || opportunity.organizationId !== ctx.organizationId) {
                const scopedIds =
                    await this.facultyUniversityScopeService.resolveOpportunityIdsForUniversityOrganization(
                        ctx.organizationId || '',
                    );
                if (!scopedIds.includes(projectId)) {
                    throw new ForbiddenException('You may only view analytics for linked projects');
                }
            }
            return;
        }

        if (ctx.stakeholder === 'university') {
            if (!ctx.organizationId) {
                throw new ForbiddenException('University organization required');
            }
            const participations = await this.loadUniversityScopedParticipations(ctx.organizationId);
            if (!participations.some((p) => p.projectId === projectId)) {
                throw new ForbiddenException('Project is outside your university analytics scope');
            }
        }
    }

    private async computeProjectMetrics(
        projectId: string,
        studentId?: string,
    ): Promise<Section1AnalyticsFieldValues> {
        const opportunity = await this.opportunityRepository.findOne({
            where: { id: projectId },
            relations: ['organization'],
        });
        if (!opportunity) {
            throw new NotFoundException('Project not found');
        }

        const participations = await this.participationRepository.find({
            where: { projectId, status: In(TEAM_VISIBILITY_STATUSES) },
            relations: ['student'],
        });

        const targetParticipations = studentId
            ? participations.filter((p) => p.studentId === studentId)
            : participations;

        const primaryParticipation =
            targetParticipations.find((p) => p.adminAttendanceEditable === true) ??
            targetParticipations[0] ??
            participations.find((p) => p.adminAttendanceEditable === true) ??
            participations[0];
        const studentUser = primaryParticipation?.studentId
            ? await this.usersRepository.findOne({
                  where: { id: primaryParticipation.studentId },
                  relations: ['organization'],
              })
            : null;

        const report = primaryParticipation?.studentId
            ? await this.studentReportRepository.findOne({
                  where: [
                      { studentId: primaryParticipation.studentId, opportunityId: projectId },
                      { studentId: primaryParticipation.studentId, project_id: projectId },
                  ],
                  order: { updatedAt: 'DESC' },
              })
            : null;

        const teamMembers = participations.filter((p) => {
            if (primaryParticipation?.participationMode !== 'team') return p.id === primaryParticipation?.id;
            if (primaryParticipation.teamId) return p.teamId === primaryParticipation.teamId;
            if (primaryParticipation.applicationId) {
                return p.applicationId === primaryParticipation.applicationId;
            }
            return p.projectId === projectId;
        });

        const verifiedHours = await this.sumVerifiedHours(projectId, primaryParticipation?.studentId);
        const requiredHours = this.resolveRequiredHours(opportunity);
        const section1 = report?.section1;
        const personalCompletion = studentUser ? this.computePersonalCompletion(studentUser) : null;
        const academicCompletion = primaryParticipation
            ? this.computeAcademicCompletion(primaryParticipation, studentUser)
            : null;
        const teamStats = this.computeTeamStats(teamMembers);
        const sectionSteps = this.computeSectionSteps(
            studentUser,
            primaryParticipation,
            teamStats,
            section1?.privacy_consent === true,
        );
        const identityStatus = this.resolveIdentityStatus(studentUser, primaryParticipation);
        const attendanceUnlock = this.resolveAttendanceUnlock(
            studentUser,
            primaryParticipation,
            teamStats,
            teamMembers,
        );
        const duplicateCnic = await this.countDuplicateCnicHashes(participations);
        const duplicateTeamMembers = this.countDuplicateTeamMembers(teamMembers);
        const redFlags = this.countRedFlags(
            studentUser,
            primaryParticipation,
            teamStats,
            duplicateCnic,
            duplicateTeamMembers,
        );

        const emailOtpSent = studentUser?.email
            ? await this.emailOtpRepository.count({ where: { email: studentUser.email.toLowerCase() } })
            : 0;
        const teamOtpSent = studentUser?.email
            ? await this.otpRepository.count({ where: { email: studentUser.email.toLowerCase() } })
            : 0;

        const auditReadyCount = await this.attendanceLogsRepository
            .createQueryBuilder('log')
            .where('log.projectId = :projectId', { projectId })
            .andWhere(`(log.approvalStatus = 'approved' OR log.entryStatus = 'verified')`)
            .getCount();

        const hecTrackingPercent =
            participations.length === 0
                ? 0
                : Math.round(
                      (100 *
                          participations.filter((p) => !p.attendanceLocked || p.attendanceVerificationRequested)
                              .length) /
                          participations.length,
                  );

        const section1Completion = Math.round(
            (sectionSteps.completed / Math.max(sectionSteps.total, 1)) * 100,
        );
        const readinessScore = Math.round(
            (personalCompletion?.percent ?? 0) * 0.3 +
                (academicCompletion?.percent ?? 0) * 0.25 +
                (teamStats.verificationRate ?? 0) * 0.2 +
                (identityStatus === 'verified' ? 100 : identityStatus === 'pending' ? 40 : 0) * 0.25,
        );

        const progressMode =
            verifiedHours < requiredHours ||
            section1Completion < 100 ||
            !attendanceUnlock.unlocked;

        return {
            project_title: opportunity.title,
            current_report_step: {
                current_step: sectionSteps.completed,
                total_steps: sectionSteps.total,
                percent: Math.round((sectionSteps.completed / Math.max(sectionSteps.total, 1)) * 100),
            },
            section_1_status: this.sectionStatus(section1Completion),
            progress_mode_status: progressMode ? 'Progress Mode' : 'Standard Mode',
            hours_status_in_header: {
                verified_hours: verifiedHours,
                required_hours: requiredHours,
                percent: requiredHours > 0 ? Math.min(100, Math.round((100 * verifiedHours) / requiredHours)) : 0,
            },
            institutional_purpose_acknowledged: {
                acknowledged: section1?.privacy_consent === true,
                percent: section1?.privacy_consent === true ? 100 : 0,
            },
            verified_participation_via_audit_ready_logs: {
                audit_ready_log_count: auditReadyCount,
                enabled: auditReadyCount > 0,
            },
            academic_linkage_to_official_student_records: {
                linked: Boolean(studentUser?.registrationNumber?.trim()),
                percent: studentUser?.registrationNumber?.trim() ? 100 : 0,
            },
            attendance_integrity_hec_compliant_tracking: {
                percent: hecTrackingPercent,
                projects_with_tracking: hecTrackingPercent > 0 ? 1 : 0,
                total_projects: 1,
            },
            individual_accountability_for_community_hours: {
                has_attendance_profile: verifiedHours > 0,
                percent: verifiedHours > 0 ? 100 : 0,
            },
            identity_verification_status: identityStatus,
            personal_info_tab_completion: personalCompletion,
            full_name_completion: {
                completed: Boolean(studentUser?.name?.trim()),
                count: studentUser?.name?.trim() ? 1 : 0,
            },
            cnic_completion: {
                completed: Boolean(studentUser?.cnic?.trim() || primaryParticipation?.cnicHash),
                masked_last4: primaryParticipation?.cnicLast4 ?? null,
                count: studentUser?.cnic?.trim() || primaryParticipation?.cnicHash ? 1 : 0,
            },
            duplicate_cnic_check: {
                duplicate_groups: duplicateCnic,
                has_duplicates: duplicateCnic > 0,
            },
            mobile_contact_completion: {
                completed: Boolean(primaryParticipation?.mobile?.trim() || studentUser?.phone?.trim()),
                count: primaryParticipation?.mobile?.trim() || studentUser?.phone?.trim() ? 1 : 0,
            },
            mobile_otp_verification_rate: {
                verified: primaryParticipation?.mobileVerified === true,
                percent: primaryParticipation?.mobileVerified ? 100 : 0,
            },
            email_completion_rate: {
                completed: Boolean(studentUser?.email?.trim()),
                percent: studentUser?.email?.trim() ? 100 : 0,
            },
            email_otp_sent_count: emailOtpSent + teamOtpSent,
            email_verification_rate: {
                verified: primaryParticipation?.emailVerified === true,
                percent: primaryParticipation?.emailVerified ? 100 : 0,
            },
            personal_identity_completion_rate: personalCompletion,
            university_institution_distribution: this.toDistribution([
                [
                    primaryParticipation?.universityName ||
                        studentUser?.university ||
                        studentUser?.institution ||
                        'Unspecified',
                    1,
                ],
            ]),
            student_id_cnic_link_completion: {
                linked: Boolean(studentUser?.registrationNumber?.trim() && (studentUser?.cnic || primaryParticipation?.cnicHash)),
                percent:
                    studentUser?.registrationNumber?.trim() && (studentUser?.cnic || primaryParticipation?.cnicHash)
                        ? 100
                        : 0,
            },
            degree_program_distribution: this.toDistribution([
                [primaryParticipation?.academicProgram || studentUser?.major || 'Unspecified', 1],
            ]),
            year_of_study_distribution: this.toDistribution([
                [primaryParticipation?.yearOfStudy || 'Unspecified', 1],
            ]),
            academic_integration_type_distribution: this.toDistribution([
                [primaryParticipation?.academicIntegrationType || 'Unspecified', 1],
            ]),
            course_linked_participation_count:
                primaryParticipation?.academicIntegrationType === 'Course-Linked' ? 1 : 0,
            academic_info_completion_rate: academicCompletion,
            verify_identity_link_record_button_status: this.verifyLinkButtonStatus(
                studentUser,
                primaryParticipation,
                personalCompletion,
                academicCompletion,
            ),
            identity_academic_record_linkage_rate: {
                linked:
                    identityStatus === 'verified' &&
                    Boolean(studentUser?.registrationNumber?.trim() || primaryParticipation?.universityName),
                percent:
                    identityStatus === 'verified' &&
                    Boolean(studentUser?.registrationNumber?.trim() || primaryParticipation?.universityName)
                        ? 100
                        : 0,
            },
            team_configuration_status: teamStats.configured ? 'Configured' : 'Not Configured',
            add_team_member_count: Math.max(0, teamStats.memberCount - 1),
            registered_ciel_users_added_rate: teamStats.registeredRate,
            team_member_count: teamStats.memberCount,
            team_member_university_distribution: teamStats.universityDistribution,
            team_member_role_distribution: teamStats.roleDistribution,
            active_contributor_count: teamStats.activeContributors,
            team_member_identity_verification_rate: {
                percent: teamStats.verificationRate,
                verified_members: teamStats.verifiedMembers,
                total_members: teamStats.memberCount,
            },
            average_team_size: teamStats.memberCount,
            fully_verified_team_count: teamStats.fullyVerified ? 1 : 0,
            team_verification_rate: {
                percent: teamStats.fullyVerified ? 100 : teamStats.verificationRate,
            },
            team_compliance_warning: teamStats.complianceWarning,
            configure_member_status: teamStats.memberStatuses,
            delete_member_action_count: 0,
            duplicate_team_member_check: {
                duplicate_groups: duplicateTeamMembers,
                has_duplicates: duplicateTeamMembers > 0,
            },
            attendance_logging_unlock_status: attendanceUnlock,
            section_1_completion_rate: {
                percent: section1Completion,
                completed_fields: sectionSteps.completed,
                required_fields: sectionSteps.total,
            },
            section_1_readiness_score: {
                score: readinessScore,
                breakdown: {
                    identity: personalCompletion?.percent ?? 0,
                    academic: academicCompletion?.percent ?? 0,
                    team: teamStats.verificationRate,
                    linkage: identityStatus === 'verified' ? 100 : 0,
                },
            },
            section_1_red_flag_count: redFlags,
        };
    }

    private async computeAggregateMetrics(
        stakeholder: Section1AnalyticsStakeholder,
        organizationId?: string,
        query?: Section1AnalyticsQueryDto,
    ): Promise<Section1AnalyticsFieldValues> {
        let participations: Participation[] = [];

        if (organizationId) {
            participations = await this.loadUniversityScopedParticipations(organizationId);
        } else {
            participations = await this.participationRepository
                .createQueryBuilder('p')
                .leftJoinAndSelect('p.student', 'student')
                .leftJoinAndSelect('p.project', 'project')
                .where('p.student_id IS NOT NULL')
                .andWhere('p.status IN (:...st)', { st: ACTIVE_PARTICIPATION_STATUSES })
                .getMany();
        }

        if (query?.university?.trim()) {
            const uni = query.university.trim().toLowerCase();
            participations = participations.filter(
                (p) => (p.universityName || p.student?.university || '').trim().toLowerCase() === uni,
            );
        }

        const projectIds = [...new Set(participations.map((p) => p.projectId))];
        const distinctStudents = [
            ...new Set(participations.map((p) => p.studentId).filter((id): id is string => Boolean(id))),
        ];

        let verifiedStudents = 0;
        if (distinctStudents.length > 0) {
            verifiedStudents = await this.usersRepository.count({
                where: {
                    id: In(distinctStudents),
                    profile_verified: true,
                    identity_verified: true,
                },
            });
        }

        const uniMap = new Map<string, number>();
        const degreeMap = new Map<string, number>();
        const yearMap = new Map<string, number>();
        const integrationMap = new Map<string, number>();
        let courseLinked = 0;
        let acknowledged = 0;
        let withAttendanceProfile = 0;
        let linkedRecords = 0;
        let mobileVerified = 0;
        let emailVerified = 0;
        let totalRequiredHours = 0;
        let totalVerifiedHours = 0;

        for (const p of participations) {
            const uni =
                (p.universityName || p.student?.university || p.student?.institution || 'Unspecified').trim() ||
                'Unspecified';
            uniMap.set(uni, (uniMap.get(uni) || 0) + 1);
            const deg = (p.academicProgram || p.student?.major || 'Unspecified').trim() || 'Unspecified';
            degreeMap.set(deg, (degreeMap.get(deg) || 0) + 1);
            const yr = (p.yearOfStudy || 'Unspecified').trim() || 'Unspecified';
            yearMap.set(yr, (yearMap.get(yr) || 0) + 1);
            const integ = (p.academicIntegrationType || 'Unspecified').trim() || 'Unspecified';
            integrationMap.set(integ, (integrationMap.get(integ) || 0) + 1);
            if (p.academicIntegrationType === 'Course-Linked') courseLinked += 1;
            if (p.mobileVerified) mobileVerified += 1;
            if (p.emailVerified) emailVerified += 1;
            if (p.student?.registrationNumber?.trim()) linkedRecords += 1;
            totalRequiredHours += this.resolveRequiredHours(p.project);
        }

        const reports = projectIds.length
            ? await this.studentReportRepository.find({
                  where: [{ opportunityId: In(projectIds) }, { project_id: In(projectIds) }],
              })
            : [];

        for (const r of reports) {
            if (r.section1?.privacy_consent) acknowledged += 1;
        }

        if (projectIds.length > 0) {
            const hoursRow = await this.attendanceLogsRepository
                .createQueryBuilder('log')
                .select('COALESCE(SUM(log.sessionHours), 0)', 'sum')
                .where('log.projectId IN (:...ids)', { ids: projectIds })
                .andWhere(`(log.approvalStatus = 'approved' OR log.entryStatus = 'verified')`)
                .getRawOne<{ sum: string }>();
            totalVerifiedHours = Number(hoursRow?.sum ?? 0) || 0;
            withAttendanceProfile = totalVerifiedHours > 0 ? distinctStudents.length : 0;
        }

        const total = participations.length || 1;
        const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));
        const teamGroups = this.groupTeams(participations);
        const teamSizes = [...teamGroups.values()].map((g) => g.length);
        const avgTeamSize =
            teamSizes.length === 0 ? 0 : Math.round((teamSizes.reduce((a, b) => a + b, 0) / teamSizes.length) * 10) / 10;

        const titles =
            participations.length > 0
                ? [...new Set(participations.map((p) => p.project?.title).filter(Boolean))]
                : [];

        return {
            project_title: stakeholder === 'un_government' ? { project_count: projectIds.length } : titles.slice(0, 25),
            current_report_step: {
                average_percent: pct(acknowledged, reports.length || 1),
                aggregated: true,
            },
            section_1_status: {
                completed_percent: pct(acknowledged, Math.max(reports.length, 1)),
                in_progress_percent: 100 - pct(acknowledged, Math.max(reports.length, 1)),
            },
            progress_mode_status: {
                progress_mode_count: reports.filter((r) => (r.section1?.metrics?.hec_compliance || '') !== 'meets')
                    .length,
            },
            hours_status_in_header: {
                verified_hours: Math.round(totalVerifiedHours * 10) / 10,
                required_hours: Math.round(totalRequiredHours * 10) / 10,
                percent: pct(totalVerifiedHours, totalRequiredHours || 1),
            },
            institutional_purpose_acknowledged: {
                students_acknowledged: acknowledged,
                total_students: Math.max(reports.length, participations.length),
                percent: pct(acknowledged, Math.max(reports.length, participations.length)),
            },
            verified_participation_via_audit_ready_logs: {
                projects_with_audit_ready_logs: projectIds.length > 0 ? projectIds.length : 0,
                total_projects: projectIds.length,
            },
            academic_linkage_to_official_student_records: {
                students_with_academic_link: linkedRecords,
                total_students: participations.length,
                percent: pct(linkedRecords, participations.length),
            },
            attendance_integrity_hec_compliant_tracking: {
                projects_with_tracking: projectIds.length,
                total_projects: projectIds.length,
                percent: projectIds.length > 0 ? 100 : 0,
            },
            individual_accountability_for_community_hours: {
                students_with_attendance_profile: withAttendanceProfile,
                total_students: participations.length,
                percent: pct(withAttendanceProfile, participations.length),
            },
            identity_verification_status: {
                verified_students: verifiedStudents,
                total_students: distinctStudents.length,
                percent: pct(verifiedStudents, distinctStudents.length),
            },
            personal_info_tab_completion: {
                percent: pct(mobileVerified + emailVerified, participations.length * 2 || 1),
            },
            mobile_otp_verification_rate: {
                students_mobile_verified: mobileVerified,
                total_students: participations.length,
                percent: pct(mobileVerified, participations.length),
            },
            email_verification_rate: {
                students_email_verified: emailVerified,
                total_students: participations.length,
                percent: pct(emailVerified, participations.length),
            },
            personal_identity_completion_rate: {
                percent: pct(verifiedStudents, distinctStudents.length),
            },
            university_institution_distribution: this.toDistribution([...uniMap.entries()]),
            degree_program_distribution: this.toDistribution([...degreeMap.entries()]),
            year_of_study_distribution: this.toDistribution([...yearMap.entries()]),
            academic_integration_type_distribution: this.toDistribution([...integrationMap.entries()]),
            course_linked_participation_count: courseLinked,
            academic_info_completion_rate: {
                percent: pct(
                    participations.filter((p) => p.academicProgram && p.yearOfStudy).length,
                    participations.length,
                ),
            },
            identity_academic_record_linkage_rate: {
                students_verified_and_linked: linkedRecords,
                total_students: participations.length,
                percent: pct(linkedRecords, participations.length),
            },
            team_configuration_status: {
                configured_teams: [...teamGroups.values()].filter((g) => g.length > 1).length,
                total_teams: teamGroups.size,
            },
            team_member_count: participations.length,
            team_member_university_distribution: this.toDistribution([...uniMap.entries()]),
            team_member_role_distribution: this.toDistribution(
                participations.map((p) => [p.isTeamLead ? 'Team Lead' : 'Team Member', 1]),
            ),
            active_contributor_count: participations.filter((p) => p.participationMode === 'team').length,
            average_team_size: avgTeamSize,
            team_verification_rate: {
                fully_verified_teams: [...teamGroups.values()].filter((g) =>
                    g.every((m) => m.student?.identity_verified && m.student?.profile_verified),
                ).length,
                total_teams: teamGroups.size,
                percent: pct(
                    [...teamGroups.values()].filter((g) =>
                        g.every((m) => m.student?.identity_verified && m.student?.profile_verified),
                    ).length,
                    teamGroups.size || 1,
                ),
            },
            team_compliance_warning: {
                warning_count: participations.filter((p) => !p.emailVerified || !p.mobileVerified).length,
            },
            attendance_logging_unlock_status: {
                unlocked_count: participations.filter((p) => !p.attendanceLocked).length,
                total: participations.length,
            },
            section_1_completion_rate: {
                percent: pct(acknowledged, Math.max(reports.length, 1)),
            },
            section_1_readiness_score: {
                score: pct(verifiedStudents, distinctStudents.length || 1),
            },
            section_1_red_flag_count: {
                audit_summary_only: true,
                flagged_enrollments: participations.filter((p) => !p.emailVerified || !p.mobileVerified).length,
            },
            institution_count: uniMap.size,
            total_participants: participations.length,
        };
    }

    private async loadUniversityScopedParticipations(orgId: string): Promise<Participation[]> {
        const org = await this.organizationsRepository.findOne({ where: { id: orgId } });
        if (!org) return [];
        const orgNameNorm = org.name.trim().toLowerCase();
        return this.participationRepository
            .createQueryBuilder('p')
            .leftJoinAndSelect('p.project', 'project')
            .leftJoinAndSelect('p.student', 'student')
            .where('p.student_id IS NOT NULL')
            .andWhere('p.status IN (:...st)', { st: ACTIVE_PARTICIPATION_STATUSES })
            .andWhere(
                new Brackets((b) => {
                    b.where(`TRIM(COALESCE(p.universityId, '')) = :orgId`, { orgId })
                        .orWhere(`project."organizationId"::text = :orgId`, { orgId })
                        .orWhere(`student."organizationId"::text = :orgId`, { orgId })
                        .orWhere(`LOWER(TRIM(COALESCE(p.universityName, ''))) = :orgNameNorm`, { orgNameNorm })
                        .orWhere(`LOWER(TRIM(COALESCE(student.university, ''))) = :orgNameNorm`, { orgNameNorm });
                }),
            )
            .getMany();
    }

    private resolveRequiredHours(project?: Opportunity | null): number {
        if (!project) return 0;
        const fromTimeline = Number(project.timeline?.expected_hours);
        if (Number.isFinite(fromTimeline) && fromTimeline > 0) return fromTimeline;
        const rh = Number(project.requiredHours);
        return Number.isFinite(rh) ? rh : 0;
    }

    private async sumVerifiedHours(projectId: string, studentId?: string | null): Promise<number> {
        const qb = this.attendanceLogsRepository
            .createQueryBuilder('log')
            .innerJoin('log.participant', 'part')
            .select('COALESCE(SUM(log.sessionHours), 0)', 'sum')
            .where('log.projectId = :projectId', { projectId })
            .andWhere(`(log.approvalStatus = 'approved' OR log.entryStatus = 'verified')`);
        if (studentId) {
            qb.andWhere('part.studentId = :studentId', { studentId });
        }
        const row = await qb.getRawOne<{ sum: string }>();
        return Number(row?.sum ?? 0) || 0;
    }

    private computePersonalCompletion(user: User | null): {
        percent: number;
        completed_required_fields: number;
        total_required_fields: number;
    } | null {
        if (!user) return null;
        const status = getProfileCompletionStatus(user);
        const total = status.profile_missing_fields.length + (status.profile_complete ? 6 : 0);
        const completed = status.profile_complete
            ? total
            : total - status.profile_missing_fields.length;
        const total_required_fields = Math.max(total, 1);
        const completed_required_fields = Math.max(completed, 0);
        return {
            completed_required_fields,
            total_required_fields,
            percent: Math.round((completed_required_fields / total_required_fields) * 100),
        };
    }

    private computeAcademicCompletion(
        participation: Participation | undefined,
        user: User | null,
    ): { percent: number; completed_required_fields: number; total_required_fields: number } | null {
        if (!participation) return null;
        const checks = [
            Boolean(participation.universityName || user?.university || user?.institution),
            Boolean(participation.academicProgram || user?.major),
            Boolean(participation.yearOfStudy),
            Boolean(participation.academicIntegrationType),
            Boolean(participation.department || user?.department),
        ];
        const completed = checks.filter(Boolean).length;
        return {
            completed_required_fields: completed,
            total_required_fields: checks.length,
            percent: Math.round((completed / checks.length) * 100),
        };
    }

    private computeTeamStats(members: Participation[]) {
        const memberCount = Math.max(members.length, 1);
        const verifiedMembers = members.filter(
            (m) => m.emailVerified && m.mobileVerified && m.student?.identity_verified,
        ).length;
        const registeredMembers = members.filter((m) => Boolean(m.studentId)).length;
        const activeContributors = members.filter((m) => !m.isTeamLead).length;
        const roleMap = new Map<string, number>();
        const uniMap = new Map<string, number>();
        for (const m of members) {
            const role = m.isTeamLead ? 'Team Lead' : 'Active Contributor';
            roleMap.set(role, (roleMap.get(role) || 0) + 1);
            const uni = (m.universityName || m.student?.university || 'Unspecified').trim() || 'Unspecified';
            uniMap.set(uni, (uniMap.get(uni) || 0) + 1);
        }
        const configured = members.length > 0 && (members[0].participationMode !== 'team' || members.length > 1);
        const fullyVerified = verifiedMembers === members.length && members.length > 0;
        const complianceWarning =
            members.some((m) => !m.emailVerified || !m.mobileVerified || !m.studentId) || false;
        return {
            memberCount,
            verifiedMembers,
            verificationRate: Math.round((verifiedMembers / memberCount) * 100),
            registeredRate: {
                registered_team_members: registeredMembers,
                total_team_members: memberCount,
                percent: Math.round((registeredMembers / memberCount) * 100),
            },
            activeContributors,
            roleDistribution: this.toDistribution([...roleMap.entries()]),
            universityDistribution: this.toDistribution([...uniMap.entries()]),
            configured,
            fullyVerified,
            complianceWarning: complianceWarning
                ? { active: true, message: 'One or more team members are unregistered or unverified.' }
                : { active: false },
            memberStatuses: members.map((m) => ({
                member_id: m.id,
                status: m.fullName && m.email ? 'Configured' : 'Pending',
            })),
        };
    }

    private computeSectionSteps(
        user: User | null,
        participation: Participation | undefined,
        teamStats: ReturnType<Section1AnalyticsService['computeTeamStats']>,
        privacyConsent: boolean,
    ) {
        const steps = [
            privacyConsent,
            Boolean(user?.name?.trim() && (user.phone || participation?.mobile)),
            Boolean(participation?.universityName || user?.university),
            participation?.participationMode !== 'team' || teamStats.configured,
            user?.identity_verified === true && user?.profile_verified === true,
        ];
        return {
            completed: steps.filter(Boolean).length,
            total: steps.length,
        };
    }

    private resolveIdentityStatus(
        user: User | null,
        participation: Participation | undefined,
    ): 'verified' | 'pending' | 'failed' {
        const cnicOk = Boolean(user?.cnic?.trim() || participation?.cnicHash);
        const mobileOk = participation?.mobileVerified === true;
        const emailOk = participation?.emailVerified === true;
        const profileOk = user?.profile_verified === true && user?.identity_verified === true;
        if (cnicOk && mobileOk && emailOk && profileOk) return 'verified';
        if (!cnicOk && !mobileOk && !emailOk) return 'failed';
        return 'pending';
    }

    private resolveAttendanceUnlock(
        user: User | null,
        participation: Participation | undefined,
        teamStats: ReturnType<Section1AnalyticsService['computeTeamStats']>,
        teamMembers: Participation[] = [],
    ) {
        const effective = resolveParticipationForAttendanceUnlock(participation, teamMembers);
        return resolveAttendanceUnlockStatus(user, effective, teamStats.configured);
    }

    private verifyLinkButtonStatus(
        user: User | null,
        participation: Participation | undefined,
        personal: ReturnType<Section1AnalyticsService['computePersonalCompletion']>,
        academic: ReturnType<Section1AnalyticsService['computeAcademicCompletion']>,
    ) {
        const enabled =
            (personal?.percent ?? 0) >= 100 &&
            (academic?.percent ?? 0) >= 100 &&
            this.resolveIdentityStatus(user, participation) !== 'failed';
        return {
            enabled,
            missing_fields: [
                ...(personal && personal.percent < 100 ? ['personal_info'] : []),
                ...(academic && academic.percent < 100 ? ['academic_info'] : []),
            ],
        };
    }

    private sectionStatus(percent: number): 'Completed' | 'In Progress' | 'Pending' {
        if (percent >= 100) return 'Completed';
        if (percent > 0) return 'In Progress';
        return 'Pending';
    }

    private toDistribution(entries: Array<[string, number]>): DistributionRow[] {
        return entries
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => b.count - a.count);
    }

    private async countDuplicateCnicHashes(participations: Participation[]): Promise<number> {
        const map = new Map<string, number>();
        for (const p of participations) {
            if (!p.cnicHash) continue;
            map.set(p.cnicHash, (map.get(p.cnicHash) || 0) + 1);
        }
        return [...map.values()].filter((c) => c > 1).length;
    }

    private countDuplicateTeamMembers(members: Participation[]): number {
        const map = new Map<string, number>();
        for (const m of members) {
            const key = m.studentId || m.email?.toLowerCase() || m.id;
            map.set(key, (map.get(key) || 0) + 1);
        }
        return [...map.values()].filter((c) => c > 1).length;
    }

    private countRedFlags(
        user: User | null,
        participation: Participation | undefined,
        teamStats: ReturnType<Section1AnalyticsService['computeTeamStats']>,
        duplicateCnic: number,
        duplicateTeam: number,
    ) {
        let count = 0;
        if (duplicateCnic > 0) count += 1;
        if (duplicateTeam > 0) count += 1;
        if (teamStats.complianceWarning.active) count += 1;
        if (!user?.email || !participation?.mobile) count += 1;
        if (this.resolveIdentityStatus(user, participation) === 'pending') count += 1;
        return { count, action_required: count > 0 };
    }

    private groupTeams(participations: Participation[]): Map<string, Participation[]> {
        const map = new Map<string, Participation[]>();
        for (const p of participations) {
            const key =
                p.participationMode === 'team'
                    ? p.teamId || p.applicationId || `solo:${p.studentId}`
                    : `ind:${p.studentId}`;
            const bucket = map.get(key) || [];
            bucket.push(p);
            map.set(key, bucket);
        }
        return map;
    }
}

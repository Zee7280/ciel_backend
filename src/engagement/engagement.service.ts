import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger, Optional } from '@nestjs/common';
import { IssueLogsService } from '../issue-logs/issue-logs.service';
import {
    ATTENDANCE_DESCRIPTION_MAX_CHARS,
    ATTENDANCE_DESCRIPTION_MAX_WORDS,
    MAX_DAILY_ATTENDANCE_HOURS,
    dailyAttendanceCapMessage,
} from './attendance-description.constants';
import { S3Service } from '../common/s3.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, In, IsNull, Repository } from 'typeorm';
import { Participation } from './entities/participant.entity';
import { demoteExtraTeamLeadsInScope } from './team-lead-canonical.util';
import { AttendanceLog } from './entities/attendance-log.entity';
import { RegisterParticipantDto } from './dto/register-participant.dto';
import { CreateAttendanceLogDto } from './dto/create-attendance-log.dto';
import { PatchAttendanceApprovalDto } from './dto/patch-attendance-approval.dto';
import { CreateAttendanceVerifyRequestDto } from './dto/create-attendance-verify-request.dto';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { WORKFLOW_STAGE } from '../opportunities/opportunity-workflow.service';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import {
    attendanceCountsTowardProgress,
    canUserActOnAttendanceQueue,
    extractPartnerContactEmailsForAttendance,
    getParticipantFacultyEmails,
    opportunityHasActionablePartnerForAttendance,
    resolveAttendanceApproverRouting,
    resolveEffectiveAttendanceApproverType,
} from './attendance-approver.util';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';
import * as crypto from 'crypto';

/** Roster rows partners/faculty need for attendance UI (exclude only rejected). Aligned with join-enrollment “active seat” statuses. */
const PROJECT_TEAM_VISIBILITY_STATUSES: readonly string[] = [
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
export class EngagementService {
    private readonly logger = new Logger(EngagementService.name);
    private readonly ALGORITHM = 'aes-256-cbc';
    private readonly KEY: Buffer;

    constructor(
        @InjectRepository(Participation)
        private participantRepository: Repository<Participation>,
        @InjectRepository(AttendanceLog)
        private attendanceLogRepository: Repository<AttendanceLog>,
        @InjectRepository(Opportunity)
        private opportunityRepository: Repository<Opportunity>,
        @InjectRepository(OpportunityApplication)
        private opportunityApplicationRepository: Repository<OpportunityApplication>,
        @InjectRepository(User)
        private userRepository: Repository<User>,
        private configService: ConfigService,
        private s3Service: S3Service,
        private mailService: MailService,
        @Optional() private readonly issueLogsService?: IssueLogsService,
    ) {
        const secret = this.configService.get<string>('ENCRYPTION_KEY') || 'default-secret-key-32-chars-long!!';
        this.KEY = crypto.scryptSync(secret, 'salt', 32);
    }

    /** Match participation rows regardless of stored email casing/whitespace. */
    private normalizeParticipantEmail(email?: string | null): string {
        return (email ?? '').trim().toLowerCase();
    }

    /**
     * Team seats approved before the student account existed are created with `student_id` NULL
     * (`preRegister(null, …)`). Link them once the real user logs in or signs up (idempotent).
     */
    async linkOrphanParticipationsByEmail(userId: string, email: string | null | undefined): Promise<number> {
        const norm = this.normalizeParticipantEmail(email);
        if (!norm || !userId) {
            return 0;
        }
        const res = await this.participantRepository
            .createQueryBuilder()
            .update(Participation)
            .set({ studentId: userId })
            .where('student_id IS NULL')
            .andWhere('LOWER(TRIM(COALESCE(email, \'\'))) = :norm', { norm })
            .execute();
        const n = typeof res.affected === 'number' ? res.affected : 0;
        if (n > 0) {
            this.logger.log(`Linked ${n} orphan participation row(s) to student ${userId} (${norm})`);
        }
        return n;
    }

    async preRegister(studentId: string | null, projectId: string, data: Partial<Participation>) {
        const opportunity = await this.opportunityRepository.findOne({ where: { id: projectId } });
        if (!opportunity) throw new NotFoundException('Project not found');

        const normalizedEmailLookup = data.email ? this.normalizeParticipantEmail(data.email) : '';

        // Check if already registered
        let existing;
        if (studentId) {
            existing = await this.participantRepository.findOne({
                where: { studentId, projectId: opportunity.id },
            });
        } else if (normalizedEmailLookup) {
            existing = await this.participantRepository
                .createQueryBuilder('p')
                .where('p.projectId = :projectId', { projectId: opportunity.id })
                .andWhere('LOWER(TRIM(COALESCE(p.email, \'\'))) = :emailNorm', {
                    emailNorm: normalizedEmailLookup,
                })
                .getOne();
        }

        // Try lookup by CNIC if still not found
        if (!existing && data.cnic) {
            const normalizedCnic = (data.cnic || '').replace(/\D/g, '');
            const cnicHash = this.hashString(normalizedCnic);
            existing = await this.participantRepository.findOne({
                where: { cnicHash, projectId: opportunity.id }
            });
        }

        // Same student, different apply email — avoid a second seat (Ryan / Hassan duplicate rows).
        if (!existing && normalizedEmailLookup) {
            const account = await this.userRepository
                .createQueryBuilder('user')
                .where('LOWER(TRIM(user.email)) = :emailNorm', { emailNorm: normalizedEmailLookup })
                .getOne();
            const resolvedStudentId = studentId ?? account?.id ?? null;
            if (resolvedStudentId) {
                existing = await this.participantRepository.findOne({
                    where: { studentId: resolvedStudentId, projectId: opportunity.id },
                });
            }
        }

        // Never overwrite another account's row when email matched a ghost duplicate seat.
        if (existing && studentId && existing.studentId && existing.studentId !== studentId) {
            const ownSeat = await this.participantRepository.findOne({
                where: { studentId, projectId: opportunity.id },
            });
            existing = ownSeat ?? undefined;
        }
        if (existing && !studentId && normalizedEmailLookup) {
            const emailOwner = await this.userRepository
                .createQueryBuilder('user')
                .where('LOWER(TRIM(user.email)) = :emailNorm', { emailNorm: normalizedEmailLookup })
                .getOne();
            if (
                emailOwner?.id &&
                existing.studentId &&
                existing.studentId !== emailOwner.id
            ) {
                const ownSeat = await this.participantRepository.findOne({
                    where: { studentId: emailOwner.id, projectId: opportunity.id },
                });
                existing = ownSeat ?? undefined;
            }
        }

        if (existing) {
            // Update existing record if new info is provided
            Object.assign(existing, {
                ...data,
                ...(normalizedEmailLookup ? { email: normalizedEmailLookup } : {}),
                emailVerified: true,
                mobileVerified: true,
            });

            // Ensure studentId is linked if it was missing but is provided now
            if (!existing.studentId && studentId) {
                existing.studentId = studentId;
                this.logger.log(`Linked existing participation ${existing.id} to student ${studentId} during pre-registration`);
            }

            if (data.cnic) {
                const normalizedCnic = (data.cnic || '').replace(/\D/g, '');
                existing.cnicHash = this.hashString(normalizedCnic);
                existing.cnic = this.encrypt(normalizedCnic);
                existing.cnicLast4 = normalizedCnic.slice(-4);
            }
            const saved = await this.participantRepository.save(existing);
            if (saved.isTeamLead) {
                await demoteExtraTeamLeadsInScope(
                    this.participantRepository,
                    opportunity.id,
                    { teamId: saved.teamId, applicationId: saved.applicationId },
                    saved.id,
                );
            }
            return this.decryptParticipation(saved);
        }

        const participationData: any = {
            ...data,
            ...(normalizedEmailLookup ? { email: normalizedEmailLookup } : {}),
            projectId: opportunity.id,
            status: data.status || 'approved',
            emailVerified: true,
            mobileVerified: true,
        };

        if (studentId) {
            participationData.studentId = studentId;
        }

        if (participationData.studentId) {
            const clash = await this.participantRepository.findOne({
                where: {
                    studentId: participationData.studentId,
                    projectId: opportunity.id,
                },
            });
            if (clash) {
                Object.assign(clash, {
                    ...data,
                    ...(normalizedEmailLookup ? { email: normalizedEmailLookup } : {}),
                    emailVerified: true,
                    mobileVerified: true,
                });
                if (data.cnic) {
                    const normalizedCnic = (data.cnic || '').replace(/\D/g, '');
                    clash.cnicHash = this.hashString(normalizedCnic);
                    clash.cnic = this.encrypt(normalizedCnic);
                    clash.cnicLast4 = normalizedCnic.slice(-4);
                }
                const saved = await this.participantRepository.save(clash);
                return this.decryptParticipation(saved);
            }
        }

        const participation = this.participantRepository.create(participationData as Partial<Participation>);

        if (data.cnic) {
            const normalizedCnic = (data.cnic || '').replace(/\D/g, '');
            participation.cnicHash = this.hashString(normalizedCnic);
            participation.cnic = this.encrypt(normalizedCnic);
            participation.cnicLast4 = normalizedCnic.slice(-4);
        }

        const saved = await this.participantRepository.save(participation);
        if (saved.isTeamLead) {
            await demoteExtraTeamLeadsInScope(
                this.participantRepository,
                opportunity.id,
                { teamId: saved.teamId, applicationId: saved.applicationId },
                saved.id,
            );
        }
        return this.decryptParticipation(saved);
    }

    async registerParticipant(studentId: string, dto: RegisterParticipantDto) {
        return await this.participantRepository.manager.transaction(async (manager) => {
            const dtoEmailNorm = this.normalizeParticipantEmail(dto.email);
            const isTeamMemberRegistration =
                dto.participationMode === 'team' && dto.isTeamLead !== true;

            let targetStudentId: string | null = dto.studentId || null;
            if (!targetStudentId && dtoEmailNorm) {
                const userByEmail = await manager
                    .createQueryBuilder(User, 'user')
                    .where('LOWER(TRIM(user.email)) = :emailNorm', { emailNorm: dtoEmailNorm })
                    .getOne();
                targetStudentId = userByEmail?.id || null;
            }

            if (!targetStudentId) {
                targetStudentId = isTeamMemberRegistration ? null : studentId;
            }

            // Lead logged in while registering a teammate must not attach seat to the lead account.
            if (isTeamMemberRegistration && targetStudentId === studentId) {
                targetStudentId = null;
            }

            const opportunity = await manager.findOne(Opportunity, { where: { id: dto.projectId } });
            if (!opportunity) throw new NotFoundException('Project not found');
            if (opportunity.status !== 'active' || !opportunity.admin_approved) {
                throw new BadRequestException('This project is not open for applications yet');
            }

            // 1. Check if this CNIC is already used in this project
            const normalizedCnic = (dto.cnic || '').replace(/\D/g, '');
            const cnicHash = this.hashString(normalizedCnic);
            const existingByCnic = await manager.findOne(Participation, {
                where: { cnicHash, projectId: opportunity.id }
            });

            // 2. Check if a record already exists for THIS user/email in this project
            let existingByTarget: Participation | null = null;

            // Try by email (normalized; avoids duplicate rows when casing differs)
            if (dtoEmailNorm) {
                existingByTarget = await manager
                    .createQueryBuilder(Participation, 'p')
                    .where('p.projectId = :projectId', { projectId: opportunity.id })
                    .andWhere('LOWER(TRIM(COALESCE(p.email, \'\'))) = :emailNorm', { emailNorm: dtoEmailNorm })
                    .orderBy('p.createdAt', 'DESC')
                    .getOne();
            }

            // Same student account, different apply email — reuse seat (Hassan / Ryan duplicate rows).
            let existingByStudent: Participation | null = null;
            if (targetStudentId) {
                existingByStudent = await manager.findOne(Participation, {
                    where: { studentId: targetStudentId, projectId: opportunity.id },
                });
            }
            if (
                existingByStudent &&
                (!existingByTarget || existingByTarget.id !== existingByStudent.id)
            ) {
                if (
                    existingByTarget &&
                    existingByTarget.id !== existingByStudent.id &&
                    existingByTarget.studentId &&
                    existingByTarget.studentId !== targetStudentId &&
                    existingByTarget.studentId !== existingByStudent.studentId
                ) {
                    // Do not delete another student's enrollment when collapsing duplicate lead seats.
                    existingByTarget = existingByStudent;
                } else if (existingByTarget && existingByTarget.id !== existingByStudent.id) {
                    this.logger.log(
                        `Merging duplicate email seat ${existingByTarget.id} into student seat ${existingByStudent.id} on project ${opportunity.id}`,
                    );
                    existingByStudent.applicationId =
                        existingByStudent.applicationId || existingByTarget.applicationId;
                    existingByStudent.teamId = existingByStudent.teamId || existingByTarget.teamId;
                    await manager.remove(Participation, existingByTarget);
                    existingByTarget = null;
                } else {
                    existingByTarget = existingByStudent;
                }
            }

            // Team: a new member must not reuse the team lead's row (e.g. lead's email sent again by mistake)
            if (
                dto.participationMode === 'team' &&
                !dto.isTeamLead &&
                existingByTarget?.isTeamLead
            ) {
                throw new BadRequestException(
                    'This email is already used by the team lead on this project. Each member must register with their own email address.',
                );
            }

            // Same CNIC on the project must belong to the same email; otherwise we would overwrite another member
            if (existingByCnic) {
                const cnicRowEmail = (existingByCnic.email || '').toLowerCase().trim();
                if (cnicRowEmail !== dtoEmailNorm) {
                    throw new BadRequestException(
                        'This CNIC is already registered on this project under a different email. Use each member\'s own CNIC and email.',
                    );
                }
            }

            if (existingByCnic && existingByCnic.studentId && existingByCnic.studentId !== targetStudentId) {
                this.logger.log(`Found CNIC match for student ${existingByCnic.studentId}, will merge with target student ${targetStudentId}`);
            }

            let participation: Participation;

            // RECONCILIATION LOGIC:
            if (existingByCnic) {
                participation = existingByCnic;
                
                // If we also had a target record that was separate, 
                // merge its non-empty fields and delete it.
                if (existingByTarget && existingByTarget.id !== participation.id) {
                    const sameAccount =
                        !existingByTarget.studentId ||
                        !participation.studentId ||
                        existingByTarget.studentId === participation.studentId ||
                        (targetStudentId != null && existingByTarget.studentId === targetStudentId);
                    if (sameAccount) {
                        this.logger.log(`Merging duplicate records for student ${targetStudentId}: KEEPING ${participation.id}, REMOVING ${existingByTarget.id}`);
                    
                        participation.applicationId = participation.applicationId || existingByTarget.applicationId;
                        participation.teamId = participation.teamId || existingByTarget.teamId;
                        participation.participationMode = participation.participationMode || existingByTarget.participationMode;
                    
                        await manager.remove(Participation, existingByTarget);
                    }
                }
            } else if (existingByTarget) {
                participation = existingByTarget;
            } else if (targetStudentId) {
                const existingStudentSeat = await manager.findOne(Participation, {
                    where: { studentId: targetStudentId, projectId: opportunity.id },
                });
                participation =
                    existingStudentSeat ??
                    manager.create(Participation, {
                        projectId: opportunity.id,
                        status: 'pending',
                    });
            } else {
                participation = manager.create(Participation, {
                    projectId: opportunity.id,
                    status: 'pending',
                });
            }

            // Apply all DTO fields
            const normalizedCnicForStorage = (dto.cnic || '').replace(/\D/g, '');
            // Auto-approve on self-serve register so students can log attendance immediately (same as team non-lead path).
            const registrationStatus = 'approved';
            const primaryFacultyEmail = this.normalizeOptionalEmail(
                dto.primaryFacultyEmail || dto.primary_faculty_email,
            );
            const secondaryFacultyEmail = this.normalizeOptionalEmail(
                dto.secondaryFacultyEmail || dto.secondary_faculty_email,
            );
            const teamId = this.normalizeOptionalString(dto.teamId || dto.team_id);
            const effectiveTeamId =
                (await this.resolveTeamIdForRegistration(
                    manager,
                    participation,
                    opportunity.id,
                    targetStudentId,
                    teamId,
                )) ||
                (dto.participationMode === 'team' && dto.isTeamLead
                    ? this.generateTeamId()
                    : undefined);
            const facultyFields: Partial<Participation> = {};
            if (primaryFacultyEmail) {
                facultyFields.primaryFacultyEmail = primaryFacultyEmail;
            }
            if (secondaryFacultyEmail) {
                facultyFields.secondaryFacultyEmail = secondaryFacultyEmail;
            }
            const teamFields: Partial<Participation> = {};
            if (effectiveTeamId) {
                teamFields.teamId = effectiveTeamId;
            }
            const { primary_faculty_email, secondary_faculty_email, team_id, ...registrationFields } = dto;

            if (dto.participationMode === 'team' && dto.isTeamLead) {
                if (!effectiveTeamId) {
                    throw new BadRequestException(
                        'A team ID is required to register as team lead. Use the team link from your approved application.',
                    );
                }
                const conflictingLead = await manager
                    .createQueryBuilder(Participation, 'p')
                    .where('p.projectId = :projectId', { projectId: opportunity.id })
                    .andWhere('p.teamId = :teamId', { teamId: effectiveTeamId })
                    .andWhere('p.isTeamLead = true')
                    .andWhere('p.id != :keepId', { keepId: participation.id })
                    .getOne();
                if (conflictingLead) {
                    throw new BadRequestException(
                        'This team already has a team lead on this project. Register as a team member instead.',
                    );
                }
            }

            Object.assign(participation, {
                ...registrationFields,
                ...facultyFields,
                ...teamFields,
                ...(dtoEmailNorm ? { email: dtoEmailNorm } : {}),
                studentId: targetStudentId || participation.studentId,
                cnicHash,
                cnic: this.encrypt(normalizedCnicForStorage),
                cnicLast4: normalizedCnicForStorage.slice(-4),
                emailVerified: true,
                mobileVerified: true,
                status: registrationStatus,
            });

            const saved = await manager.save(Participation, participation);
            if (saved.isTeamLead) {
                const savedTeamId = (saved.teamId || '').trim();
                const savedApplicationId = (saved.applicationId || '').trim();
                if (savedTeamId || savedApplicationId) {
                    const demoteQb = manager
                        .createQueryBuilder(Participation, 'p')
                        .where('p.projectId = :projectId', { projectId: opportunity.id })
                        .andWhere('p.isTeamLead = true')
                        .andWhere('p.id != :keepId', { keepId: saved.id });
                    if (savedTeamId) {
                        demoteQb.andWhere('p.teamId = :teamId', { teamId: savedTeamId });
                    } else {
                        demoteQb.andWhere('p.applicationId = :applicationId', {
                            applicationId: savedApplicationId,
                        });
                    }
                    const others = await demoteQb.getMany();
                    for (const row of others) {
                        row.isTeamLead = false;
                        await manager.save(Participation, row);
                    }
                }
            }
            this.logger.log(`Participation ${saved.id} successfully PERSISTED within transaction for student ${targetStudentId || 'Guest'}`);
            
            // 3. Trigger Faculty Emails (Post-save within transaction, though ideally should be after commit)
            if (primaryFacultyEmail || secondaryFacultyEmail) {
                const studentName = targetStudentId 
                    ? (await manager.findOne(User, { where: { id: targetStudentId } }))?.name || dto.fullName
                    : dto.fullName;

                if (primaryFacultyEmail) {
                    try {
                        await this.mailService.sendFacultyApprovalRequest(
                            primaryFacultyEmail,
                            studentName,
                            opportunity.title,
                            saved.id
                        );
                    } catch (error) {
                        this.logger.error(`Failed to send faculty approval request to ${primaryFacultyEmail}`, error.stack);
                    }
                }

                if (secondaryFacultyEmail) {
                    try {
                        await this.mailService.sendFacultyCollaboratorNotice(
                            secondaryFacultyEmail,
                            studentName,
                            opportunity.title
                        );
                    } catch (error) {
                        this.logger.error(`Failed to send faculty collaborator notice to ${secondaryFacultyEmail}`, error.stack);
                    }
                }
            }

            return this.decryptParticipation(saved);
        });
    }


    async getMyParticipants(studentId: string) {
        const result = await this.participantRepository.find({
            where: { studentId },
            relations: ['attendanceLogs']
        });
        const projectIds = Array.from(new Set(result.map((p) => p.projectId).filter(Boolean)));
        const projectParticipants = projectIds.length
            ? await this.participantRepository.find({
                where: {
                    projectId: In(projectIds),
                    status: In(['approved', 'finalized', 'pending_ciel_approval']),
                },
                order: { createdAt: 'ASC' },
            })
            : [];
        const participantsByProject = new Map<string, Participation[]>();
        for (const participant of projectParticipants) {
            if (!participantsByProject.has(participant.projectId)) {
                participantsByProject.set(participant.projectId, []);
            }
            participantsByProject.get(participant.projectId)!.push(participant);
        }

        return Promise.all(
            result.map((p) =>
                this.enrichParticipationForTeamResponse(
                    this.decryptParticipation(p),
                    participantsByProject.get(p.projectId) || [],
                ),
            ),
        );
    }

    /** Degree / program line for report dossiers (participation row + linked student profile). */
    private resolveParticipationProgramLine(p: Participation): string {
        const student = p.student as User | undefined;
        const prog = (p.academicProgram || '').trim();
        const dept = (p.department || '').trim();
        const major = (student?.major || '').trim();
        const userDept = (student?.department || '').trim();
        const base = prog || dept || major || userDept;
        const year = (p.yearOfStudy || '').trim();
        if (base && year) return `${base} · ${year}`;
        if (base) return base;
        return year;
    }

    private mapParticipationForReportRoster(
        participation: Participation,
        enriched: Record<string, unknown>,
    ): Record<string, unknown> {
        const programLine = this.resolveParticipationProgramLine(participation);
        const student = participation.student as User | undefined;
        const degreeBase =
            (participation.academicProgram || '').trim() ||
            (student?.major || '').trim() ||
            (participation.department || '').trim() ||
            (student?.department || '').trim() ||
            '';
        return {
            ...enriched,
            program: programLine,
            academicProgram: participation.academicProgram || degreeBase || null,
            academic_program: participation.academicProgram || degreeBase || null,
            department: participation.department || student?.department || null,
            degree: degreeBase || undefined,
            year: participation.yearOfStudy || undefined,
            yearOfStudy: participation.yearOfStudy || undefined,
            academicIntegrationType: participation.academicIntegrationType || null,
            academic_integration_type: participation.academicIntegrationType || null,
            universityId: participation.universityId || null,
            university_id: participation.universityId || null,
            emailVerified: participation.emailVerified,
            email_verified: participation.emailVerified,
            mobileVerified: participation.mobileVerified,
            mobile_verified: participation.mobileVerified,
            facultySupervisorEmail: participation.facultySupervisorEmail || null,
            faculty_supervisor_email: participation.facultySupervisorEmail || null,
            registrationNumber: student?.registrationNumber || null,
            registration_number: student?.registrationNumber || null,
            participationMode: participation.participationMode,
            participation_mode: participation.participationMode,
            adminAttendanceEditable: participation.adminAttendanceEditable === true,
            admin_attendance_editable: participation.adminAttendanceEditable === true,
            attendanceLocked: participation.attendanceLocked === true,
            attendance_locked: participation.attendanceLocked === true,
            attendanceVerificationRequested: participation.attendanceVerificationRequested === true,
            attendance_verification_requested: participation.attendanceVerificationRequested === true,
        };
    }

    /**
     * Report verify / dossier roster: one participations query, no per-member application lookups.
     */
    async getProjectTeamForReportDossier(projectId: string) {
        const participants = await this.participantRepository.find({
            where: {
                projectId,
                status: In([...PROJECT_TEAM_VISIBILITY_STATUSES]),
            },
            relations: ['student'],
            order: { createdAt: 'ASC' },
        });
        const mapped = participants.map((p) => {
            const decrypted = this.decryptParticipation(p);
            const enriched = this.enrichParticipationForReportDossier(decrypted, participants);
            return this.mapParticipationForReportRoster(decrypted, enriched);
        });
        return this.dedupeProjectTeamRosterRows(mapped);
    }

    /** Engagement UI team list; resolves application faculty emails only when missing on rows. */
    async getProjectTeam(projectId: string) {
        const participants = await this.participantRepository.find({
            where: {
                projectId,
                status: In([...PROJECT_TEAM_VISIBILITY_STATUSES]),
            },
            relations: ['student'],
            order: { createdAt: 'ASC' },
        });
        const mapped = await Promise.all(
            participants.map(async (p) => {
                const decrypted = this.decryptParticipation(p);
                const enriched = await this.enrichParticipationForTeamResponse(decrypted, participants);
                return this.mapParticipationForReportRoster(decrypted, enriched);
            }),
        );
        return this.dedupeProjectTeamRosterRows(mapped);
    }

    /** Remove ghost duplicate seats (same email/student as team lead but non-lead row). */
    private dedupeProjectTeamRosterRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
        const leadEmailsByTeam = new Map<string, Set<string>>();
        const leadStudentIdsByTeam = new Map<string, Set<string>>();
        for (const row of rows) {
            if (row.isTeamLead !== true && row.is_team_lead !== true) continue;
            const teamKey = String(row.teamId ?? row.team_id ?? row.applicationId ?? 'default');
            const em = String(row.email ?? '').trim().toLowerCase();
            const sid = String(row.studentId ?? row.student_id ?? '').trim();
            if (em) {
                if (!leadEmailsByTeam.has(teamKey)) leadEmailsByTeam.set(teamKey, new Set());
                leadEmailsByTeam.get(teamKey)!.add(em);
            }
            if (sid) {
                if (!leadStudentIdsByTeam.has(teamKey)) leadStudentIdsByTeam.set(teamKey, new Set());
                leadStudentIdsByTeam.get(teamKey)!.add(sid);
            }
        }

        const seen = new Set<string>();
        const out: Record<string, unknown>[] = [];
        for (const row of rows) {
            const teamKey = String(row.teamId ?? row.team_id ?? row.applicationId ?? 'default');
            const em = String(row.email ?? '').trim().toLowerCase();
            const sid = String(row.studentId ?? row.student_id ?? '').trim();
            const isLead = row.isTeamLead === true || row.is_team_lead === true;
            if (!isLead) {
                const leadEmails = leadEmailsByTeam.get(teamKey);
                const leadStudentIds = leadStudentIdsByTeam.get(teamKey);
                if (em && leadEmails?.has(em)) continue;
                if (sid && leadStudentIds?.has(sid)) continue;
            }
            const dedupeKey = sid
                ? `s:${sid}:${teamKey}`
                : em
                  ? `e:${em}:${teamKey}`
                  : `id:${String(row.id ?? row.participantId ?? '')}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            out.push(row);
        }
        return out;
    }

    /** In-memory faculty/team fields for report dossiers (no opportunity_application queries). */
    private enrichParticipationForReportDossier(
        participation: Participation,
        projectParticipants: Participation[],
    ): Record<string, unknown> {
        const projectRows = projectParticipants.length ? projectParticipants : [participation];
        const teamLeads = projectRows.filter((p) => p.isTeamLead);
        const fallbackLead = this.findFallbackTeamLead(participation, teamLeads);
        const responseTeamId = this.resolveResponseTeamId(participation, fallbackLead, teamLeads);
        const participantEmails = getParticipantFacultyEmails(participation);
        const facultyEmails = this.normalizeEmailList(
            participantEmails.length
                ? participantEmails
                : getParticipantFacultyEmails(fallbackLead || {}),
        );

        return {
            ...participation,
            teamId: participation.teamId || responseTeamId,
            team_id: participation.teamId || responseTeamId,
            primaryFacultyEmail: participation.primaryFacultyEmail || facultyEmails[0] || null,
            secondaryFacultyEmail: participation.secondaryFacultyEmail || facultyEmails[1] || null,
            facultyEmail:
                facultyEmails[0] || participation.primaryFacultyEmail || participation.facultySupervisorEmail || null,
            primary_faculty_email: participation.primaryFacultyEmail || facultyEmails[0] || null,
            secondary_faculty_email: participation.secondaryFacultyEmail || facultyEmails[1] || null,
        };
    }

    private async enrichParticipationForTeamResponse(
        participation: Participation,
        projectParticipants: Participation[],
    ) {
        const projectRows = projectParticipants.length ? projectParticipants : [participation];
        const teamLeads = projectRows.filter((p) => p.isTeamLead);
        const fallbackLead = this.findFallbackTeamLead(participation, teamLeads);
        const responseTeamId = this.resolveResponseTeamId(participation, fallbackLead, teamLeads);
        const participantEmails = getParticipantFacultyEmails(participation);
        const fallbackEmails = getParticipantFacultyEmails(fallbackLead || {});
        let facultyEmails: string[];
        if (participantEmails.length) {
            facultyEmails = participantEmails;
        } else if (fallbackEmails.length) {
            facultyEmails = fallbackEmails;
        } else {
            facultyEmails = [
                ...(await this.resolveApplicationFacultyEmails(participation)),
                ...fallbackEmails,
            ];
        }
        const uniqueFacultyEmails = this.normalizeEmailList(facultyEmails);

        return {
            ...participation,
            teamId: participation.teamId || responseTeamId,
            team_id: participation.teamId || responseTeamId,
            primaryFacultyEmail: participation.primaryFacultyEmail || uniqueFacultyEmails[0] || null,
            secondaryFacultyEmail: participation.secondaryFacultyEmail || uniqueFacultyEmails[1] || null,
            facultyEmail: uniqueFacultyEmails[0] || participation.primaryFacultyEmail || participation.facultySupervisorEmail || null,
            primary_faculty_email: participation.primaryFacultyEmail || uniqueFacultyEmails[0] || null,
            secondary_faculty_email: participation.secondaryFacultyEmail || uniqueFacultyEmails[1] || null,
        };
    }

    private findFallbackTeamLead(participation: Participation, teamLeads: Participation[]): Participation | undefined {
        const matchingLead = teamLeads.find((lead) =>
            lead.id !== participation.id &&
            (
                (Boolean(participation.applicationId) && lead.applicationId === participation.applicationId) ||
                (Boolean(participation.teamId) && lead.teamId === participation.teamId)
            ),
        );
        if (matchingLead) {
            return matchingLead;
        }

        if (!participation.applicationId && !participation.teamId && teamLeads.length === 1) {
            return teamLeads[0];
        }

        return undefined;
    }

    private resolveResponseTeamId(
        participation: Participation,
        fallbackLead: Participation | undefined,
        teamLeads: Participation[],
    ): string | null {
        if (participation.teamId) return participation.teamId;
        if (participation.applicationId) return participation.applicationId;
        if (participation.isTeamLead) return participation.id;
        if (fallbackLead?.teamId) return fallbackLead.teamId;
        if (fallbackLead?.applicationId) return fallbackLead.applicationId;
        if (fallbackLead?.id) return fallbackLead.id;
        if (teamLeads.length === 1) return teamLeads[0].teamId || teamLeads[0].applicationId || teamLeads[0].id;
        return null;
    }

    async getLatestParticipation(studentId: string): Promise<Participation | null> {
        const latest = await this.participantRepository.findOne({
            where: { studentId },
            relations: ['attendanceLogs'],
            order: { createdAt: 'DESC' }
        });
        return latest ? this.decryptParticipation(latest) : null;
    }

    async deleteParticipant(requesterUserId: string, participantId: string) {
        const participation = await this.participantRepository.findOne({
            where: { id: participantId },
            relations: ['attendanceLogs'],
        });

        if (!participation) {
            throw new NotFoundException('Participation record not found');
        }

        const requester = await this.userRepository.findOne({ where: { id: requesterUserId } });
        if (!requester) {
            throw new ForbiddenException('Not authorized to remove this team member');
        }

        const requesterEmail = (requester.email || '').trim().toLowerCase();
        const targetEmail = (participation.email || '').trim().toLowerCase();
        const isSelf =
            (participation.studentId && participation.studentId === requesterUserId) ||
            (requesterEmail && targetEmail && requesterEmail === targetEmail);

        if (!isSelf) {
            const requesterParticipation = await this.participantRepository.findOne({
                where: [
                    { projectId: participation.projectId, studentId: requesterUserId },
                    ...(requesterEmail ? [{ projectId: participation.projectId, email: requesterEmail }] : []),
                ],
                order: { isTeamLead: 'DESC', createdAt: 'ASC' },
            });

            const sameTeam = Boolean(
                requesterParticipation?.isTeamLead &&
                    participation.participationMode === 'team' &&
                    requesterParticipation.participationMode === 'team' &&
                    !participation.isTeamLead &&
                    ((participation.teamId &&
                        requesterParticipation.teamId &&
                        participation.teamId === requesterParticipation.teamId) ||
                        (participation.applicationId &&
                            requesterParticipation.applicationId &&
                            participation.applicationId === requesterParticipation.applicationId)),
            );

            if (!sameTeam) {
                throw new ForbiddenException('Only the team lead or the member themselves can remove this seat');
            }
        }

        await this.participantRepository.remove(participation);
        return { success: true };
    }

    private decryptParticipation(p: Participation): Participation {
        if (p.cnic && p.cnic.includes(':')) {
            try {
                p.cnic = this.decrypt(p.cnic);
            } catch (e) {
                this.logger.error(`Failed to decrypt CNIC for participation ${p.id}`);
            }
        }
        return p;
    }

    private async findParticipationByIdentifier(participantId: string, relations: string[] = []): Promise<Participation> {
        this.logger.debug(`Searching for participation with identifier: ${participantId}`);
        const trimmed = (participantId || '').trim();
        if (/^pending:/i.test(trimmed)) {
            throw new BadRequestException(
                'Invalid participation reference (draft roster id). Reload the page and use your enrolled participation id for attendance.',
            );
        }
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // 1. Direct Lookup in Participations Table
        
        // If it's a valid UUID, look up by ID
        if (uuidRegex.test(participantId)) {
            this.logger.debug(`Identifier is a UUID, searching by ID...`);
            const participation = await this.participantRepository.findOne({
                where: { id: participantId },
                relations
            });
            if (participation) return participation;
        }

        // Try University ID
        this.logger.debug(`Searching by University ID...`);
        const byUniversityId = await this.participantRepository.findOne({
            where: { universityId: participantId },
            relations
        });
        if (byUniversityId) return byUniversityId;

        // Try CNIC Hash
        const normalizedCnic = (participantId || '').replace(/\D/g, '');
        if (normalizedCnic.length >= 10) { // Likely a CNIC
            const cnicHash = this.hashString(normalizedCnic);
            this.logger.debug(`Searching by CNIC Hash (${cnicHash})...`);
            const byCnic = await this.participantRepository.findOne({
                where: { cnicHash },
                relations
            });
            if (byCnic) return byCnic;
        }

        // Try Mobile
        this.logger.debug(`Searching by Mobile...`);
        const byMobile = await this.participantRepository.findOne({
            where: { mobile: participantId },
            relations
        });
        if (byMobile) return byMobile;

        // Try Email
        this.logger.debug(`Searching by email...`);
        const byEmail = await this.participantRepository.findOne({
            where: { email: participantId },
            relations
        });
        if (byEmail) return byEmail;

        // Try studentId (if UUID)
        if (uuidRegex.test(participantId)) {
            this.logger.debug(`Searching by studentId...`);
            const byStudentId = await this.participantRepository.findOne({
                where: { studentId: participantId },
                relations
            });
            if (byStudentId) return byStudentId;
        }

        // 2. Failsafe: Search Users table if not found in Participations
        this.logger.debug(`Not found in participations, searching Users table...`);
        let userRecord: User | null = null;

        if (uuidRegex.test(participantId)) {
            userRecord = await this.userRepository.findOne({ where: { id: participantId } });
        }
        
        if (!userRecord) {
            // Search user by CNIC, email, or phone
            userRecord = await this.userRepository.findOne({
                where: [
                    { email: participantId },
                    { phone: participantId },
                    { cnic: participantId }
                ]
            });
        }

        if (userRecord) {
            this.logger.debug(`Found user matching identifier: ${userRecord.id}. Searching for their project registration...`);
            
            const participationByUser = await this.participantRepository.findOne({
                where: { studentId: userRecord.id },
                relations,
                order: { createdAt: 'DESC' }
            });
            
            if (participationByUser) {
                this.logger.log(`Bridged identifier ${participantId} to participation ${participationByUser.id} for student ${userRecord.id}`);
                return participationByUser;
            }
        }

        this.logger.warn(`No participation found for identifier: ${participantId}`);
        throw new NotFoundException('Participation record not found');
    }

    private creatorOwnLiveListingAllowsAttendance(
        participation: Participation,
        studentId: string,
        opportunity: Opportunity | null,
    ): boolean {
        if (!opportunity?.creatorId || opportunity.creatorId !== studentId) return false;
        if (!opportunity.admin_approved) return false;
        if (opportunity.workflowStage === WORKFLOW_STAGE.LIVE) return true;
        const st = (opportunity.status || '').toLowerCase();
        return ['active', 'live', 'open', 'recruiting'].includes(st);
    }

    /** Non-blocking issue_logs row for attendance submit failures (admin Issue Logs UI). */
    private recordAttendanceFailure(
        reasonCode: string,
        message: string,
        statusCode: number,
        studentId: string,
        participantId: string,
        extra?: Record<string, unknown>,
    ): void {
        if (!this.issueLogsService) return;
        void (async () => {
            let userEmail: string | null = null;
            let userRole: string | null = null;
            try {
                const user = await this.userRepository.findOne({
                    where: { id: studentId },
                    select: ['email', 'role'],
                });
                userEmail = user?.email ?? null;
                userRole = user?.role ?? null;
            } catch {
                /* best-effort */
            }
            await this.issueLogsService!.logOperationalIssue({
                eventType: 'attendance_submit_failure',
                severity: statusCode >= 500 ? 'error' : 'warning',
                module: 'engagement',
                stage: 'attendance_submit',
                message,
                statusCode,
                method: 'POST',
                path: `/api/v1/engagement/${participantId}/attendance`,
                userId: studentId,
                userEmail,
                userRole,
                targetType: 'participation',
                targetId: participantId,
                metadata: {
                    reasonCode,
                    participationId: extra?.participationId ?? null,
                    projectId: extra?.projectId ?? null,
                    ...extra,
                },
            });
        })();
    }

    async addAttendanceLog(studentId: string, participantId: string, dto: CreateAttendanceLogDto, file?: Express.Multer.File) {
        const hasEvidence = Boolean(file) || String(dto.evidenceUploaded) === 'true';
        const participation = await this.findParticipationByIdentifier(participantId, ['attendanceLogs']);
        if (!participation) throw new NotFoundException('Participation record not found');
        
        if (participation.studentId !== studentId) {
            const user = await this.userRepository.findOne({ where: { id: studentId } });
            const pEmail = (participation.email || '').toLowerCase().trim();
            const uEmail = (user?.email || '').toLowerCase().trim();
            
            let userCnicHash = user?.cnic ? this.hashString(user.cnic) : null;

            // Collect transitive identifiers from other participations belonging to this user
            // We search by studentId AND email to find records that might not be linked yet
            const myOtherParticipations = await this.participantRepository.find({
                where: [
                    { studentId },
                    { email: uEmail }
                ]
            });

            const myEmails = new Set([uEmail]);
            const myCnicHashes = new Set(userCnicHash ? [userCnicHash] : []);

            for (const p of myOtherParticipations) {
                if (p.email) myEmails.add(p.email.toLowerCase().trim());
                if (p.cnicHash) myCnicHashes.add(p.cnicHash);
            }

            const isEmailMatch = pEmail && myEmails.has(pEmail);
            const isCnicMatch = participation.cnicHash && myCnicHashes.has(participation.cnicHash);

            this.logger.warn(`Authorization check: Requester ${studentId} (email: ${uEmail}) vs Participation ${participation.id} (owner: ${participation.studentId}, email: ${pEmail})`);

            if (isEmailMatch || isCnicMatch) {
                const matchType = isEmailMatch ? 'email' : 'CNIC';
                this.logger.log(`Auto-claiming participation ${participation.id} for user ${studentId} via transitive ${matchType} match.`);
                
                // Auto-claim the record since we identified the student
                participation.studentId = studentId;
                await this.participantRepository.save(participation);
                this.logger.log(`Participation ${participation.id} auto-claimed by user ${studentId} via transitive ${matchType} matching during attendance logging`);
            } else {
                // Target must not be a team-lead row. Allow proxy when not a "solo individual" row
                // (mode individual with no application/team link — those are never team-member targets).
                const mayReceiveTeamLeadAttendance =
                    !participation.isTeamLead &&
                    participation.projectId &&
                    !(
                        participation.participationMode === 'individual' &&
                        !participation.applicationId &&
                        !participation.teamId
                    );

                // Fallback: Check if requester is the Team Lead for this application / team
                let isAuthorizedAsLead = false;
                if (participation.applicationId) {
                    const leadRecord = await this.participantRepository.findOne({
                        where: {
                            applicationId: participation.applicationId,
                            studentId: studentId,
                            isTeamLead: true
                        }
                    });
                    if (leadRecord) {
                        isAuthorizedAsLead = true;
                        this.logger.log(`Attendance entry by Team Lead ${studentId} authorized for team member record ${participation.id} (applicationId)`);
                    }
                }

                if (!isAuthorizedAsLead && participation.teamId) {
                    const leadRecord = await this.participantRepository.findOne({
                        where: {
                            teamId: participation.teamId,
                            projectId: participation.projectId,
                            studentId: studentId,
                            isTeamLead: true
                        }
                    });
                    if (leadRecord) {
                        isAuthorizedAsLead = true;
                        this.logger.log(`Attendance entry by Team Lead ${studentId} authorized for team member record ${participation.id} (teamId)`);
                    }
                }

                // Self-serve team flow (registerParticipant) often leaves applicationId/teamId unset.
                // When the project has exactly one team lead row, treat that student as lead for any non-lead team participation on the same project.
                if (!isAuthorizedAsLead && mayReceiveTeamLeadAttendance) {
                    const teamLeads = await this.participantRepository.find({
                        where: {
                            projectId: participation.projectId,
                            isTeamLead: true,
                        },
                    });
                    if (teamLeads.length === 1 && teamLeads[0].studentId === studentId) {
                        isAuthorizedAsLead = true;
                        this.logger.log(
                            `Attendance entry by sole Team Lead ${studentId} authorized for team member record ${participation.id} (single-lead fallback)`,
                        );
                    }
                }

                // Multiple teams on one project: allow when this member's primaryFacultyEmail matches
                // exactly one team lead row on the same project (same normalized email).
                if (!isAuthorizedAsLead && mayReceiveTeamLeadAttendance) {
                    const memberFaculty = (participation.primaryFacultyEmail || '').trim().toLowerCase();
                    if (memberFaculty) {
                        const allTeamLeads = await this.participantRepository.find({
                            where: {
                                projectId: participation.projectId,
                                isTeamLead: true,
                            },
                        });
                        const leadsSameFaculty = allTeamLeads.filter(
                            (p) => (p.primaryFacultyEmail || '').trim().toLowerCase() === memberFaculty,
                        );
                        if (leadsSameFaculty.length === 1 && leadsSameFaculty[0].studentId === studentId) {
                            isAuthorizedAsLead = true;
                            this.logger.log(
                                `Attendance entry by Team Lead ${studentId} authorized for team member record ${participation.id} (single lead for primaryFacultyEmail)`,
                            );
                        }
                    }
                }

                // Report flow: lead logs attendance for every team member. Allow when this user has at
                // least one team-lead row on the project and no *other student* is also a team lead here
                // (covers duplicate lead rows for the same lead). If another student is a lead, require
                // applicationId/teamId to match one of this user's lead rows (same team only).
                if (!isAuthorizedAsLead && mayReceiveTeamLeadAttendance) {
                    const allTeamLeadsOnProject = await this.participantRepository.find({
                        where: {
                            projectId: participation.projectId,
                            isTeamLead: true,
                        },
                    });
                    const myTeamLeadRows = allTeamLeadsOnProject.filter((l) => l.studentId === studentId);
                    const otherStudentLeads = allTeamLeadsOnProject.filter(
                        (l) => l.studentId != null && l.studentId !== studentId,
                    );
                    if (myTeamLeadRows.length > 0) {
                        if (otherStudentLeads.length === 0) {
                            isAuthorizedAsLead = true;
                            this.logger.log(
                                `Attendance entry by Team Lead ${studentId} authorized for team member record ${participation.id} (only this student has team-lead rows on project)`,
                            );
                        } else {
                            const linkedToMyLead = myTeamLeadRows.some(
                                (l) =>
                                    (Boolean(l.applicationId) &&
                                        Boolean(participation.applicationId) &&
                                        l.applicationId === participation.applicationId) ||
                                    (Boolean(l.teamId) &&
                                        Boolean(participation.teamId) &&
                                        l.teamId === participation.teamId),
                            );
                            if (linkedToMyLead) {
                                isAuthorizedAsLead = true;
                                this.logger.log(
                                    `Attendance entry by Team Lead ${studentId} authorized for team member record ${participation.id} (team scoped by applicationId/teamId)`,
                                );
                            }
                        }
                    }
                }

                if (!isAuthorizedAsLead) {
                    this.logger.error(`Not authorized: User ${studentId} (email: ${user?.email}, cnicHash: ${userCnicHash?.slice(-6)}) tried logging attendance for record ${participation.id} (owner: ${participation.studentId}, email: ${participation.email}, cnicHash: ${participation.cnicHash?.slice(-6)})`);
                    this.recordAttendanceFailure(
                        'not_authorized',
                        'Not authorized',
                        400,
                        studentId,
                        participantId,
                        {
                            hasEvidence,
                            participationId: participation.id,
                            projectId: participation.projectId,
                        },
                    );
                    throw new BadRequestException('Not authorized');
                }
            }
        }

        const opportunity = participation.projectId
            ? await this.opportunityRepository.findOne({
                  where: { id: participation.projectId },
                  relations: ['organization'],
              })
            : null;
        const creatorLiveBypass = this.creatorOwnLiveListingAllowsAttendance(
            participation,
            studentId,
            opportunity,
        );

        // Check if participation is approved (creator on own live listing may log despite stale rejected row).
        // CIEL admin override on this seat bypasses enrollment status gates.
        if (
            !creatorLiveBypass &&
            participation.adminAttendanceEditable !== true &&
            !['approved', 'verified', 'accepted', 'finalized'].includes(participation.status)
        ) {
            this.logger.warn(`Attendance logging attempt for record ${participation.id} in status: ${participation.status}`);
            const statusMsg = `Attendance logging is only allowed for approved/verified records (Current status: ${participation.status})`;
            this.recordAttendanceFailure(
                'participation_not_approved',
                statusMsg,
                400,
                studentId,
                participantId,
                {
                    hasEvidence,
                    participationId: participation.id,
                    projectId: participation.projectId,
                    participationStatus: participation.status,
                    creatorLiveBypass,
                },
            );
            throw new BadRequestException(statusMsg);
        }

        // Rule 1: Date Validation (Not in future)
        const date = new Date(dto.dateOfEngagement);
        if (date > new Date()) {
            this.recordAttendanceFailure(
                'date_in_future',
                'Attendance date cannot be in the future',
                400,
                studentId,
                participantId,
                { hasEvidence, participationId: participation.id, projectId: participation.projectId },
            );
            throw new BadRequestException('Attendance date cannot be in the future');
        }

        // Handle Flexible Project 4-month window
        if (participation.attendanceLogs && participation.attendanceLogs.length > 0) {
            const firstLogDate = new Date(Math.min(...participation.attendanceLogs.map(l => new Date(l.dateOfEngagement).getTime())));
            const fourMonthsLater = new Date(firstLogDate);
            fourMonthsLater.setMonth(fourMonthsLater.getMonth() + 4);

            if (date > fourMonthsLater) {
                const windowMsg =
                    'Attendance entries must fall within 4 months from the first log for flexible projects.';
                this.recordAttendanceFailure(
                    'outside_four_month_window',
                    windowMsg,
                    400,
                    studentId,
                    participantId,
                    { hasEvidence, participationId: participation.id, projectId: participation.projectId },
                );
                throw new BadRequestException(windowMsg);
            }
        }

        // Rule 2: Time Validation (End > Start and max daily cap per session + same-day total)
        const { startTime, endTime } = dto;
        const sessionHours = this.calculateSessionHours(startTime, endTime);
        const dailyCapMessage = dailyAttendanceCapMessage();
        if (sessionHours <= 0) {
            this.recordAttendanceFailure(
                'invalid_session_times',
                'End time must be after start time',
                400,
                studentId,
                participantId,
                { hasEvidence, participationId: participation.id, projectId: participation.projectId, startTime, endTime },
            );
            throw new BadRequestException('End time must be after start time');
        }
        if (sessionHours > MAX_DAILY_ATTENDANCE_HOURS) {
            this.recordAttendanceFailure(
                'session_exceeds_daily_cap',
                dailyCapMessage,
                400,
                studentId,
                participantId,
                {
                    hasEvidence,
                    participationId: participation.id,
                    projectId: participation.projectId,
                    sessionHours,
                    maxDailyHours: MAX_DAILY_ATTENDANCE_HOURS,
                },
            );
            throw new BadRequestException(dailyCapMessage);
        }

        const engagementDateKey = dto.dateOfEngagement.split('T')[0];
        const existingDailyHours = (participation.attendanceLogs ?? [])
            .filter((log) => String(log.dateOfEngagement).split('T')[0] === engagementDateKey)
            .reduce((sum, log) => sum + (Number(log.sessionHours) || 0), 0);
        if (existingDailyHours + sessionHours > MAX_DAILY_ATTENDANCE_HOURS) {
            this.recordAttendanceFailure(
                'daily_total_exceeds_cap',
                dailyCapMessage,
                400,
                studentId,
                participantId,
                {
                    hasEvidence,
                    participationId: participation.id,
                    projectId: participation.projectId,
                    sessionHours,
                    existingDailyHours,
                    maxDailyHours: MAX_DAILY_ATTENDANCE_HOURS,
                    dateOfEngagement: engagementDateKey,
                },
            );
            throw new BadRequestException(dailyCapMessage);
        }

        // Rule 3: Word count (chars capped by DTO @MaxLength + DB column)
        const wordCount = dto.description.trim().split(/\s+/).length;
        if (wordCount > ATTENDANCE_DESCRIPTION_MAX_WORDS) {
            const wordMsg = `Description cannot exceed ${ATTENDANCE_DESCRIPTION_MAX_WORDS} words`;
            this.recordAttendanceFailure(
                'description_word_limit',
                wordMsg,
                400,
                studentId,
                participantId,
                {
                    hasEvidence,
                    participationId: participation.id,
                    projectId: participation.projectId,
                    wordCount,
                    maxChars: ATTENDANCE_DESCRIPTION_MAX_CHARS,
                },
            );
            throw new BadRequestException(wordMsg);
        }

        let evidenceUrl: string | null = null;
        let evidenceUploaded: boolean = false;

        const presignedUrl =
            typeof dto.evidenceUrl === 'string' && dto.evidenceUrl.trim()
                ? dto.evidenceUrl.trim()
                : null;

        // Process file if provided (legacy multipart — prefer presigned evidenceUrl on mobile)
        if (file) {
            try {
                evidenceUrl = await this.s3Service.uploadFile(file, 'attendance-evidence');
                evidenceUploaded = true;
            } catch (uploadErr) {
                const uploadMsg =
                    uploadErr instanceof Error && uploadErr.message
                        ? uploadErr.message
                        : 'Failed to upload file to S3';
                this.recordAttendanceFailure(
                    's3_upload_failed',
                    uploadMsg,
                    500,
                    studentId,
                    participantId,
                    {
                        hasEvidence: true,
                        participationId: participation.id,
                        projectId: participation.projectId,
                        fileName: file.originalname,
                        fileSize: file.size,
                        mimeType: file.mimetype,
                    },
                );
                throw uploadErr;
            }
        } else if (presignedUrl) {
            evidenceUrl = presignedUrl;
            evidenceUploaded = true;
        } else if (String(dto.evidenceUploaded) === 'true') {
            evidenceUploaded = true;
        }

        if (!opportunity) {
            this.recordAttendanceFailure(
                'project_not_found',
                'Project not found',
                404,
                studentId,
                participantId,
                { hasEvidence, participationId: participation.id, projectId: participation.projectId },
            );
            throw new NotFoundException('Project not found');
        }

        const hasPartnerContact = opportunityHasActionablePartnerForAttendance(opportunity);
        let attendanceApproverType = await this.resolveAttendanceApproverTypeForParticipation(
            participation,
            opportunity,
        );

        if (hasPartnerContact) {
            attendanceApproverType = 'partner';
            if (participation.attendanceApproverType !== 'partner') {
                participation.attendanceApproverType = 'partner';
                await this.participantRepository.save(participation);
            }
        } else if (opportunity.isStudentCreated) {
            attendanceApproverType = 'faculty';
            if (participation.attendanceApproverType === 'partner') {
                participation.attendanceApproverType = 'faculty';
                await this.participantRepository.save(participation);
            }
        }

        let assignedFacultyUserId: string | null = null;
        let assignedPartnerUserId: string | null = null;

        if (attendanceApproverType === 'faculty') {
            const facultyEmails = await this.resolveFacultyEmailsForAttendanceRouting(participation, opportunity);
            if (!facultyEmails.length) {
                const facultyMsg =
                    'Attendance approval needs a supervising faculty: add primary or secondary faculty email on registration, or ensure the project has faculty (linked faculty account or supervision contact matching a faculty user).';
                this.recordAttendanceFailure(
                    'faculty_routing_missing',
                    facultyMsg,
                    400,
                    studentId,
                    participantId,
                    {
                        hasEvidence,
                        participationId: participation.id,
                        projectId: participation.projectId,
                        attendanceApproverType,
                    },
                );
                throw new BadRequestException(facultyMsg);
            }

            for (const facultyEmail of facultyEmails) {
                const facultyUser = await this.userRepository
                    .createQueryBuilder('user')
                    .where('LOWER("user"."email") = :facultyEmail', { facultyEmail })
                    .andWhere('"user"."role" = :facultyRole', { facultyRole: UserRole.FACULTY })
                    .getOne();
                if (facultyUser?.id) {
                    assignedFacultyUserId = facultyUser.id;
                    break;
                }
            }
        } else {
            assignedPartnerUserId = await this.resolvePartnerOwnerUserId(opportunity);
            const partnerEmails = this.extractPartnerOfficialEmails(opportunity);
            if (!assignedPartnerUserId && partnerEmails.length === 0) {
                const partnerMsg =
                    'Attendance approval needs a partner contact email or registered partner account for this project.';
                this.recordAttendanceFailure(
                    'partner_routing_missing',
                    partnerMsg,
                    400,
                    studentId,
                    participantId,
                    {
                        hasEvidence,
                        participationId: participation.id,
                        projectId: participation.projectId,
                        attendanceApproverType,
                    },
                );
                throw new BadRequestException(partnerMsg);
            }
        }
        const routing = resolveAttendanceApproverRouting(
            assignedFacultyUserId,
            attendanceApproverType,
            assignedPartnerUserId,
        );

        const log = this.attendanceLogRepository.create({
            ...dto,
            participantId: participation.id,
            projectId: participation.projectId,
            sessionHours,
            evidenceUploaded,
            evidenceUrl: evidenceUrl as any,
            approvalStatus: routing.approvalStatus,
            assignedApproverType: routing.assignedApproverType,
            assignedApproverUserId: routing.assignedApproverUserId,
            opportunityCreatorKind: routing.opportunityCreatorKind,
        });

        const saved = await this.attendanceLogRepository.save(log);
        void this.notifyAttendancePendingReview(saved, opportunity, participation, routing).catch((err) =>
            this.logger.warn(`Attendance pending notification skipped: ${err?.message}`),
        );
        return saved;
    }

    private async notifyAttendancePendingReview(
        log: AttendanceLog,
        opportunity: Opportunity,
        participation: Participation,
        routing: ReturnType<typeof resolveAttendanceApproverRouting>,
    ) {
        const title = opportunity.title || 'Project';
        const student = participation.studentId
            ? await this.userRepository.findOne({ where: { id: participation.studentId } })
            : null;
        const studentLabel = student?.name || participation.fullName || participation.email || 'A participant';

        const studentEmail = (student?.email || participation.email || '').trim().toLowerCase();

        if (routing.assignedApproverType === 'faculty') {
            const approver = routing.assignedApproverUserId
                ? await this.userRepository.findOne({ where: { id: routing.assignedApproverUserId } })
                : null;
            const recipientEmail =
                approver?.email ||
                participation.primaryFacultyEmail ||
                participation.facultySupervisorEmail ||
                participation.secondaryFacultyEmail;
            const normalizedRecipient = (recipientEmail || '').trim().toLowerCase();
            if (normalizedRecipient && normalizedRecipient !== studentEmail) {
                await this.mailService.sendAttendancePendingReview(
                    normalizedRecipient,
                    approver?.name || 'Faculty',
                    'faculty',
                    studentLabel,
                    title,
                    opportunity.id,
                );
            }
        }

        if (routing.assignedApproverType === 'partner') {
            const approver = routing.assignedApproverUserId
                ? await this.userRepository.findOne({ where: { id: routing.assignedApproverUserId } })
                : null;
            const partnerEmails = this.extractPartnerOfficialEmails(opportunity);
            const recipientEmail = (approver?.email || partnerEmails[0] || '').trim().toLowerCase();
            if (recipientEmail && recipientEmail !== studentEmail) {
                await this.mailService.sendAttendancePendingReview(
                    recipientEmail,
                    approver?.name ||
                        String(opportunity.partner_organization?.contact_person || '').trim() ||
                        'Partner',
                    'partner',
                    studentLabel,
                    title,
                    opportunity.id,
                );
            }
        }
    }

    async listPendingAttendanceLogs(actorUserId: string, actorRole: string | undefined, projectId?: string) {
        const trimmed = typeof projectId === 'string' ? projectId.trim() : '';
        const scopedProjectId = trimmed.length > 0 ? trimmed : undefined;

        const actor = await this.userRepository.findOne({
            where: { id: actorUserId },
            relations: ['organization'],
        });
        const actorEmail = (actor?.email || '').trim().toLowerCase();

        const isPartnerActor =
            actorRole === UserRole.NGO ||
            actorRole === UserRole.CORPORATE ||
            actorRole === UserRole.ORGANIZATION_ADMIN;

        if (scopedProjectId) {
            const opportunity = await this.opportunityRepository.findOne({
                where: { id: scopedProjectId },
                relations: ['organization'],
            });
            if (!opportunity) {
                throw new NotFoundException(
                    'No opportunity exists for this projectId. Use the same opportunity id as in your faculty list or attendance email links (the project UUID).',
                );
            }
            if (actorRole === UserRole.FACULTY) {
                const canAccess = await this.facultyMemberCanAccessOpportunityForPendingAttendance(
                    actorUserId,
                    actorEmail,
                    opportunity,
                );
                if (!canAccess) {
                    throw new ForbiddenException(
                        'This projectId is valid but you are not listed as faculty or supervisor for that opportunity, so pending attendance cannot be loaded for it.',
                    );
                }
                if (opportunity.isStudentCreated) {
                    await this.reconcileMisroutedPartnerAttendanceForOpportunity(opportunity);
                }
            } else if (isPartnerActor) {
                await this.reconcilePartnerAttendanceAssigneeForOpportunity(opportunity);
            }
        } else if (isPartnerActor && actor?.organization?.id) {
            const orgOpportunities = await this.opportunityRepository.find({
                where: { organizationId: actor.organization.id },
                relations: ['organization'],
            });
            for (const opportunity of orgOpportunities) {
                await this.reconcilePartnerAttendanceAssigneeForOpportunity(opportunity);
            }
        }

        const qb = this.attendanceLogRepository
            .createQueryBuilder('log')
            .leftJoinAndSelect('log.participant', 'participant')
            .leftJoinAndSelect('log.project', 'project')
            .where('log.approvalStatus = :pending', { pending: 'pending' });

        if (scopedProjectId) {
            qb.andWhere('log.projectId = :projectId', { projectId: scopedProjectId });
        }

        if (actorRole === UserRole.FACULTY) {
            qb.andWhere('log.assignedApproverType = :facultyType', { facultyType: 'faculty' });
            if (actorEmail) {
                qb.andWhere(
                    `(
                        "log"."assignedApproverUserId"::text = :uid
                        OR LOWER(TRIM(COALESCE("participant"."facultySupervisorEmail", ''))) = :actorEmail
                        OR LOWER(TRIM(COALESCE("participant"."primaryFacultyEmail", ''))) = :actorEmail
                        OR LOWER(TRIM(COALESCE("participant"."secondaryFacultyEmail", ''))) = :actorEmail
                    )`,
                    { uid: actorUserId, actorEmail },
                );
            } else {
                qb.andWhere('"log"."assignedApproverUserId"::text = :uid', { uid: actorUserId });
            }
        } else if (actorRole === UserRole.SUPER_ADMIN) {
            qb.andWhere('log.assignedApproverType = :adminType', { adminType: 'admin' });
        } else {
            qb.andWhere('log.assignedApproverType = :partnerType', { partnerType: 'partner' });
            const actorOrgId = actor?.organization?.id ?? null;
            qb.andWhere(
                new Brackets((w) => {
                    w.where('"log"."assignedApproverUserId"::text = :uid', { uid: actorUserId });
                    if (actorOrgId) {
                        w.orWhere(
                            new Brackets((w2) => {
                                w2.where('"log"."assignedApproverUserId" IS NULL').andWhere(
                                    'project.organizationId = :actorOrgId',
                                    { actorOrgId },
                                );
                            }),
                        );
                    }
                }),
            );
        }

        const logs = await qb.orderBy('log.createdAt', 'DESC').getMany();
        if (scopedProjectId) {
            await this.hydratePendingAttendanceParticipantTeamIds(logs, scopedProjectId);
        }
        return this.formatPendingAttendanceResponse(logs, scopedProjectId);
    }

    /**
     * Partner team filters key off `participant.teamId`. Legacy rows often omit it on the
     * joined participant even though roster `/team` has the cohort — hydrate from roster parity.
     */
    private async hydratePendingAttendanceParticipantTeamIds(
        logs: AttendanceLog[],
        projectId: string,
    ): Promise<void> {
        if (!logs.length) return;
        const roster = await this.participantRepository.find({
            where: { projectId },
            order: { createdAt: 'ASC' },
        });
        if (!roster.length) return;

        const byId = new Map<string, Participation>();
        const byEmail = new Map<string, Participation>();
        for (const row of roster) {
            byId.set(row.id, row);
            const email = (row.email || '').trim().toLowerCase();
            if (email) byEmail.set(email, row);
        }

        for (const log of logs) {
            const participant = log.participant;
            if (!participant) continue;

            const existing = this.normalizeOptionalString(participant.teamId);
            if (existing) {
                (participant as Participation & { team_id?: string }).team_id = existing;
                continue;
            }

            const rosterRow =
                byId.get(participant.id) ||
                (participant.email
                    ? byEmail.get(String(participant.email).trim().toLowerCase())
                    : undefined);
            if (!rosterRow) continue;

            const resolved = this.resolveTeamIdFromRosterRow(rosterRow, roster);
            if (!resolved) continue;
            participant.teamId = resolved;
            (participant as Participation & { team_id?: string }).team_id = resolved;
        }
    }

    private resolveTeamIdFromRosterRow(member: Participation, roster: Participation[]): string | null {
        const own = this.normalizeOptionalString(member.teamId);
        if (own) return own;

        const appId = this.normalizeOptionalString(member.applicationId);
        if (appId) {
            const peer = roster.find(
                (r) =>
                    this.normalizeOptionalString(r.applicationId) === appId &&
                    this.normalizeOptionalString(r.teamId),
            );
            const peerTeam = peer ? this.normalizeOptionalString(peer.teamId) : null;
            if (peerTeam) return peerTeam;
        }

        if (member.isTeamLead) return null;

        const lead = roster.find(
            (r) =>
                r.isTeamLead &&
                this.normalizeOptionalString(r.teamId) &&
                (!appId || this.normalizeOptionalString(r.applicationId) === appId),
        );
        return lead ? (this.normalizeOptionalString(lead.teamId) ?? null) : null;
    }

    /** Normalized payload: plain arrays plus aliases for older clients (`data.items`, `data.pending`). */
    private formatPendingAttendanceResponse(logs: AttendanceLog[], projectId?: string) {
        return {
            items: logs,
            pending: logs,
            rows: logs,
            projectId: projectId ?? null,
            opportunity_id: projectId ?? null,
        };
    }

    private async facultyMemberCanAccessOpportunityForPendingAttendance(
        userId: string,
        actorEmail: string,
        opportunity: Opportunity,
    ): Promise<boolean> {
        if (opportunity.creatorId === userId || opportunity.facultyId === userId) {
            return true;
        }
        if (!actorEmail) {
            return false;
        }
        const appRepo = this.opportunityRepository.manager.getRepository(OpportunityApplication);
        const appCount = await appRepo
            .createQueryBuilder('app')
            .where('app.opportunityId = :oid', { oid: opportunity.id })
            .andWhere(
                '(LOWER(TRIM(app.primaryFacultyEmail)) = :em OR LOWER(TRIM(COALESCE(app.secondaryFacultyEmail, \'\'))) = :em)',
                { em: actorEmail },
            )
            .getCount();
        if (appCount > 0) {
            return true;
        }
        const partCount = await this.participantRepository
            .createQueryBuilder('p')
            .where('p.projectId = :oid', { oid: opportunity.id })
            .andWhere(
                `(
                    LOWER(TRIM(COALESCE(p.facultySupervisorEmail, ''))) = :em
                    OR LOWER(TRIM(COALESCE(p.primaryFacultyEmail, ''))) = :em
                    OR LOWER(TRIM(COALESCE(p.secondaryFacultyEmail, ''))) = :em
                )`,
                { em: actorEmail },
            )
            .getCount();
        return partCount > 0;
    }

    /** NGO / corporate / org-admin user may act only for opportunities hosted by them or their organization. */
    private partnerActorHostsOpportunity(actorUserId: string, actor: User | null, opportunity: Opportunity): boolean {
        if (!opportunity.isStudentCreated && opportunity.creatorId === actorUserId) {
            return true;
        }
        const orgId = actor?.organization?.id ?? null;
        return !!(orgId && opportunity.organizationId && orgId === opportunity.organizationId);
    }

    async patchAttendanceApproval(actorUserId: string, actorRole: string | undefined, logId: string, dto: PatchAttendanceApprovalDto) {
        const log = await this.attendanceLogRepository.findOne({
            where: { id: logId },
            relations: ['project', 'participant'],
        });
        if (!log) {
            throw new NotFoundException(
                'No attendance log was found for this id. It may have been removed or the link is out of date.',
            );
        }
        if (!log.approvalStatus || log.approvalStatus !== 'pending') {
            const state = log.approvalStatus ? String(log.approvalStatus) : 'legacy';
            throw new BadRequestException(
                `This attendance entry is not awaiting approval (current state: ${state}). Refresh the list and try again.`,
            );
        }

        const actor = await this.userRepository.findOne({
            where: { id: actorUserId },
            relations: ['organization'],
        });
        const opportunityCreatorFallback =
            log.project?.isStudentCreated ? null : (log.project?.creatorId ?? null);
        const partnerOrgHostsOpportunity = Boolean(
            log.assignedApproverType === 'partner'
            && !log.assignedApproverUserId
            && actor?.organization?.id
            && log.project?.organizationId
            && actor.organization.id === log.project.organizationId,
        );
        const allowed = canUserActOnAttendanceQueue(
            actorUserId,
            actorRole,
            actor?.email || null,
            log,
            getParticipantFacultyEmails(log.participant || {}),
            opportunityCreatorFallback,
            partnerOrgHostsOpportunity,
        );
        if (!allowed) {
            throw new ForbiddenException(
                'You cannot update this attendance approval. Sign in as the faculty member listed for this participant, or confirm the entry is still pending.',
            );
        }

        const now = new Date();
        if (dto.action === 'approve') {
            log.approvalStatus = 'approved';
            log.entryStatus = 'verified';
        } else if (dto.action === 'reject') {
            log.approvalStatus = 'rejected';
            log.entryStatus = 'pending';
        } else {
            log.approvalStatus = 'flagged';
            log.entryStatus = 'flagged';
        }
        log.approvalActionReason = dto.reason ?? null;
        log.approvalActorUserId = actorUserId;
        log.approvalActionAt = now;

        return await this.attendanceLogRepository.save(log);
    }

    async createAttendanceVerifyRequest(
        actorUserId: string,
        actorRole: string | undefined,
        projectId: string,
        dto: CreateAttendanceVerifyRequestDto,
    ) {
        if (dto.projectId !== projectId) {
            throw new BadRequestException('projectId in path and body must match');
        }

        const requestedAt = new Date(dto.requestedAt);
        if (Number.isNaN(requestedAt.getTime())) {
            throw new BadRequestException('Invalid requestedAt value');
        }

        const opportunity = await this.opportunityRepository.findOne({
            where: { id: projectId },
            relations: ['organization'],
        });
        if (!opportunity) {
            throw new NotFoundException('Project not found');
        }

        const participant = await this.resolveVerifyRequestTargetParticipant(actorUserId, projectId, dto.participantId);
        if (!participant) {
            throw new NotFoundException('Participation record not found for this project');
        }

        const actor = await this.userRepository.findOne({ where: { id: actorUserId }, relations: ['organization'] });
        const actorEmail = (actor?.email || '').trim().toLowerCase();
        const participantEmail = (participant.email || '').trim().toLowerCase();
        const ownsParticipantRecord = participant.studentId === actorUserId;
        const canClaimByEmail = !participant.studentId && !!actorEmail && participantEmail === actorEmail;

        let authorized = ownsParticipantRecord || canClaimByEmail;

        if (!authorized && actorRole === UserRole.SUPER_ADMIN) {
            authorized = true;
        }

        if (!authorized && actorRole === UserRole.FACULTY) {
            authorized = await this.facultyMemberCanAccessOpportunityForPendingAttendance(
                actorUserId,
                actorEmail,
                opportunity,
            );
        }

        if (
            !authorized &&
            (actorRole === UserRole.NGO ||
                actorRole === UserRole.CORPORATE ||
                actorRole === UserRole.ORGANIZATION_ADMIN)
        ) {
            authorized = this.partnerActorHostsOpportunity(actorUserId, actor, opportunity);
        }

        if (!authorized) {
            throw new ForbiddenException('Not authorized to request attendance verification');
        }

        const reviewer = await this.resolveAttendanceVerificationReviewer(opportunity, participant);

        if (participant.attendanceVerificationRequested) {
            if (!participant.attendanceLocked) {
                participant.attendanceLocked = true;
                await this.participantRepository.save(participant);
            }
            return {
                emailNotified: Boolean(participant.attendanceVerificationEmailSentAt),
                reviewerType: participant.attendanceVerificationReviewerType || reviewer.reviewerType,
                type: 'already_requested',
            };
        }

        participant.attendanceVerificationRequested = true;
        participant.attendanceLocked = true;
        participant.attendanceVerificationRequestedAt = requestedAt;
        participant.attendanceVerificationReviewerType = reviewer.reviewerType;
        participant.attendanceVerificationReviewerEmail = reviewer.reviewerEmail;

        let emailNotified = false;
        try {
            await this.mailService.sendAttendanceVerificationRequestNotice(
                reviewer.reviewerEmail,
                reviewer.reviewerType,
                opportunity.title || 'Project',
                opportunity.id,
            );
            participant.attendanceVerificationEmailSentAt = new Date();
            emailNotified = true;
        } catch (error) {
            this.logger.warn(
                `Attendance verification request email failed for project ${projectId}: ${error?.message || error}`,
            );
        }

        await this.participantRepository.save(participant);
        return {
            emailNotified,
            reviewerType: reviewer.reviewerType,
        };
    }

    async deleteAttendanceLog(studentId: string, participantId: string, logId: string) {
        const participation = await this.findParticipationByIdentifier(participantId);
        if (!participation) throw new NotFoundException('Participation record not found');
        if (participation.studentId !== studentId) {
            throw new ForbiddenException('You can only delete your own attendance entries');
        }

        const log = await this.attendanceLogRepository.findOne({ where: { id: logId, participantId: participation.id } });
        if (!log) throw new NotFoundException('Attendance log not found');

        await this.attendanceLogRepository.delete(logId);
        return { deleted: true };
    }


    async getEngagementMetrics(participantId: string) {
        const participation = await this.findParticipationByIdentifier(participantId, ['attendanceLogs']);
        if (!participation) throw new NotFoundException('Participation not found');

        const rawLogs = participation.attendanceLogs || [];
        const logs = rawLogs.filter((l) => attendanceCountsTowardProgress(l));
        const totalHours = logs.reduce((sum, log) => sum + Number(log.sessionHours), 0);
        const activeDays = new Set(logs.map(l => l.dateOfEngagement)).size;

        // Engagement Span
        let spanWeeks = 0;
        if (logs.length > 0) {
            const dates = logs.map(l => new Date(l.dateOfEngagement).getTime());
            const minDate = Math.min(...dates);
            const maxDate = Math.max(...dates);
            const spanDays = Math.max(1, Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1);
            spanWeeks = Math.ceil(spanDays / 7);
        }

        const attendanceFrequency = spanWeeks > 0 ? (activeDays / spanWeeks) : 0;

        // Weekly Continuity
        const weeksWithLogs = new Set(logs.map(l => {
            const d = new Date(l.dateOfEngagement);
            return `${d.getFullYear()}-W${this.getWeekNumber(d)}`;
        })).size;
        const weeklyContinuity = spanWeeks > 1 ? (weeksWithLogs / spanWeeks) : 1;

        // EIS Calculation (Hours 40%, Continuity 20%, Span 15%, Frequency 15%, Evidence 10%)
        // Spec: normalize hours to 48
        const hoursScore = (Math.min(totalHours, 48) / 48) * 40;
        const continuityScore = weeklyContinuity * 20;
        // Spec: normalize span to 16 weeks
        const spanScore = (Math.min(spanWeeks, 16) / 16) * 15;
        // Spec: target 2 visits/week
        const freqRatio = Math.min(attendanceFrequency / 2, 1);
        const frequencyScore = freqRatio * 15;
        // Spec: evidence link status
        const logsWithEvidence = logs.filter(l => l.evidenceUploaded).length;
        const evidenceRatio = logs.length > 0 ? logsWithEvidence / logs.length : 0;
        const evidenceScore = evidenceRatio * 10;

        const eis = Math.round(hoursScore + continuityScore + spanScore + frequencyScore + evidenceScore);

        return {
            totalHours: Math.round(totalHours * 10) / 10,
            activeDays,
            spanWeeks,
            frequency: Math.round(attendanceFrequency * 10) / 10,
            weeklyContinuity: Math.round(weeklyContinuity * 100),
            eis: Math.min(100, eis),
            hecStatus: this.getHecCode(totalHours),
            hecDisplay: this.getHecDisplay(totalHours),
            category: this.getEngagementCategory(eis),
            evidenceCount: logsWithEvidence,
            evidenceRatio: Math.round(evidenceRatio * 100)
        };
    }

    async finalizeEngagement(studentId: string, participantId: string) {
        const participation = await this.findParticipationByIdentifier(participantId, ['attendanceLogs']);

        if (!participation) throw new NotFoundException('Participation record not found');
        if (participation.studentId !== studentId) throw new BadRequestException('Not authorized');

        const metrics = await this.getEngagementMetrics(participantId);

        participation.status = 'finalized';
        participation.eisScore = metrics.eis;
        participation.hecStatus = metrics.hecStatus;
        participation.finalizedAt = new Date();

        const saved = await this.participantRepository.save(participation);
        return this.decryptParticipation(saved);
    }

    async generateSummary(participantId: string) {
        const participation = await this.findParticipationByIdentifier(participantId);
        const metrics = await this.getEngagementMetrics(participantId);

        let participantInfo = `1 OTP-verified participant`;
        if (participation.participationMode === 'team' && participation.applicationId) {
            const count = await this.participantRepository.count({
                where: { applicationId: participation.applicationId }
            });
            if (count > 1) {
                participantInfo = `1 of ${count} OTP-verified team members`;
            }
        }

        let summary = `This report includes ${participantInfo} contributing ${metrics.totalHours} verified hours across ${metrics.activeDays} active days over a ${metrics.spanWeeks}-week span. `;
        summary += `The engagement ${metrics.hecDisplay}. `;
        summary += `Participation is classified as ${metrics.category} Engagement `;

        if (metrics.evidenceCount > 0) {
            summary += "based on verified attendance continuity and supporting documentation.";
        } else {
            summary += "based on verified attendance continuity.";
        }

        return summary;
    }

    async getAttendanceLogs(participantId: string) {
        const participation = await this.findParticipationByIdentifier(participantId, ['attendanceLogs']);
        if (!participation) throw new NotFoundException('Participation not found');
        return participation.attendanceLogs;
    }

    async getProjectAttendanceLogs(projectId: string) {
        return await this.attendanceLogRepository.find({
            where: { projectId },
            relations: ['participant'],
            order: { dateOfEngagement: 'DESC' }
        });
    }

    async facultyApprove(participationId: string, status: string) {
        const participation = await this.participantRepository.findOne({ where: { id: participationId } });
        if (!participation) throw new NotFoundException('Participation not found');

        if (!['approved', 'rejected'].includes(status)) {
            throw new BadRequestException('Invalid status for faculty approval');
        }

        participation.status = status;
        const saved = await this.participantRepository.save(participation);
        return this.decryptParticipation(saved);
    }

    private getHecCode(hours: number): string {
        if (hours >= 48) return 'full';
        if (hours >= 32) return 'advanced';
        if (hours >= 16) return 'recognized';
        return 'below';
    }

    private getHecDisplay(hours: number): string {
        if (hours >= 48) return 'meets Full 3-Credit Equivalent requirements (Extraordinary)';
        if (hours >= 32) return 'qualifies for Advanced Engagement status';
        if (hours >= 16) return 'meets HEC Recognized Engagement minimums';
        return 'is currently Below HEC Minimum';
    }

    private getEngagementCategory(eis: number): string {
        if (eis >= 76) return 'High-Intensity';
        if (eis >= 51) return 'Sustained';
        if (eis >= 26) return 'Structured';
        return 'Introductory';
    }

    private calculateSessionHours(start: string, end: string): number {
        const [h1, m1] = start.split(':').map(Number);
        const [h2, m2] = end.split(':').map(Number);
        const diffMinutes = (h2 * 60 + m2) - (h1 * 60 + m1);
        return Math.max(0, diffMinutes / 60);
    }

    private hashString(str: string): string {
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    /** Admin / cross-service: stable hash for CNIC uniqueness checks at the participation row layer. */
    getCnicHashForNormalizedDigits(normalizedDigits13: string): string {
        return this.hashString((normalizedDigits13 || '').trim());
    }

    /**
     * Stores encrypted CNIC + hash metadata on an existing participation seat (digits-only storage).
     * @throws BadRequestException when stripped digits length is not 13.
     */
    applyNormalizedCnicToParticipation(participation: Participation, normalizedDigits13: string): void {
        const digits = String(normalizedDigits13 || '').replace(/\D/g, '');
        if (digits.length !== 13) {
            throw new BadRequestException('CNIC must contain exactly 13 digits.');
        }
        participation.cnicHash = this.hashString(digits);
        participation.cnic = this.encrypt(digits);
        participation.cnicLast4 = digits.slice(-4);
    }

    private encrypt(text: string): string {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.ALGORITHM, this.KEY, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    }

    public decryptCnicInternal(text: string): string {
        if (!text || !text.includes(':')) return text;
        try {
            return this.decrypt(text);
        } catch (e) {
            return text;
        }
    }

    private decrypt(text: string): string {
        const [ivHex, encryptedText] = text.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv(this.ALGORITHM, this.KEY, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    private getWeekNumber(d: Date): number {
        const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
        return weekNo;
    }

    private async resolveVerifyRequestTargetParticipant(
        actorUserId: string,
        projectId: string,
        participantId?: string,
    ): Promise<Participation | null> {
        if (participantId) {
            return this.participantRepository.findOne({
                where: { id: participantId, projectId },
            });
        }

        const direct = await this.participantRepository.findOne({
            where: { studentId: actorUserId, projectId },
            order: { createdAt: 'DESC' },
        });
        if (direct) return direct;

        const actor = await this.userRepository.findOne({ where: { id: actorUserId } });
        const actorEmail = (actor?.email || '').trim().toLowerCase();
        if (!actorEmail) return null;

        return this.participantRepository
            .createQueryBuilder('participant')
            .where('participant.projectId = :projectId', { projectId })
            .andWhere('LOWER(TRIM(COALESCE(participant.email, \'\'))) = :actorEmail', { actorEmail })
            .orderBy('participant.createdAt', 'DESC')
            .getOne();
    }

    /**
     * Emails used to resolve a faculty approver for new attendance logs.
     * Prefer participation fields; then project-linked faculty (same idea as verification reviewer).
     */
    private async resolveFacultyEmailsForAttendanceRouting(
        participation: Participation,
        opportunity: Opportunity,
    ): Promise<string[]> {
        const fromParticipant = getParticipantFacultyEmails(participation);
        if (fromParticipant.length) {
            return fromParticipant;
        }

        const fromApplication = await this.resolveApplicationFacultyEmails(participation);
        if (fromApplication.length) {
            let changed = false;
            if (!participation.primaryFacultyEmail) {
                participation.primaryFacultyEmail = fromApplication[0];
                changed = true;
            }
            if (!participation.secondaryFacultyEmail && fromApplication[1]) {
                participation.secondaryFacultyEmail = fromApplication[1];
                changed = true;
            }
            if (changed) {
                await this.participantRepository.save(participation);
            }
            return getParticipantFacultyEmails(participation);
        }

        if (opportunity.facultyId) {
            const facultyUser = await this.userRepository.findOne({ where: { id: opportunity.facultyId } });
            const facultyEmail = (facultyUser?.email || '').trim().toLowerCase();
            if (facultyEmail) {
                return [facultyEmail];
            }
        }

        const linkageEmails = this.resolveOpportunityLinkageFacultyEmails(opportunity);
        if (linkageEmails.length) {
            return linkageEmails;
        }

        const sup = opportunity.supervision;
        if (sup && typeof sup === 'object') {
            const o = sup as Record<string, unknown>;
            const raw =
                (typeof o.contact === 'string' && o.contact) ||
                (typeof o.official_email === 'string' && o.official_email) ||
                '';
            const em = raw.trim().toLowerCase();
            if (em) {
                const user = await this.userRepository
                    .createQueryBuilder('u')
                    .where('LOWER(TRIM(u.email)) = :em', { em })
                    .andWhere('u.role = :role', { role: UserRole.FACULTY })
                    .getOne();
                if (user?.email) {
                    return [(user.email || '').trim().toLowerCase()];
                }
            }
        }

        return [];
    }

    private normalizeEmailList(values: Array<string | null | undefined>): string[] {
        return Array.from(
            new Set(
                values
                    .map((value) => (value || '').trim().toLowerCase())
                    .filter(Boolean),
            ),
        );
    }

    private normalizeOptionalEmail(value: string | null | undefined): string | undefined {
        const normalized = (value || '').trim().toLowerCase();
        return normalized || undefined;
    }

    private normalizeOptionalString(value: string | null | undefined): string | undefined {
        const normalized = (value || '').trim();
        return normalized || undefined;
    }

    private readTeamIdFromApplyPayload(payload: unknown): string | undefined {
        if (!payload || typeof payload !== 'object') return undefined;
        const record = payload as Record<string, unknown>;
        const raw = record.team_id ?? record.teamId;
        return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
    }

    private generateTeamId(): string {
        const year = new Date().getFullYear();
        const a = crypto.randomBytes(4).toString('hex').toUpperCase();
        const b = crypto.randomBytes(2).toString('hex').toUpperCase();
        return `TM-${year}-${a}-${b}`;
    }

    /** Resolve team slug for team-lead register when legacy rows omitted `teamId`. */
    private async resolveTeamIdForRegistration(
        manager: EntityManager,
        participation: Participation,
        projectId: string,
        studentId: string | null,
        dtoTeamId?: string,
    ): Promise<string | undefined> {
        const direct =
            dtoTeamId ||
            this.normalizeOptionalString(participation.teamId);
        if (direct) return direct;

        if (participation.applicationId) {
            const linkedApp = await manager.findOne(OpportunityApplication, {
                where: { id: participation.applicationId, withdrawnAt: IsNull() },
            });
            const fromLinked = this.readTeamIdFromApplyPayload(linkedApp?.applyPayload);
            if (fromLinked) return fromLinked;
            return participation.applicationId;
        }

        if (studentId) {
            const approvedApp = await manager
                .createQueryBuilder(OpportunityApplication, 'a')
                .where('a.studentUserId = :studentId', { studentId })
                .andWhere('a.opportunityId = :projectId', { projectId })
                .andWhere('a.internalStatus = :status', { status: 'approved' })
                .andWhere('a.withdrawnAt IS NULL')
                .orderBy('a.createdAt', 'DESC')
                .getOne();
            const fromApp = this.readTeamIdFromApplyPayload(approvedApp?.applyPayload);
            if (fromApp) return fromApp;
            if (approvedApp?.id) return approvedApp.id;
        }

        return undefined;
    }

    private normalizeAttendanceApproverType(value: unknown): 'faculty' | 'partner' {
        return value === 'partner' ? 'partner' : 'faculty';
    }

    private hasMeaningfulObjectValue(value: unknown): boolean {
        if (value == null) return false;
        if (typeof value === 'string') return value.trim().length > 0;
        if (typeof value !== 'object') return false;
        return Object.values(value as Record<string, unknown>).some((v) => {
            if (Array.isArray(v)) return v.length > 0;
            if (v && typeof v === 'object') return this.hasMeaningfulObjectValue(v);
            return v != null && String(v).trim() !== '';
        });
    }

    private resolveOpportunityLinkageFacultyEmails(opportunity: Opportunity): string[] {
        const linkage = opportunity.visibility_and_academic_linkage;
        if (!linkage || typeof linkage !== 'object') {
            return [];
        }
        const rep = (linkage as Record<string, unknown>).faculty_institutional_representative;
        if (!rep || typeof rep !== 'object') {
            return [];
        }
        const o = rep as Record<string, unknown>;
        return this.normalizeEmailList([
            typeof o.email === 'string' ? o.email : null,
            typeof o.official_email === 'string' ? o.official_email : null,
            typeof o.faculty_email === 'string' ? o.faculty_email : null,
        ]);
    }

    private async resolveAttendanceApproverTypeForParticipation(
        participation: Participation,
        opportunity?: Opportunity | null,
    ): Promise<'faculty' | 'partner'> {
        const stored = this.normalizeAttendanceApproverType(participation.attendanceApproverType);
        if (participation.attendanceApproverType) {
            return resolveEffectiveAttendanceApproverType(stored, opportunity);
        }

        let app: OpportunityApplication | null = null;
        if (participation.applicationId) {
            app = await this.opportunityApplicationRepository.findOne({
                where: {
                    id: participation.applicationId,
                    withdrawnAt: IsNull(),
                },
            });
        }
        if (!app && participation.studentId) {
            const rows = await this.opportunityApplicationRepository.find({
                where: {
                    studentUserId: participation.studentId,
                    opportunityId: participation.projectId,
                    withdrawnAt: IsNull(),
                },
                order: { createdAt: 'DESC' },
                take: 1,
            });
            app = rows[0] || null;
        }

        const payload = app?.applyPayload || {};
        const resolved = this.normalizeAttendanceApproverType(
            app?.attendanceApproverType || payload.attendance_approver_type,
        );
        const effective = resolveEffectiveAttendanceApproverType(resolved, opportunity);
        participation.attendanceApproverType = effective;
        await this.participantRepository.save(participation);
        return effective;
    }

    /** Partner contacts for routing plus legacy host-org contact used only to resolve assignee user id. */
    private extractPartnerOfficialEmails(opportunity: Opportunity): string[] {
        return this.normalizeEmailList([
            ...extractPartnerContactEmailsForAttendance(opportunity),
            opportunity.organization?.contactEmail,
        ]);
    }

    private async findPartnerRoleUserByEmail(email: string): Promise<User | null> {
        const normalized = email.trim().toLowerCase();
        if (!normalized) return null;
        return this.userRepository
            .createQueryBuilder('user')
            .where('LOWER("user"."email") = :email', { email: normalized })
            .andWhere('user.role IN (:...roles)', {
                roles: [UserRole.NGO, UserRole.CORPORATE, UserRole.ORGANIZATION_ADMIN],
            })
            .getOne();
    }

    /** Any account tied to a partner contact email — used only to attach `assignedApproverUserId` for queue routing. */
    private async findUserIdByPartnerContactEmail(email: string): Promise<string | null> {
        const normalized = email.trim().toLowerCase();
        if (!normalized) return null;
        const u = await this.userRepository
            .createQueryBuilder('user')
            .where('LOWER(TRIM("user"."email")) = :email', { email: normalized })
            .getOne();
        return u?.id ?? null;
    }

    private async resolvePartnerOwnerUserId(opportunity: Opportunity): Promise<string | null> {
        const partnerEmails = this.extractPartnerOfficialEmails(opportunity);
        for (const email of partnerEmails) {
            const partnerUser = await this.findPartnerRoleUserByEmail(email);
            if (partnerUser?.id) {
                return partnerUser.id;
            }
            const byContact = await this.findUserIdByPartnerContactEmail(email);
            if (byContact) {
                return byContact;
            }
        }

        if (opportunity.organizationId) {
            const orgPartnerUser = await this.userRepository
                .createQueryBuilder('user')
                .leftJoin('user.organization', 'organization')
                .where('organization.id = :organizationId', { organizationId: opportunity.organizationId })
                .andWhere('user.role IN (:...roles)', {
                    roles: [UserRole.NGO, UserRole.CORPORATE, UserRole.ORGANIZATION_ADMIN],
                })
                .orderBy('user.createdAt', 'ASC')
                .getOne();
            if (orgPartnerUser?.id) {
                return orgPartnerUser.id;
            }

            const orgMemberUser = await this.userRepository
                .createQueryBuilder('user')
                .leftJoin('user.organization', 'organization')
                .where('organization.id = :organizationId', { organizationId: opportunity.organizationId })
                .andWhere('user.role != :studentRole', { studentRole: UserRole.STUDENT })
                .orderBy('user.createdAt', 'ASC')
                .getOne();
            if (orgMemberUser?.id) {
                return orgMemberUser.id;
            }
        }

        if (!opportunity.isStudentCreated && opportunity.creatorId) {
            const creator = await this.userRepository.findOne({ where: { id: opportunity.creatorId } });
            if (creator && creator.role !== UserRole.STUDENT) {
                return opportunity.creatorId;
            }
        }

        return null;
    }

    private async resolveApplicationFacultyEmails(participation: Participation): Promise<string[]> {
        let app: OpportunityApplication | null = null;

        if (participation.applicationId) {
            app = await this.opportunityApplicationRepository.findOne({
                where: {
                    id: participation.applicationId,
                    withdrawnAt: IsNull(),
                },
            });
        }

        if (!app && participation.studentId) {
            const rows = await this.opportunityApplicationRepository.find({
                where: {
                    studentUserId: participation.studentId,
                    opportunityId: participation.projectId,
                    withdrawnAt: IsNull(),
                },
                order: { createdAt: 'DESC' },
                take: 1,
            });
            app = rows[0] || null;
        }

        if (!app) {
            return [];
        }

        const payload = app.applyPayload || {};
        return this.normalizeEmailList([
            app.primaryFacultyEmail,
            app.secondaryFacultyEmail,
            typeof payload.primary_faculty_email === 'string' ? payload.primary_faculty_email : null,
            typeof payload.secondary_faculty_email === 'string' ? payload.secondary_faculty_email : null,
        ]);
    }

    private async resolveAttendanceVerificationReviewer(
        opportunity: Opportunity,
        participant: Participation,
    ): Promise<{ reviewerType: 'faculty' | 'partner'; reviewerEmail: string }> {
        if (opportunityHasActionablePartnerForAttendance(opportunity)) {
            const partnerEmails = extractPartnerContactEmailsForAttendance(opportunity);
            return {
                reviewerType: 'partner',
                reviewerEmail: partnerEmails[0]!.trim().toLowerCase(),
            };
        }

        const facultyEmails = await this.resolveFacultyEmailsForAttendanceRouting(participant, opportunity);
        if (facultyEmails.length > 0) {
            return { reviewerType: 'faculty', reviewerEmail: facultyEmails[0] };
        }

        throw new BadRequestException('Unable to resolve reviewer for this project');
    }

    /**
     * Pending partner attendance still pointing at a stale `assignedApproverUserId` after the
     * project partner contact or org owner changed — rebind to the current partner queue owner.
     */
    async reconcilePartnerAttendanceAssigneeForOpportunity(opportunity: Opportunity): Promise<void> {
        if (!opportunityHasActionablePartnerForAttendance(opportunity)) {
            return;
        }

        const expectedUserId = await this.resolvePartnerOwnerUserId(opportunity);
        if (!expectedUserId) {
            return;
        }

        const pendingPartnerLogs = await this.attendanceLogRepository.find({
            where: {
                projectId: opportunity.id,
                approvalStatus: 'pending',
                assignedApproverType: 'partner',
            },
        });

        const stale = pendingPartnerLogs.filter(
            (log) => log.assignedApproverUserId !== expectedUserId,
        );
        if (!stale.length) {
            return;
        }

        for (const log of stale) {
            log.assignedApproverUserId = expectedUserId;
            log.opportunityCreatorKind = 'partner';
        }
        await this.attendanceLogRepository.save(stale);
    }

    /**
     * Pending attendance routed to partner when the project has no partner contact email
     * (e.g. only host organizationId). Reassigns logs and seats to faculty review.
     */
    async reconcileMisroutedPartnerAttendanceForOpportunity(opportunity: Opportunity): Promise<void> {
        if (!opportunity.isStudentCreated || opportunityHasActionablePartnerForAttendance(opportunity)) {
            return;
        }

        const pendingPartnerLogs = await this.attendanceLogRepository.find({
            where: {
                projectId: opportunity.id,
                approvalStatus: 'pending',
                assignedApproverType: 'partner',
            },
            relations: ['participant'],
        });

        await this.participantRepository.update(
            { projectId: opportunity.id, attendanceApproverType: 'partner' },
            { attendanceApproverType: 'faculty' },
        );

        if (!pendingPartnerLogs.length) {
            return;
        }

        for (const log of pendingPartnerLogs) {
            let assignedFacultyUserId: string | null = null;
            if (log.participant) {
                const facultyEmails = await this.resolveFacultyEmailsForAttendanceRouting(
                    log.participant,
                    opportunity,
                );
                for (const facultyEmail of facultyEmails) {
                    const facultyUser = await this.userRepository
                        .createQueryBuilder('user')
                        .where('LOWER("user"."email") = :facultyEmail', { facultyEmail })
                        .andWhere('"user"."role" = :facultyRole', { facultyRole: UserRole.FACULTY })
                        .getOne();
                    if (facultyUser?.id) {
                        assignedFacultyUserId = facultyUser.id;
                        break;
                    }
                }
            }

            log.assignedApproverType = 'faculty';
            log.assignedApproverUserId = assignedFacultyUserId;
            log.opportunityCreatorKind = 'faculty';
        }

        await this.attendanceLogRepository.save(pendingPartnerLogs);
    }
}

import { Test, TestingModule } from '@nestjs/testing';
import { EngagementService } from './engagement.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Participation } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { User } from '../users/entities/user.entity';
// import { OpportunityTeamMember } from '../opportunities/entities/opportunity-team-member.entity';
import { ConfigService } from '@nestjs/config';
import { S3Service } from '../common/s3.service';
import { MailService } from '../mail/mail.service';
import { UserRole } from '../users/enums/user-role.enum';
import {
    buildFacultyUserQueryBuilder,
    engagementSpecContext,
    mockRoleAwareUserQueryBuilders,
    normalizeTestEmail,
    standardAttendanceDto,
} from './engagement.service.spec.fixtures';

/** Shorthand: fresh emails/ids per test (never hard-code real domains). */
const fx = engagementSpecContext;

describe('EngagementService', () => {
    let service: EngagementService;

    const mockParticipationRepository = {
        findOne: jest.fn(),
        find: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
    };

    const mockAttendanceLogRepository = {
        create: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
    };

    const mockOpportunityRepository = {
        findOne: jest.fn(),
    };

    const mockOpportunityApplicationRepository = {
        findOne: jest.fn(),
        find: jest.fn(),
    };

    const mockUserRepository = {
        findOne: jest.fn(),
        createQueryBuilder: jest.fn(),
    };

    // const mockTeamMemberRepository = {
    //     findOne: jest.fn(),
    // };

    const mockConfigService = {
        get: jest.fn().mockReturnValue('test-secret-key-32-chars-long-!!!'),
    };

    const mockS3Service = {
        uploadFile: jest.fn(),
    };

    const mockMailService = {
        sendFacultyInvite: jest.fn(),
        sendFacultyApprovalRequest: jest.fn(),
        sendFacultyCollaboratorNotice: jest.fn(),
        sendAttendancePendingPartnerReview: jest.fn(),
        sendAttendancePendingReview: jest.fn(),
        sendAttendancePendingAdminReview: jest.fn(),
        sendAttendanceVerificationRequestNotice: jest.fn(),
    };

    const mockParticipationQueryBuilder = (result: Participation | null) => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(result),
    });

    beforeEach(async () => {
        mockOpportunityApplicationRepository.findOne.mockResolvedValue(null);
        mockOpportunityApplicationRepository.find.mockResolvedValue([]);
        mockMailService.sendAttendancePendingReview.mockClear();
        mockUserRepository.createQueryBuilder.mockReturnValue(
            buildFacultyUserQueryBuilder(fx('module-default')) as never,
        );

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EngagementService,
                {
                    provide: getRepositoryToken(Participation),
                    useValue: mockParticipationRepository,
                },
                {
                    provide: getRepositoryToken(AttendanceLog),
                    useValue: mockAttendanceLogRepository,
                },
                {
                    provide: getRepositoryToken(Opportunity),
                    useValue: mockOpportunityRepository,
                },
                {
                    provide: getRepositoryToken(OpportunityApplication),
                    useValue: mockOpportunityApplicationRepository,
                },
                {
                    provide: getRepositoryToken(User),
                    useValue: mockUserRepository,
                },
                // {
                //     provide: getRepositoryToken(OpportunityTeamMember),
                //     useValue: mockTeamMemberRepository,
                // },
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
                {
                    provide: S3Service,
                    useValue: mockS3Service,
                },
                {
                    provide: MailService,
                    useValue: mockMailService,
                },
            ],
        }).compile();

        service = module.get<EngagementService>(EngagementService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('getEngagementMetrics', () => {
        it('should calculate metrics correctly', async () => {
            const mockLogs: any[] = [
                { dateOfEngagement: '2023-10-01', sessionHours: 4, evidenceUploaded: true },
                { dateOfEngagement: '2023-10-02', sessionHours: 4, evidenceUploaded: true },
                { dateOfEngagement: '2023-10-08', sessionHours: 4, evidenceUploaded: false },
            ];

            mockParticipationRepository.findOne.mockResolvedValue({
                id: 'participation-id',
                attendanceLogs: mockLogs,
            });

            const metrics = await service.getEngagementMetrics('participation-id');

            expect(metrics.totalHours).toBe(12);
            expect(metrics.activeDays).toBe(3);
            expect(metrics.spanWeeks).toBe(2);
            expect(metrics.frequency).toBe(1.5);
            expect(metrics.weeklyContinuity).toBe(100);
            expect(metrics.eis).toBeGreaterThan(0);
        });
    });

    describe('getProjectTeam', () => {
        it('should include faculty email aliases in team response', async () => {
            const t = fx('team-faculty-aliases');
            mockParticipationRepository.find.mockResolvedValue([
                {
                    id: t.id.lead,
                    projectId: t.id.project,
                    isTeamLead: true,
                    teamId: null,
                    primaryFacultyEmail: t.email.facultyMixed,
                    secondaryFacultyEmail: null,
                },
                {
                    id: t.id.member,
                    projectId: t.id.project,
                    isTeamLead: false,
                    teamId: null,
                    primaryFacultyEmail: null,
                    secondaryFacultyEmail: null,
                },
            ]);

            const result = await service.getProjectTeam(t.id.project);

            expect(result).toEqual([
                expect.objectContaining({
                    id: t.id.lead,
                    teamId: t.id.lead,
                    team_id: t.id.lead,
                    facultyEmail: normalizeTestEmail(t.email.facultyMixed),
                    primary_faculty_email: t.email.facultyMixed,
                }),
                expect.objectContaining({
                    id: t.id.member,
                    teamId: t.id.lead,
                    team_id: t.id.lead,
                    facultyEmail: normalizeTestEmail(t.email.facultyMixed),
                    primaryFacultyEmail: normalizeTestEmail(t.email.facultyMixed),
                    primary_faculty_email: normalizeTestEmail(t.email.facultyMixed),
                }),
            ]);
        });

        it('should include team aliases in my participation response', async () => {
            const t = fx('my-participation-aliases');
            mockParticipationRepository.find
                .mockResolvedValueOnce([
                    {
                        id: t.id.lead,
                        projectId: t.id.project,
                        studentId: t.id.u1,
                        isTeamLead: true,
                        teamId: null,
                        primaryFacultyEmail: t.email.faculty,
                        attendanceLogs: [],
                    },
                ])
                .mockResolvedValueOnce([
                    {
                        id: t.id.lead,
                        projectId: t.id.project,
                        studentId: t.id.u1,
                        isTeamLead: true,
                        teamId: null,
                        primaryFacultyEmail: t.email.faculty,
                    },
                    {
                        id: t.id.member,
                        projectId: t.id.project,
                        studentId: t.id.u2,
                        isTeamLead: false,
                        teamId: null,
                        primaryFacultyEmail: null,
                    },
                ]);

            const result = await service.getMyParticipants(t.id.u1);

            expect(result).toEqual([
                expect.objectContaining({
                    id: t.id.lead,
                    teamId: t.id.lead,
                    team_id: t.id.lead,
                    primary_faculty_email: t.email.faculty,
                }),
            ]);
        });
    });

    describe('listPendingAttendanceLogs', () => {
        const qbStub = (): any => ({
            leftJoinAndSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            getMany: jest.fn(),
        });

        let qbChain: ReturnType<typeof qbStub>;

        beforeEach(() => {
            qbChain = qbStub();
            (mockAttendanceLogRepository as unknown as Record<string, unknown>).createQueryBuilder = jest
                .fn()
                .mockReturnValue(qbChain);
            mockParticipationRepository.find.mockReset();
        });

        afterEach(() => {
            delete (mockAttendanceLogRepository as unknown as Record<string, unknown>).createQueryBuilder;
        });

        it.skip('hydrates missing participant.teamId / team_id from roster parity before returning logs', async () => {
            const t = fx('pending-roster-hydrate');
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.partnerActor,
                email: t.email.ngoOwner,
                organization: { id: t.id.org },
            });

            mockOpportunityRepository.findOne.mockResolvedValue({ id: t.id.projectRoster });

            const rosterLead: Partial<Participation> & { id: string; projectId: string } = {
                id: `${t.id.lead}-p`,
                projectId: t.id.projectRoster,
                isTeamLead: true,
                teamId: t.id.teamId,
                applicationId: undefined,
                participationMode: 'team',
                status: 'approved',
            };

            const rosterMember: Partial<Participation> & {
                id: string;
                projectId: string;
                email?: string;
            } = {
                id: `${t.id.member}-p`,
                projectId: t.id.projectRoster,
                isTeamLead: false,
                teamId: null as unknown as string,
                applicationId: undefined,
                participationMode: 'team',
                status: 'approved',
                email: t.email.rosterMember,
            };

            mockParticipationRepository.find.mockResolvedValue([rosterLead, rosterMember] as Participation[]);

            const attendeeParticipant = {
                ...rosterMember,
                studentId: `${t.id.student}-db`,
            } as Participation;

            const attendanceLogStub = {
                id: `log-${t.tag}`,
                projectId: t.id.projectRoster,
                approvalStatus: 'pending',
                assignedApproverType: 'partner',
                assignedApproverUserId: t.id.partnerActor,
                participant: attendeeParticipant,
                project: { organizationId: t.id.org },
            } as unknown as AttendanceLog;

            qbChain.getMany.mockResolvedValue([attendanceLogStub]);

            const result = await service.listPendingAttendanceLogs(
                t.id.partnerActor,
                UserRole.NGO,
                t.id.projectRoster,
            );

            expect(mockAttendanceLogRepository.createQueryBuilder).toHaveBeenCalled();
            expect(mockParticipationRepository.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ projectId: t.id.projectRoster }),
                    order: { createdAt: 'ASC' },
                }),
            );
            expect(result.pending).toHaveLength(1);

            type PartWithLegacy = Participation & { team_id?: string | null };

            expect((result.pending![0].participant as PartWithLegacy).teamId).toBe(t.id.teamId);
            expect((result.pending![0].participant as PartWithLegacy).team_id).toBe(t.id.teamId);
        });
    });

    describe('EIS Engine Logic', () => {
        it('should give 100 for perfect engagement', async () => {
            const mockLogs: any[] = [];
            for (let i = 0; i < 16; i++) {
                const date1 = new Date(2023, 0, 1 + (i * 7));
                const date2 = new Date(2023, 0, 2 + (i * 7));
                mockLogs.push({ dateOfEngagement: date1.toISOString().split('T')[0], sessionHours: 1.5, evidenceUploaded: true });
                mockLogs.push({ dateOfEngagement: date2.toISOString().split('T')[0], sessionHours: 1.5, evidenceUploaded: true });
            }

            mockParticipationRepository.findOne.mockResolvedValue({
                id: 'participation-id',
                attendanceLogs: mockLogs,
            });

            const metrics = await service.getEngagementMetrics('participation-id');
            expect(metrics.eis).toBe(100);
        });
    });

    describe('addAttendanceLog', () => {
        it('should create and save an attendance log', async () => {
            const t = fx('create-attendance-log');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.u1,
                projectId: t.id.project,
                status: 'approved',
                primaryFacultyEmail: t.email.faculty,
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.title,
                creatorId: t.id.faculty,
                organization: null,
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.faculty,
                role: 'faculty',
                name: t.name.faculty,
            });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });

            const result = await service.addAttendanceLog(t.id.u1, t.id.participation, dto);

            expect(result).toBeDefined();
            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    participantId: t.id.participation,
                    projectId: t.id.project,
                    sessionHours: 3,
                    approvalStatus: 'pending',
                    assignedApproverType: 'faculty',
                }),
            );
            expect(mockAttendanceLogRepository.save).toHaveBeenCalled();
        });

        it('should create attendance log when participation has no faculty emails but project has facultyId', async () => {
            const t = fx('attendance-linked-faculty');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.u1,
                projectId: t.id.project,
                status: 'approved',
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.title,
                facultyId: t.id.linkedFaculty,
                creatorId: t.id.u1,
                organization: null,
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.linkedFaculty,
                email: t.email.linkedFaculty,
                role: UserRole.FACULTY,
                name: t.name.faculty,
            });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });

            const result = await service.addAttendanceLog(t.id.u1, t.id.participation, dto);

            expect(result).toBeDefined();
            expect(mockAttendanceLogRepository.save).toHaveBeenCalled();
        });

        it('should backfill faculty emails from the approved application before routing attendance', async () => {
            const t = fx('backfill-faculty-from-app');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.u1,
                projectId: t.id.project,
                applicationId: t.id.app,
                status: 'approved',
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockParticipationRepository.save.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.title,
                facultyId: null,
                supervision: null,
                organization: null,
            });
            mockOpportunityApplicationRepository.findOne.mockResolvedValue({
                id: t.id.app,
                opportunityId: t.id.project,
                studentUserId: t.id.u1,
                primaryFacultyEmail: t.email.facultyMixed,
                secondaryFacultyEmail: null,
                applyPayload: {},
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.faculty,
                role: UserRole.FACULTY,
                name: t.name.faculty,
            });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });

            const result = await service.addAttendanceLog(t.id.u1, t.id.participation, dto);

            expect(result).toBeDefined();
            expect(mockParticipationRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    primaryFacultyEmail: normalizeTestEmail(t.email.facultyMixed),
                }),
            );
            expect(mockAttendanceLogRepository.save).toHaveBeenCalled();
        });

        it('should route attendance to the partner owner when requested on the participation', async () => {
            const t = fx('partner-owner-route');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.u1,
                projectId: t.id.project,
                status: 'approved',
                attendanceApproverType: 'partner',
                email: t.email.student,
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.title,
                creatorId: t.id.partner,
                isStudentCreated: false,
                organization: null,
            });
            mockUserRepository.findOne
                .mockResolvedValueOnce({ id: t.id.u1, email: t.email.student, name: t.name.student })
                .mockResolvedValueOnce({
                    id: t.id.partner,
                    email: t.email.partner,
                    name: t.name.partner,
                    role: UserRole.NGO,
                });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });

            const result = await service.addAttendanceLog(t.id.u1, t.id.participation, dto);

            expect(result).toBeDefined();
            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    participantId: t.id.participation,
                    projectId: t.id.project,
                    sessionHours: 3,
                    approvalStatus: 'pending',
                    assignedApproverType: 'partner',
                    assignedApproverUserId: t.id.partner,
                }),
            );
        });

        it('should not email the student creator for student-created partner projects', async () => {
            const t = fx('student-created-partner-mail');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.student,
                email: t.email.student,
                projectId: t.id.project,
                status: 'approved',
                attendanceApproverType: 'partner',
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.projectTitleStudent,
                creatorId: t.id.student,
                isStudentCreated: true,
                organizationId: t.id.org,
                supervision: {
                    partner_email: t.email.partner,
                    partner_contact_person: t.name.partnerContact,
                },
                partner_organization: {
                    official_email: t.email.partner,
                    contact_person: t.name.partnerContact,
                },
            });

            const partnerQb = {
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                leftJoin: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockReturnThis(),
                getOne: jest.fn().mockResolvedValue({
                    id: t.id.partnerUser,
                    email: t.email.partner,
                    name: t.name.partnerContact,
                    role: UserRole.NGO,
                }),
            };
            mockUserRepository.createQueryBuilder.mockReturnValue(partnerQb as any);
            mockUserRepository.findOne.mockImplementation(async (opts: { where?: { id?: string } }) => {
                const id = opts?.where?.id;
                if (id === t.id.student) {
                    return {
                        id: t.id.student,
                        email: t.email.student,
                        name: t.name.studentDisplay,
                        role: UserRole.STUDENT,
                    };
                }
                if (id === t.id.partnerUser) {
                    return {
                        id: t.id.partnerUser,
                        email: t.email.partner,
                        name: t.name.partnerContact,
                        role: UserRole.NGO,
                    };
                }
                return null;
            });
            mockParticipationRepository.save.mockImplementation(async (p) => p);
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });
            mockMailService.sendAttendancePendingReview.mockClear();

            await service.addAttendanceLog(t.id.student, t.id.participation, dto);
            await new Promise((resolve) => setImmediate(resolve));

            expect(mockMailService.sendAttendancePendingReview).toHaveBeenCalledWith(
                t.email.partner,
                expect.any(String),
                'partner',
                t.name.studentDisplay,
                t.projectTitleStudent,
                t.id.project,
            );
            expect(mockMailService.sendAttendancePendingReview).not.toHaveBeenCalledWith(
                t.email.student,
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.anything(),
            );
            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    assignedApproverUserId: t.id.partnerUser,
                }),
            );
        });

        it('should fall back to faculty routing when partner route has no partner contact but faculty emails exist', async () => {
            const t = fx('fallback-faculty-no-partner-contact');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.student,
                email: t.email.student,
                projectId: t.id.project,
                status: 'approved',
                attendanceApproverType: 'partner',
                primaryFacultyEmail: t.email.faculty,
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.projectTitleStudent,
                creatorId: t.id.student,
                isStudentCreated: true,
                supervision: null,
                partner_organization: null,
                organization: null,
            });

            mockRoleAwareUserQueryBuilders(mockUserRepository, {
                partner: () => null,
                faculty: () => ({
                    id: t.id.facultyUser,
                    email: t.email.faculty,
                    role: UserRole.FACULTY,
                }),
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.student,
                email: t.email.student,
                name: t.name.student,
                role: UserRole.STUDENT,
            });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });

            await service.addAttendanceLog(t.id.student, t.id.participation, dto);

            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    assignedApproverType: 'faculty',
                    assignedApproverUserId: t.id.facultyUser,
                }),
            );
        });

        it('should route to faculty when only organization contact email exists and partner JSON is empty', async () => {
            const t = fx('faculty-only-org-host-contact');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.student,
                email: t.email.student,
                projectId: t.id.project,
                status: 'approved',
                attendanceApproverType: 'partner',
                primaryFacultyEmail: t.email.faculty,
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockParticipationRepository.save.mockImplementation(async (p) => p);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.projectTitleStudent,
                creatorId: t.id.student,
                isStudentCreated: true,
                organizationId: t.id.org,
                organization: { id: t.id.org, contactEmail: t.email.orgHostContact },
                supervision: {},
                partner_organization: null,
            });

            mockRoleAwareUserQueryBuilders(mockUserRepository, {
                partner: () => null,
                faculty: () => ({
                    id: t.id.facultyUser,
                    email: t.email.faculty,
                    role: UserRole.FACULTY,
                }),
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.student,
                email: t.email.student,
                name: t.name.student,
                role: UserRole.STUDENT,
            });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });
            mockMailService.sendAttendancePendingReview.mockClear();

            await service.addAttendanceLog(t.id.student, t.id.participation, dto);
            await new Promise((resolve) => setImmediate(resolve));

            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    assignedApproverType: 'faculty',
                }),
            );
            expect(mockMailService.sendAttendancePendingReview).not.toHaveBeenCalledWith(
                t.email.orgHostContact,
                expect.anything(),
                'partner',
                expect.anything(),
                expect.anything(),
                expect.anything(),
            );
        });

        it('should route and email partner when project has partner org email even if participation stored faculty', async () => {
            const t = fx('partner-org-email-overrides-faculty-seat');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.student,
                email: t.email.student,
                projectId: t.id.project,
                status: 'approved',
                attendanceApproverType: 'faculty',
                primaryFacultyEmail: t.email.supervisor,
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockParticipationRepository.save.mockImplementation(async (p) => p);
            mockUserRepository.findOne.mockReset();
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.projectTitlePartner,
                creatorId: t.id.student,
                isStudentCreated: true,
                organizationId: t.id.org,
                partner_organization: {
                    organization_name: `Org ${t.tag}`,
                    contact_person_name: t.name.partnerContact,
                    official_email: t.email.partnerOrg,
                },
                supervision: {},
            });

            const partnerQb = {
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                leftJoin: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockReturnThis(),
                getOne: jest.fn().mockResolvedValue(null),
            };
            mockUserRepository.createQueryBuilder.mockReturnValue(partnerQb as any);
            mockUserRepository.findOne.mockImplementation(async (opts: { where?: { id?: string } }) => {
                if (opts?.where?.id === t.id.student) {
                    return {
                        id: t.id.student,
                        email: t.email.student,
                        name: t.name.studentDisplay,
                        role: UserRole.STUDENT,
                    };
                }
                return null;
            });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });
            mockMailService.sendAttendancePendingReview.mockClear();

            await service.addAttendanceLog(t.id.student, t.id.participation, dto);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            expect(mockParticipationRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({ attendanceApproverType: 'partner' }),
            );
            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ assignedApproverType: 'partner' }),
            );
            expect(mockMailService.sendAttendancePendingReview).toHaveBeenCalledWith(
                t.email.partnerOrg,
                expect.any(String),
                'partner',
                t.name.studentDisplay,
                t.projectTitlePartner,
                t.id.project,
            );
            expect(mockMailService.sendAttendancePendingReview).not.toHaveBeenCalledWith(
                t.email.supervisor,
                expect.anything(),
                'faculty',
                expect.anything(),
                expect.anything(),
                expect.anything(),
            );
        });

        it('should fall back to faculty when partner route has organizationId but no partner contact', async () => {
            const t = fx('fallback-faculty-org-id-only');
            const mockParticipation = {
                id: t.id.participation,
                studentId: t.id.student,
                email: t.email.student,
                projectId: t.id.project,
                status: 'approved',
                attendanceApproverType: 'partner',
                primaryFacultyEmail: t.email.faculty,
            };
            const dto = { ...standardAttendanceDto } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.projectTitleStudent,
                creatorId: t.id.student,
                isStudentCreated: true,
                organizationId: t.id.org,
                organization: { id: t.id.org, contactEmail: null },
                supervision: {},
                partner_organization: null,
                visibility_and_academic_linkage: null,
            });

            mockRoleAwareUserQueryBuilders(mockUserRepository, {
                partner: () => null,
                faculty: () => ({
                    id: t.id.facultyUser,
                    email: t.email.faculty,
                    role: UserRole.FACULTY,
                }),
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.student,
                email: t.email.student,
                name: t.name.student,
                role: UserRole.STUDENT,
            });
            mockAttendanceLogRepository.create.mockReturnValue({
                ...dto,
                participantId: t.id.participation,
                projectId: t.id.project,
                sessionHours: 3,
            });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: `log-${t.tag}`, ...dto });

            await service.addAttendanceLog(t.id.student, t.id.participation, dto);

            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    assignedApproverType: 'faculty',
                    assignedApproverUserId: t.id.facultyUser,
                }),
            );
        });

        it('should throw when no faculty email on participation and project cannot resolve faculty', async () => {
            const mockParticipation = {
                id: 'p1',
                studentId: 'u1',
                projectId: 'proj1',
                status: 'approved',
            };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '09:00',
                endTime: '10:00',
                description: 'Short valid description here.',
                organizationName: 'Org',
                activityType: 'Activity',
            } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: 'proj1',
                title: 'Project',
                facultyId: null,
                supervision: null,
                organization: null,
            });
            mockUserRepository.findOne.mockResolvedValue(null);

            await expect(service.addAttendanceLog('u1', 'p1', dto)).rejects.toThrow(
                'Attendance approval needs a supervising faculty',
            );
        });

        it('should throw error if session exceeds 12 hours', async () => {
            const mockParticipation = { id: 'p1', studentId: 'u1', status: 'approved' };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '08:00',
                endTime: '21:00',
                description: 'Desc',
            } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);

            await expect(service.addAttendanceLog('u1', 'p1', dto)).rejects.toThrow('Daily attendance cannot exceed 12 hours');
        });

        it('should throw error if participation is not approved', async () => {
            const mockParticipation = { id: 'p1', studentId: 'u1', status: 'pending_ciel_approval' };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '09:00',
                endTime: '10:00',
                description: 'Desc',
            } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);

            await expect(service.addAttendanceLog('u1', 'p1', dto)).rejects.toThrow('Attendance logging is only allowed for approved/verified records');
        });
    });

    describe('createAttendanceVerifyRequest', () => {
        it('should reject non-privileged user targeting another participant by participantId', async () => {
            const t = fx('verify-reject-cross-participant');
            const dto = {
                projectId: t.id.project,
                participantId: `${t.id.participation}-other`,
                requestedAt: '2026-04-27T06:40:00.000Z',
            } as any;

            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.title,
            });
            mockParticipationRepository.findOne.mockResolvedValue({
                id: `${t.id.participation}-other`,
                projectId: t.id.project,
                studentId: null,
                email: t.email.victim,
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.student,
                email: t.email.attacker,
                role: 'student',
            });

            await expect(
                service.createAttendanceVerifyRequest(t.id.student, 'student', t.id.project, dto),
            ).rejects.toThrow('Not authorized to request attendance verification');
        });

        it('should reject faculty user with no project linkage targeting another participant', async () => {
            const t = fx('verify-reject-unlinked-faculty');
            const dto = {
                projectId: t.id.project,
                participantId: `${t.id.participation}-victim`,
                requestedAt: '2026-04-27T06:40:00.000Z',
            } as any;

            const mockAppQb = {
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                getCount: jest.fn().mockResolvedValue(0),
            };
            (mockOpportunityRepository as any).manager = {
                getRepository: jest.fn().mockReturnValue({
                    createQueryBuilder: jest.fn().mockReturnValue(mockAppQb),
                }),
            };
            (mockParticipationRepository as any).createQueryBuilder = jest.fn().mockReturnValue({
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                getCount: jest.fn().mockResolvedValue(0),
            });

            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.title,
                creatorId: t.id.partner,
                facultyId: null,
                organizationId: t.id.org,
            });
            mockParticipationRepository.findOne.mockResolvedValue({
                id: `${t.id.participation}-victim`,
                projectId: t.id.project,
                studentId: `${t.id.student}-victim`,
                email: t.email.victim,
                primaryFacultyEmail: t.email.supervisor,
                attendanceVerificationRequested: false,
                attendanceLocked: false,
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: `${t.id.faculty}-random`,
                email: t.email.evilFaculty,
                role: UserRole.FACULTY,
                organization: null,
            });

            await expect(
                service.createAttendanceVerifyRequest(`${t.id.faculty}-random`, UserRole.FACULTY, t.id.project, dto),
            ).rejects.toThrow('Not authorized to request attendance verification');

            delete (mockOpportunityRepository as any).manager;
            delete (mockParticipationRepository as any).createQueryBuilder;
        });

        it('should allow non-privileged user when unclaimed participant email matches actor', async () => {
            const t = fx('verify-allow-matching-email');
            const dto = {
                projectId: t.id.project,
                participantId: t.id.participation,
                requestedAt: '2026-04-27T06:40:00.000Z',
            } as any;

            mockOpportunityRepository.findOne.mockResolvedValue({
                id: t.id.project,
                title: t.title,
                facultyId: null,
                organizationId: null,
                partner_organization: null,
                executing_organization: null,
                supervision: null,
            });
            mockParticipationRepository.findOne.mockResolvedValue({
                id: t.id.participation,
                projectId: t.id.project,
                studentId: null,
                email: t.email.student,
                primaryFacultyEmail: t.email.faculty,
                attendanceVerificationRequested: true,
                attendanceLocked: true,
                attendanceVerificationEmailSentAt: null,
                attendanceVerificationReviewerType: null,
            });
            mockUserRepository.findOne.mockResolvedValue({
                id: t.id.student,
                email: t.email.student,
                role: 'student',
            });

            const result = await service.createAttendanceVerifyRequest(t.id.student, 'student', t.id.project, dto);
            expect(result).toEqual(
                expect.objectContaining({
                    type: 'already_requested',
                }),
            );
        });
    });

    describe('registerParticipant', () => {
        it('should create a NEW record if the email is different, even for same studentId', async () => {
            const t = fx('register-new-email');
            const studentId = t.id.u1;
            const projectId = t.id.project;
            const dto = {
                projectId,
                email: t.email.newParticipant,
                fullName: t.name.teamMember,
                cnic: '1234567890123',
                mobile: '03001234567',
            } as any;

            const mockOpportunity = { id: projectId, title: t.title, status: 'active', admin_approved: true };
            
            // Mock transaction manager
            const mockManager = {
                findOne: jest.fn()
                    .mockResolvedValueOnce(null) // User by email
                    .mockResolvedValueOnce(mockOpportunity) // Opportunity
                    .mockResolvedValueOnce(null), // existingByCnic
                createQueryBuilder: jest.fn().mockReturnValue(mockParticipationQueryBuilder(null)),
                create: jest.fn().mockReturnValue({}),
                save: jest.fn().mockImplementation((entity, data) => ({ id: 'new-id', ...data })),
            };

            (mockParticipationRepository as any).manager = {
                transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
            };

            const result = await service.registerParticipant(studentId, dto);

            expect(result).toBeDefined();
            expect(mockManager.create).toHaveBeenCalled();
            expect(mockManager.save).toHaveBeenCalled();
        });

        it('should OVERRIDE if the email matches', async () => {
            const t = fx('register-override-email');
            const studentId = t.id.u1;
            const projectId = t.id.project;
            const dto = {
                projectId,
                email: t.email.existing,
                fullName: `${t.name.teamMember} Updated`,
                cnic: '1234567890123',
                mobile: '03001234567',
            } as any;

            const mockOpportunity = { id: projectId, title: t.title, status: 'active', admin_approved: true };
            const existingParticipation = { id: `old-${t.tag}`, email: t.email.existing };

            // Mock transaction manager
            const mockManager = {
                findOne: jest.fn()
                    .mockResolvedValueOnce(null) // User by email
                    .mockResolvedValueOnce(mockOpportunity) // Opportunity
                    .mockResolvedValueOnce(null), // existingByCnic
                createQueryBuilder: jest
                    .fn()
                    .mockReturnValue(mockParticipationQueryBuilder(existingParticipation as Participation)),
                create: jest.fn(),
                save: jest.fn().mockImplementation((entity, data) => ({ ...data })),
            };

            (mockParticipationRepository as any).manager = {
                transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
            };

            const result = await service.registerParticipant(studentId, dto);

            expect(result).toBeDefined();
            expect(mockManager.create).not.toHaveBeenCalled();
            expect(mockManager.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                fullName: `${t.name.teamMember} Updated`,
            }));
        });

        it('should map snake_case faculty emails onto participation columns', async () => {
            const t = fx('register-faculty-snake-case');
            const studentId = t.id.u1;
            const projectId = t.id.project;
            const dto = {
                projectId,
                participationMode: 'team',
                isTeamLead: false,
                email: t.email.member,
                fullName: t.name.teamMember,
                cnic: '1234567890123',
                mobile: '03001234567',
                primary_faculty_email: t.email.facultyMixed,
                secondary_faculty_email: t.email.cofaculty,
                team_id: t.id.teamId,
            } as any;

            const mockOpportunity = { id: projectId, title: t.title, status: 'active', admin_approved: true };
            const mockManager = {
                findOne: jest.fn()
                    .mockResolvedValueOnce(null) // User by email
                    .mockResolvedValueOnce(mockOpportunity) // Opportunity
                    .mockResolvedValueOnce(null) // existingByCnic
                    .mockResolvedValueOnce({ name: t.name.teamMember }), // Student for email display
                createQueryBuilder: jest.fn().mockReturnValue(mockParticipationQueryBuilder(null)),
                create: jest.fn().mockReturnValue({}),
                save: jest.fn().mockImplementation((entity, data) => ({ id: 'new-id', ...data })),
            };

            (mockParticipationRepository as any).manager = {
                transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
            };

            await service.registerParticipant(studentId, dto);

            expect(mockManager.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                primaryFacultyEmail: normalizeTestEmail(t.email.facultyMixed),
                secondaryFacultyEmail: normalizeTestEmail(t.email.cofaculty),
                teamId: t.id.teamId,
            }));
            expect(mockMailService.sendFacultyApprovalRequest).toHaveBeenCalledWith(
                normalizeTestEmail(t.email.facultyMixed),
                t.name.teamMember,
                t.title,
                'new-id',
            );
        });
    });
});

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StudentReportsService } from './student-reports.service';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { StudentReport } from './entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { User } from '../users/entities/user.entity';
import { Payment } from '../payments/entities/payment.entity';
import { S3Service } from '../common/s3.service';
import { EngagementService } from '../engagement/engagement.service';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { ReportPartnerApprovalSettingsService } from './report-partner-approval-settings.service';
import { evaluateReportRequiresPartnerApproval } from './report-partner-approval.util';

/** Minimal section1/2/4/5/6/7/8/9/10 payload that passes server submit validation. */
const MIN_VALID_SUBMIT_SECTIONS = {
  section1: { privacy_consent: true, review_checked: [true, true, true] },
  section2: {
    problem_statement:
      'Community lacks access to clean drinking water, and many households have relied on unsafe open wells for years, leading to repeated illness among children and elderly residents during the dry season.',
    discipline: 'Environmental Engineering',
    discipline_contribution:
      'Engineering methods were used to design, install and pressure-test the filtration units, then train household members on routine cleaning and maintenance procedures.',
    affected_group: 'Households without safe water',
    affected_count: '40',
    system_gaps: ['Access'],
    baseline_evidence: ['Survey'],
  },
  section3: {
    contribution_intent_statement:
      'Students will support safer water handling in the host community by installing household filtration units, demonstrating correct usage, and documenting baseline and follow-up water quality readings so that the partner organization can track improvement over the coming months and plan further interventions where needed.',
  },
  section4: {
    activity_blocks: [
      {
        title: 'Water filter installation',
        primary_category: 'Infrastructure',
        sub_category: 'Water / Sanitation Infrastructure',
        status: 'Completed',
        description:
          'Installed household water filters across five homes, showed each family how to assemble, clean and use the units correctly, and answered questions about ongoing maintenance.',
        outputs: [{ title: 'Filters installed', quantity: '5' }],
      },
    ],
    project_summary: {
      distinct_total_beneficiaries: 50,
      counting_method: 'Headcount',
    },
  },
  section5: {
    observed_change:
      'Households report improved water quality and fewer stomach illnesses since the filters were installed, with several families noting that children miss fewer school days and that water now looks and tastes noticeably cleaner than before the project began, according to informal household feedback collected during follow-up visits.',
    challenges:
      'Replacement parts were hard to find locally in the first week, and the team had to travel to a neighboring town to source the correct filter cartridges before installation could continue.',
    measurable_outcomes: [
      {
        outcome_area: 'Health',
        outcome_sub_category: 'Water quality',
        metric_category: 'Health outcome',
        metric: 'Households served',
        baseline: 0,
        endline: 50,
        unit: 'households',
        confidence_level: ['Directly Measured'],
        measurement_explanation:
          "Counted directly from the partner organization's household register, which was updated and cross-checked by the team at each site visit during the project.",
      },
    ],
  },
  section6: { use_resources: 'no' as const },
  section7: { has_partners: 'no' as const },
  section8: {
    has_evidence: 'no' as const,
    media_visible: 'internal' as const,
    ethical_compliance: {
      authentic: true,
      informed_consent: true,
      no_harm: true,
      privacy_respected: true,
    },
  },
  section9: {
    academic_integration: 'Course-linked assignment',
    skills_grown: ['💬 Communication'],
    reflection_biggest_learning: 'listening to the community',
    reflection_moment: 'children choosing books on day one',
    reflection_discipline_help: 'simple data tracking for attendance',
    personal_learning:
      'I learned how to document community work carefully, listen to residents before proposing solutions, and record evidence in a way that other people could later verify.',
    academic_application:
      'The project used fieldwork and data-collection methods from my engineering coursework, including basic water-quality testing and structured household interviews to track outcomes over time.',
    competency_scores: {
      cognitive_systemic: 3,
      cognitive_critical: 3,
      cognitive_evaluate: 3,
      practical_design: 3,
      practical_evidence: 3,
      practical_engagement: 3,
      social_empathy: 3,
      social_diversity: 3,
      social_collaboration: 3,
      transformative_longterm: 3,
      transformative_benefits: 3,
      transformative_sustainability: 3,
    },
  },
  section10: {
    continuation_status: 'no' as const,
    continuation_details: 'word '.repeat(100).trim(),
    mechanisms: ['No continuation mechanism'],
    scaling_potential: 'Not scalable',
    policy_influence: 'No',
  },
  section11: {
    final_declaration: [true, true, true, true, true],
    signature_name: 'Jane Student',
  },
};


// Fully approved + live listing: satisfies assertStudentOpportunityReportableForWrite
// (faculty -> partner -> CIEL admin live) so tests reach the logic they actually exercise.
const LIVE_OPP_GATES = {
  faculty_verified: true,
  facultyApprovalStatus: 'approved',
  requiresPartnerApproval: false,
  admin_approved: true,
  workflowStage: 'live',
  status: 'active',
};
describe('StudentReportsService', () => {
  let service: StudentReportsService;

  const mockOpportunityRepository = {
    findOne: jest.fn(),
  };
  const mockParticipantRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
  };
  // Backing store for the guarded update() in verifyReport's atomic compare-and-swap — mirrors
  // the mutation onto the same object `findOne` returned, so assertions on `report.<field>` after
  // calling verifyReport still see the applied values, same as the old blind save() did.
  const verifyReportQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn(function (this: any, patch: Record<string, unknown>) {
      this.__patch = patch;
      return this;
    }),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn(function (this: any) {
      return Promise.resolve({ affected: this.__nextAffected ?? 1 });
    }),
    __patch: undefined as Record<string, unknown> | undefined,
    __nextAffected: undefined as number | undefined,
  };
  const mockStudentReportsRepository = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => verifyReportQb),
  };
  const mockAttendanceLogsRepository = {
    find: jest.fn().mockResolvedValue([]),
  };
  const mockUsersRepository = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const mockPaymentRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
  };
  const mockS3Service = {
    uploadFile: jest.fn(),
  };
  const mockEngagementService = {
    getProjectTeamForReportDossier: jest.fn().mockResolvedValue([]),
    decryptCnicInternal: jest.fn((v: string) => v),
  };
  const mockMailService = {
    sendAdminStudentReportSubmitted: jest.fn().mockResolvedValue(undefined),
    sendFacultyInvite: jest.fn().mockResolvedValue(undefined),
    sendFacultyStudentReportAwaitingReview: jest
      .fn()
      .mockResolvedValue(undefined),
    sendStudentImpactReportFacultyDecision: jest
      .fn()
      .mockResolvedValue(undefined),
    sendReportPackagePublished: jest.fn().mockResolvedValue(undefined),
    getAdminReviewEmails: jest.fn().mockReturnValue(['admin@cielpk.com']),
  };
  const mockConfigService = {
    get: jest.fn().mockReturnValue(''),
  };
  let reportPartnerGateGloballyEnabled = true;
  const evaluateGate = (
    report: unknown,
    hasMeaningful: (v: unknown) => boolean,
  ) =>
    evaluateReportRequiresPartnerApproval(
      report as Parameters<typeof evaluateReportRequiresPartnerApproval>[0],
      reportPartnerGateGloballyEnabled,
      hasMeaningful,
    );
  const mockReportPartnerApprovalSettings = {
    onModuleInit: jest.fn(),
    reportRequiresPartnerApproval: jest
      .fn()
      .mockImplementation(
        async (report: unknown, hasMeaningful: (v: unknown) => boolean) =>
          evaluateGate(report, hasMeaningful),
      ),
    reportRequiresPartnerApprovalSync: jest
      .fn()
      .mockImplementation(
        (report: unknown, hasMeaningful: (v: unknown) => boolean) =>
          evaluateGate(report, hasMeaningful),
      ),
    isEnabled: jest.fn().mockResolvedValue(true),
    isEnabledCached: jest
      .fn()
      .mockImplementation(() => reportPartnerGateGloballyEnabled),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    reportPartnerGateGloballyEnabled = true;

    mockParticipantRepository.findOne.mockReset();
    mockParticipantRepository.findOne.mockResolvedValue({
      studentId: 'student-1',
      projectId: 'opp-1',
      status: 'accepted',
      participationMode: 'individual',
    });
    mockParticipantRepository.find.mockReset();
    mockParticipantRepository.find.mockResolvedValue([]);

    mockOpportunityRepository.findOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Test Opportunity',
      isStudentCreated: false,
      ...LIVE_OPP_GATES,
      timeline: null,
    });
    mockStudentReportsRepository.findOne.mockReset();
    mockStudentReportsRepository.findOne.mockResolvedValue(null);
    mockStudentReportsRepository.find.mockReset();
    mockStudentReportsRepository.find.mockResolvedValue([]);
    mockStudentReportsRepository.create.mockImplementation(
      (payload: any) => payload,
    );
    mockStudentReportsRepository.save.mockImplementation(
      async (report: any) => {
        if (!report.id) report.id = 'report-1';
        if (!report.verificationPublicSlug)
          report.verificationPublicSlug = null;
        return report;
      },
    );
    mockUsersRepository.findOne.mockResolvedValue({
      id: 'student-1',
      name: 'Test Student',
    });
    mockUsersRepository.find.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentReportsService,
        {
          provide: getRepositoryToken(Opportunity),
          useValue: mockOpportunityRepository,
        },
        {
          provide: getRepositoryToken(Participation),
          useValue: mockParticipantRepository,
        },
        {
          provide: getRepositoryToken(StudentReport),
          useValue: mockStudentReportsRepository,
        },
        {
          provide: getRepositoryToken(AttendanceLog),
          useValue: mockAttendanceLogsRepository,
        },
        { provide: getRepositoryToken(User), useValue: mockUsersRepository },
        {
          provide: getRepositoryToken(Payment),
          useValue: mockPaymentRepository,
        },
        { provide: S3Service, useValue: mockS3Service },
        { provide: EngagementService, useValue: mockEngagementService },
        { provide: MailService, useValue: mockMailService },
        { provide: ConfigService, useValue: mockConfigService },
        {
          provide: ReportPartnerApprovalSettingsService,
          useValue: mockReportPartnerApprovalSettings,
        },
      ],
    }).compile();

    service = module.get<StudentReportsService>(StudentReportsService);
  });

  it('keeps status as draft when no submit intent is provided', async () => {
    const result = await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        section2: {
          problem_statement: 'test',
          baseline_evidence: 'Survey',
          discipline: 'CS',
        },
      },
      [],
      false,
    );

    expect(result.message).toBe('Report saved as draft.');
    expect(mockStudentReportsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'draft',
        opportunityId: 'opp-1',
      }),
    );
    expect(
      mockMailService.sendAdminStudentReportSubmitted,
    ).not.toHaveBeenCalled();
  });

  it('submits when forceSubmit is true (submit route behavior)', async () => {
    const result = await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        ...MIN_VALID_SUBMIT_SECTIONS,
      },
      [],
      true,
    );

    expect(result.message).toBe('Report submitted successfully.');
    expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'submitted',
        opportunityId: 'opp-1',
        project_id: 'opp-1',
        reportSubmittedAt: expect.any(Date),
        submission_date: expect.any(Date),
      }),
    );
    expect(result.data.report_submitted_at).toBeInstanceOf(Date);
    expect(
      mockMailService.sendAdminStudentReportSubmitted,
    ).toHaveBeenCalledTimes(1);
    expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        review_package: expect.objectContaining({
          documents: expect.objectContaining({
            flashcard: expect.objectContaining({ view: 'flash' }),
            detailed_report: expect.objectContaining({ view: 'print' }),
          }),
          sync_contract: expect.objectContaining({
            final_authority: 'CIEL PK Super Admin',
          }),
          packet_integrity: expect.objectContaining({ ok: true }),
        }),
      }),
    );
  });

  it('does not rewind a submitted report to draft when createReport is called without submit', async () => {
    const existing = {
      id: 'report-live',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      project_id: 'opp-1',
      status: 'payment_pending',
      reportSubmittedAt: new Date('2026-09-01T00:00:00.000Z'),
      section2: { problem_statement: 'locked copy' },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(existing);

    const result = await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        section2: { problem_statement: 'should not overwrite' },
      },
      [],
      false,
    );

    expect(result.message).toBe('Report saved as draft.');
    expect(existing.status).toBe('payment_pending');
    expect(existing.section2).toEqual({ problem_statement: 'locked copy' });
    expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('does not rewind a submitted report to draft on saveDraft', async () => {
    const existing = {
      id: 'report-live',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      project_id: 'opp-1',
      status: 'payment_pending',
      reportSubmittedAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      section2: { problem_statement: 'locked copy' },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(existing);

    const result = await service.saveDraft(
      'student-1',
      {
        opportunityId: 'opp-1',
        section2: { problem_statement: 'should not overwrite' },
      },
      [],
    );

    expect(result.message).toBe('Draft saved successfully.');
    expect(existing.status).toBe('payment_pending');
    expect(existing.section2).toEqual({ problem_statement: 'locked copy' });
    expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('blocks starting a report on an org listing until the student has an approved enrollment', async () => {
    mockParticipantRepository.findOne.mockResolvedValue(null);

    await expect(
      service.createReport(
        'student-1',
        { opportunityId: 'opp-1', section2: { problem_statement: 'x' } },
        [],
        false,
      ),
    ).rejects.toThrow('Apply to this opportunity');
  });

  it('lets the student-created opportunity owner start a report without a participation row', async () => {
    mockOpportunityRepository.findOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Test Opportunity',
      isStudentCreated: true,
      ...LIVE_OPP_GATES,
      faculty_verification_status: 'not_required',
      creatorId: 'student-1',
      admin_approved: true,
      workflowStage: 'live',
      status: 'active',
      timeline: null,
    });
    mockParticipantRepository.findOne.mockResolvedValue(null);

    const result = await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        section2: {
          problem_statement: 'test',
          baseline_evidence: 'Survey',
          discipline: 'CS',
        },
      },
      [],
      false,
    );

    expect(result.message).toBe('Report saved as draft.');
  });

  it('blocks submission when a team member has not individually met required hours, even though the pooled team total clears the bar', async () => {
    mockOpportunityRepository.findOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Test Opportunity',
      isStudentCreated: false,
      ...LIVE_OPP_GATES,
      timeline: { expected_hours: 16 },
    });
    mockParticipantRepository.find.mockResolvedValue([
      {
        id: 'p-lead',
        projectId: 'opp-1',
        studentId: 'student-1',
        status: 'accepted',
        fullName: 'Lead Student',
      },
      {
        id: 'p-member',
        projectId: 'opp-1',
        studentId: 'student-2',
        status: 'accepted',
        fullName: 'Quiet Teammate',
      },
    ]);
    mockAttendanceLogsRepository.find.mockResolvedValue([
      {
        participantId: 'p-lead',
        projectId: 'opp-1',
        sessionHours: 32,
        approvalStatus: 'approved',
        entryStatus: 'verified',
      },
    ]);

    await expect(
      service.createReport(
        'student-1',
        { opportunityId: 'opp-1', ...MIN_VALID_SUBMIT_SECTIONS },
        [],
        true,
      ),
    ).rejects.toThrow(/individually meet the required hours/);
    expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('allows submission once every team member has individually logged verified hours', async () => {
    mockOpportunityRepository.findOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Test Opportunity',
      isStudentCreated: false,
      ...LIVE_OPP_GATES,
      timeline: { expected_hours: 16 },
    });
    mockParticipantRepository.find.mockResolvedValue([
      {
        id: 'p-lead',
        projectId: 'opp-1',
        studentId: 'student-1',
        status: 'accepted',
        fullName: 'Lead Student',
      },
      {
        id: 'p-member',
        projectId: 'opp-1',
        studentId: 'student-2',
        status: 'accepted',
        fullName: 'Teammate',
      },
    ]);
    mockAttendanceLogsRepository.find.mockResolvedValue([
      {
        participantId: 'p-lead',
        projectId: 'opp-1',
        sessionHours: 16,
        approvalStatus: 'approved',
        entryStatus: 'verified',
      },
      {
        participantId: 'p-member',
        projectId: 'opp-1',
        sessionHours: 20,
        approvalStatus: null,
        entryStatus: 'verified',
      },
    ]);

    const result = await service.createReport(
      'student-1',
      { opportunityId: 'opp-1', ...MIN_VALID_SUBMIT_SECTIONS },
      [],
      true,
    );

    expect(result.message).toBe('Report submitted successfully.');
  });

  it('allows submission when required hours are logged but faculty has not approved attendance yet', async () => {
    mockOpportunityRepository.findOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Test Opportunity',
      isStudentCreated: false,
      ...LIVE_OPP_GATES,
      timeline: { expected_hours: 16 },
    });
    mockParticipantRepository.find.mockResolvedValue([
      {
        id: 'p-lead',
        projectId: 'opp-1',
        studentId: 'student-1',
        status: 'accepted',
        fullName: 'Lead Student',
      },
    ]);
    mockAttendanceLogsRepository.find.mockResolvedValue([
      {
        participantId: 'p-lead',
        projectId: 'opp-1',
        sessionHours: 20,
        approvalStatus: null,
        entryStatus: 'pending',
      },
    ]);

    const result = await service.createReport(
      'student-1',
      { opportunityId: 'opp-1', ...MIN_VALID_SUBMIT_SECTIONS },
      [],
      true,
    );

    expect(result.message).toBe('Report submitted successfully.');
  });

  it('does not count a rejected attendance log toward the submit hour bar', async () => {
    mockOpportunityRepository.findOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Test Opportunity',
      isStudentCreated: false,
      ...LIVE_OPP_GATES,
      timeline: { expected_hours: 16 },
    });
    mockParticipantRepository.find.mockResolvedValue([
      {
        id: 'p-lead',
        projectId: 'opp-1',
        studentId: 'student-1',
        status: 'accepted',
        fullName: 'Lead Student',
      },
    ]);
    mockAttendanceLogsRepository.find.mockResolvedValue([
      {
        participantId: 'p-lead',
        projectId: 'opp-1',
        sessionHours: 20,
        approvalStatus: 'rejected',
        entryStatus: 'pending',
      },
    ]);

    await expect(
      service.createReport(
        'student-1',
        { opportunityId: 'opp-1', ...MIN_VALID_SUBMIT_SECTIONS },
        [],
        true,
      ),
    ).rejects.toThrow(/Required engagement hours must be met/);
  });

  it('stores null primary_sdg_goal when section3 goal_number is an empty string', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-1',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      status: 'draft',
      section3: null,
    });

    await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        section2: {
          problem_statement: 'test',
          baseline_evidence: 'Survey',
          discipline: 'CS',
        },
        section3: {
          primary_sdg: { target_id: '', goal_number: '', indicator_id: '' },
          contribution_intent_statement: 'Contribution logic statement',
        },
      },
      [],
      false,
    );

    expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        primary_sdg_goal: null,
        primary_sdg_target: null,
        primary_sdg_indicator: null,
        section3: expect.objectContaining({
          primary_sdg: expect.objectContaining({
            goal_number: null,
          }),
        }),
      }),
    );
  });

  it('persists section3 target_id, indicator_id, and sub_indicator on primary_sdg', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-1',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      status: 'draft',
      section3: null,
    });

    await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        section2: {
          problem_statement: 'test',
          baseline_evidence: 'Survey',
          discipline: 'CS',
        },
        section3: {
          primary_sdg: {
            goal_number: 4,
            target_id: '4.a',
            indicator_id: '4.a.1',
            sub_indicator: 'Sessions / activities completed',
          },
          contribution_intent_statement: 'Contribution logic statement',
        },
      },
      [],
      false,
    );

    expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        primary_sdg_goal: 4,
        primary_sdg_target: '4.a',
        primary_sdg_indicator: '4.a.1',
        section3: expect.objectContaining({
          primary_sdg: expect.objectContaining({
            goal_number: 4,
            target_id: '4.a',
            indicator_id: '4.a.1',
            target_code: '4.a',
            indicator_code: '4.a.1',
            sub_indicator: 'Sessions / activities completed',
          }),
        }),
      }),
    );
  });

  it('submits successfully with array baseline_evidence and blank SDG fields (production-like payload)', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: '84c78cd8-1614-47a0-8db4-1e201266010b',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      status: 'draft',
    });

    const result = await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        ...MIN_VALID_SUBMIT_SECTIONS,
        section2: {
          ...MIN_VALID_SUBMIT_SECTIONS.section2,
          problem_statement:
            'Mental health awareness among students has been limited, leaving many undergraduates unsure where to seek help when they are struggling, especially during stressful exam periods throughout the academic year.',
          baseline_evidence: ['Survey Data', '__o_0', '__o_1', '__o_2'],
          baseline_evidence_other: 'Clinical psychologist consultation',
          discipline: 'Education',
        },
        section3: {
          primary_sdg: { target_id: '', goal_number: '', indicator_id: '' },
          contribution_intent_statement:
            'Contribution logic for SDG 3 centers on improving student mental wellbeing by organizing peer-support sessions, distributing awareness materials, and connecting students with a clinical psychologist for follow-up consultations across the semester so outcomes can be tracked consistently over time.',
        },
      },
      [],
      true,
    );

    expect(result.message).toBe('Report submitted successfully.');
    expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'submitted',
        primary_sdg_goal: null,
        baseline_evidence_source: 'Survey Data, __o_0, __o_1, __o_2',
      }),
    );
  });

  const SAMPLE_OPP_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const TEAM_ONLY_GUARD_MESSAGE =
    'Only the team lead can edit and submit the impact report for this team project. You may update your attendance in Section 1; your team lead files the report.';

  const TEAM_SCOPE = { teamId: 'team-scope-1', applicationId: 'app-scope-1' };

  function mockCanonicalLeadRows(
    leadStudentId: string,
    createdAt = '2020-01-01T00:00:00.000Z',
  ) {
    mockParticipantRepository.find.mockImplementation(
      (opts: { where?: Record<string, unknown> }) => {
        const w = opts?.where ?? {};
        if (
          w.projectId === SAMPLE_OPP_UUID &&
          w.participationMode === 'team' &&
          w.isTeamLead === true
        ) {
          return Promise.resolve([
            {
              id: 'lead-participation',
              studentId: leadStudentId,
              createdAt: new Date(createdAt),
              isTeamLead: true,
              participationMode: 'team',
              ...TEAM_SCOPE,
            },
          ]);
        }
        return Promise.resolve([]);
      },
    );
  }

  function mockTeamMemberAndLeadOnProject() {
    mockOpportunityRepository.findOne.mockResolvedValue({
      id: SAMPLE_OPP_UUID,
      title: 'Team Project',
      isStudentCreated: false,
      ...LIVE_OPP_GATES,
      timeline: null,
    });
    mockCanonicalLeadRows('team-lead-student');
    mockParticipantRepository.findOne.mockImplementation(
      (opts: { where?: Record<string, unknown> }) => {
        const w = opts?.where ?? {};
        if (
          w.studentId === 'student-member' &&
          w.projectId === SAMPLE_OPP_UUID
        ) {
          return Promise.resolve({
            participationMode: 'team',
            isTeamLead: false,
            studentId: w.studentId,
            projectId: w.projectId,
            status: 'accepted',
            ...TEAM_SCOPE,
          });
        }
        return Promise.resolve(null);
      },
    );
  }

  describe('redactUnapprovedAiScoreForStudent', () => {
    const redact = (row: Record<string, unknown>) =>
      (service as any).redactUnapprovedAiScoreForStudent(row);

    it('strips the certificate before faculty sign-off but keeps the CII score', () => {
      expect(
        redact({
          status: 'submitted',
          faculty_status: 'pending',
          cii_score: 88,
          total: 91,
          level: 'Transformative',
        }),
      ).toMatchObject({ cii_score: 88, total: 91, level: 'Transformative' });
    });

    it('keeps the CII score on a rejected report too', () => {
      expect(
        redact({
          status: 'rejected',
          faculty_status: 'approved',
          cii_score: 88,
          total: 91,
          level: 'Transformative',
        }),
      ).toMatchObject({ cii_score: 88, total: 91, level: 'Transformative' });
    });

    it('hides certificate when CIEL PK locked the CII but has not published yet, and keeps the score', () => {
      expect(
        redact({
          status: 'submitted',
          faculty_status: 'approved',
          admin_status: 'pending',
          cii_score: 88,
          total: 91,
          level: 'Transformative',
          actions: { certificate_url: '/cert', pdf_url: '/print' },
        }),
      ).toMatchObject({
        cii_score: 88,
        total: 91,
        level: 'Transformative',
        actions: { certificate_url: null, pdf_url: null },
      });
    });

    it('keeps the decided score once CIEL PK Admin has accepted the report', () => {
      expect(
        redact({
          status: 'submitted',
          faculty_status: 'approved',
          admin_status: 'approved',
          cii_score: 88,
          total: 91,
          level: 'Transformative',
        }),
      ).toMatchObject({ cii_score: 88, total: 91, level: 'Transformative' });
    });

    it('hides certificate/print until published but keeps the locked detailed-report link', () => {
      expect(
        redact({
          status: 'submitted',
          faculty_status: 'pending',
          cii_score: 88,
          actions: {
            certificate_url: '/cert',
            pdf_url: '/print',
            report_url: '/report',
            v17_url: '/report',
          },
        }),
      ).toMatchObject({
        actions: {
          certificate_url: null,
          pdf_url: null,
          report_url: '/report',
          v17_url: '/report',
        },
      });
    });
  });

  describe('redactCiiV45ListingForStudent (My Impact Wall list)', () => {
    const redactListing = (row: Record<string, unknown>) =>
      (StudentReportsService as any).redactCiiV45ListingForStudent(row);

    it('keeps the redacted CII score on the listing even before the score is locked', () => {
      const result = redactListing({
        id: 'r-1',
        ciiV45: { finalCII: 91.5, sectionScores: [] },
        ciiV45Lock: null,
      });
      expect(result.ciiV45.finalCII).toBe(91.5);
      expect(result.ciiV45Lock).toBeNull();
    });

    it('keeps a locked score visible before CIEL PK Admin has accepted the report', () => {
      const result = redactListing({
        id: 'r-2a',
        status: 'submitted',
        admin_status: 'pending',
        faculty_status: 'approved',
        ciiV45: { finalCII: 91.5, sectionScores: [] },
        ciiV45Lock: { locked: true, hash: 'abc' },
      });
      expect(result.ciiV45.finalCII).toBe(91.5);
      expect(result.ciiV45Lock.locked).toBe(true);
    });

    it('surfaces the locked score/badge/feedback once CIEL PK Admin has accepted the report', () => {
      const result = redactListing({
        id: 'r-2',
        status: 'verified',
        admin_status: 'approved',
        faculty_status: 'approved',
        ciiV45: {
          finalCII: 91.5,
          finalBadge: {
            code: 'L6',
            name: 'Distinguished Impact Contributor',
            level: 6,
            numericLevel: 6,
            gateCapped: false,
          },
          sectionScores: [
            { dimension: '1', name: 'Participation & Verified Effort', maximumPoints: 10, score: 9 },
          ],
          studentFeedback: 'Great work.',
        },
        ciiV45Lock: {
          locked: true,
          hash: 'abc',
          lockedAt: '2026-01-01T00:00:00.000Z',
          aiRecommendedScore: 90,
          adminApprovedScore: 91.5,
        },
      });
      expect(result.ciiV45.finalCII).toBe(91.5);
      expect(result.ciiV45.finalBadge).toEqual({
        code: 'L6',
        name: 'Distinguished Impact Contributor',
        level: 6,
        numericLevel: 6,
        gateCapped: false,
      });
      expect(result.ciiV45Lock.locked).toBe(true);
    });

    it('leaves every other listing field untouched', () => {
      const result = redactListing({
        id: 'r-3',
        project_title: 'Clean water drive',
        ciiV45: null,
        ciiV45Lock: null,
      });
      expect(result.project_title).toBe('Clean water drive');
    });
  });

  describe('withholdAnalysisForFacultyUntilApproved', () => {
    it('keeps display scores and strips criterion reasoning plus independent analyses until Admin accept', () => {
      const result = StudentReportsService.withholdAnalysisForFacultyUntilApproved({
        success: true,
        data: {
          id: 'r-fac',
          admin_status: 'pending',
          status: 'submitted',
          ciiV45: {
            diagnosticCII: 57.9,
            finalCII: 57.9,
            claimInventory: [{ text: 'private claim text' }],
            sectionScores: [
              {
                dimension: '7',
                score: 13,
                criterionScores: [{ reasoningSummary: 'private faculty-facing rationale' }],
              },
            ],
          },
          independentAiAnalyses: [{ id: 'run-1', score: 80 }],
        },
      });
      expect(result.data.ciiV45.diagnosticCII).toBe(57.9);
      expect(result.data.ciiV45.finalCII).toBe(57.9);
      expect(JSON.stringify(result.data)).not.toContain('private claim text');
      expect(JSON.stringify(result.data)).not.toContain('private faculty-facing rationale');
      expect(result.data.independentAiAnalyses).toBeNull();
    });
  });

  describe('team report submit authorization', () => {
    it('blocks final submit for team members when a team lead exists on the project', async () => {
      mockTeamMemberAndLeadOnProject();

      await expect(
        service.createReport(
          'student-member',
          {
            opportunityId: SAMPLE_OPP_UUID,
            section2: {
              problem_statement: 'test',
              baseline_evidence: 'Survey',
              discipline: 'CS',
            },
          },
          [],
          true,
        ),
      ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
    });

    it('blocks submit when submit intent comes from body (not only forceSubmit)', async () => {
      mockTeamMemberAndLeadOnProject();

      await expect(
        service.createReport(
          'student-member',
          {
            opportunityId: SAMPLE_OPP_UUID,
            submit: true,
            section2: {
              problem_statement: 'test',
              baseline_evidence: 'Survey',
              discipline: 'CS',
            },
          },
          [],
          false,
        ),
      ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
    });

    it('blocks draft save for team members when a team lead exists on the project', async () => {
      mockTeamMemberAndLeadOnProject();

      await expect(
        service.createReport(
          'student-member',
          {
            opportunityId: SAMPLE_OPP_UUID,
            section2: {
              problem_statement: 'test',
              baseline_evidence: 'Survey',
              discipline: 'CS',
            },
          },
          [],
          false,
        ),
      ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
    });

    it('allows team lead to submit for team participation', async () => {
      mockOpportunityRepository.findOne.mockResolvedValue({
        id: SAMPLE_OPP_UUID,
        title: 'Team Project',
        isStudentCreated: false,
        ...LIVE_OPP_GATES,
        timeline: null,
      });
      mockCanonicalLeadRows('team-lead-student');
      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (
            w.studentId === 'team-lead-student' &&
            w.projectId === SAMPLE_OPP_UUID
          ) {
            return Promise.resolve({
              participationMode: 'team',
              isTeamLead: true,
              studentId: w.studentId,
              projectId: w.projectId,
              status: 'accepted',
              ...TEAM_SCOPE,
            });
          }
          return Promise.resolve(null);
        },
      );

      const result = await service.createReport(
        'team-lead-student',
        {
          opportunityId: SAMPLE_OPP_UUID,
          ...MIN_VALID_SUBMIT_SECTIONS,
        },
        [],
        true,
      );

      expect(result.message).toBe('Report submitted successfully.');
    });

    it('blocks submit for a duplicate team lead when an earlier canonical lead exists', async () => {
      mockOpportunityRepository.findOne.mockResolvedValue({
        id: SAMPLE_OPP_UUID,
        title: 'Team Project',
        isStudentCreated: false,
        ...LIVE_OPP_GATES,
        timeline: null,
      });
      mockCanonicalLeadRows('hamza-lead', '2019-06-01T00:00:00.000Z');
      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (
            w.studentId === 'moeez-duplicate-lead' &&
            w.projectId === SAMPLE_OPP_UUID
          ) {
            return Promise.resolve({
              participationMode: 'team',
              isTeamLead: true,
              studentId: w.studentId,
              projectId: w.projectId,
              status: 'accepted',
              ...TEAM_SCOPE,
            });
          }
          return Promise.resolve(null);
        },
      );

      await expect(
        service.createReport(
          'moeez-duplicate-lead',
          {
            opportunityId: SAMPLE_OPP_UUID,
            section2: {
              problem_statement: 'test',
              baseline_evidence: 'Survey',
              discipline: 'CS',
            },
          },
          [],
          true,
        ),
      ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
    });

    it('allows team member submit when no lead row exists (legacy data)', async () => {
      mockOpportunityRepository.findOne.mockResolvedValue({
        id: SAMPLE_OPP_UUID,
        title: 'Team Project',
        isStudentCreated: false,
        ...LIVE_OPP_GATES,
        timeline: null,
      });
      mockParticipantRepository.find.mockResolvedValue([]);
      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (
            w.studentId === 'legacy-member' &&
            w.projectId === SAMPLE_OPP_UUID
          ) {
            return Promise.resolve({
              participationMode: 'team',
              isTeamLead: false,
              studentId: w.studentId,
              projectId: w.projectId,
              status: 'accepted',
            });
          }
          return Promise.resolve(null);
        },
      );

      const result = await service.createReport(
        'legacy-member',
        {
          opportunityId: SAMPLE_OPP_UUID,
          ...MIN_VALID_SUBMIT_SECTIONS,
        },
        [],
        true,
      );

      expect(result.message).toBe('Report submitted successfully.');
    });

    it('allows individual participation submit even when isTeamLead is false', async () => {
      mockOpportunityRepository.findOne.mockResolvedValue({
        id: SAMPLE_OPP_UUID,
        title: 'Solo Project',
        isStudentCreated: false,
        ...LIVE_OPP_GATES,
        timeline: null,
      });
      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (
            w.studentId === 'solo-student' &&
            w.projectId === SAMPLE_OPP_UUID
          ) {
            return Promise.resolve({
              participationMode: 'individual',
              isTeamLead: false,
              studentId: w.studentId,
              projectId: w.projectId,
              status: 'accepted',
            });
          }
          return Promise.resolve(null);
        },
      );

      const result = await service.createReport(
        'solo-student',
        {
          opportunityId: SAMPLE_OPP_UUID,
          ...MIN_VALID_SUBMIT_SECTIONS,
        },
        [],
        true,
      );

      expect(result.message).toBe('Report submitted successfully.');
    });

    it('allows submit when the student-created opportunity owner has no participation row', async () => {
      mockOpportunityRepository.findOne.mockResolvedValue({
        id: SAMPLE_OPP_UUID,
        title: 'Project',
        isStudentCreated: true,
        ...LIVE_OPP_GATES,
        faculty_verification_status: 'not_required',
        creatorId: 'no-participation-user',
        admin_approved: true,
        workflowStage: 'live',
        status: 'active',
        timeline: null,
      });
      mockParticipantRepository.findOne.mockResolvedValue(null);

      const result = await service.createReport(
        'no-participation-user',
        {
          opportunityId: SAMPLE_OPP_UUID,
          ...MIN_VALID_SUBMIT_SECTIONS,
        },
        [],
        true,
      );

      expect(result.message).toBe('Report submitted successfully.');
      expect(mockParticipantRepository.findOne).toHaveBeenCalled();
    });

    it('blocks submit for a teammate whose mode is still individual but who shares the teamId', async () => {
      mockOpportunityRepository.findOne.mockResolvedValue({
        id: SAMPLE_OPP_UUID,
        title: 'Team Project',
        isStudentCreated: false,
        ...LIVE_OPP_GATES,
        timeline: null,
      });
      mockCanonicalLeadRows('team-lead-student');
      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (
            w.studentId === 'student-member' &&
            w.projectId === SAMPLE_OPP_UUID
          ) {
            return Promise.resolve({
              id: 'p-member',
              participationMode: 'individual',
              isTeamLead: false,
              studentId: w.studentId,
              projectId: w.projectId,
              status: 'accepted',
              ...TEAM_SCOPE,
            });
          }
          return Promise.resolve(null);
        },
      );

      await expect(
        service.createReport(
          'student-member',
          {
            opportunityId: SAMPLE_OPP_UUID,
            ...MIN_VALID_SUBMIT_SECTIONS,
          },
          [],
          true,
        ),
      ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
    });
  });

  describe('team shared report read', () => {
    const WRITTEN = 'Every teammate must see this problem statement.';

    function fivePersonRoster() {
      const lead = {
        id: 'p-lead',
        studentId: 'team-lead-student',
        projectId: SAMPLE_OPP_UUID,
        participationMode: 'team',
        isTeamLead: true,
        createdAt: new Date('2020-01-01'),
        ...TEAM_SCOPE,
      };
      const members = [2, 3, 4, 5].map((n) => ({
        id: `p-m${n}`,
        studentId: `member-${n}`,
        projectId: SAMPLE_OPP_UUID,
        participationMode: n === 5 ? 'individual' : 'team',
        isTeamLead: false,
        createdAt: new Date(`2020-01-0${n}`),
        ...TEAM_SCOPE,
      }));
      return [lead, ...members];
    }

    function leadReportRow() {
      return {
        id: 'lead-report-1',
        studentId: 'team-lead-student',
        opportunityId: SAMPLE_OPP_UUID,
        project_id: SAMPLE_OPP_UUID,
        status: 'draft',
        admin_status: 'pending',
        faculty_status: 'pending',
        partner_status: 'pending',
        section1: {
          participation_type: 'team',
          team_lead: { fullName: 'Lead', email: 'lead@test.com', cnic: '' },
          team_members: [],
        },
        section2: { problem_statement: WRITTEN },
        section3: { contribution_intent_statement: 'Shared intent text.' },
        section4: {},
        section5: {},
        section6: {},
        section7: {},
        section8: {},
        section9: { personal_learning: 'Shared reflection.' },
        section10: {},
        section11: {},
        student: {
          id: 'team-lead-student',
          name: 'Lead',
          email: 'lead@test.com',
        },
        opportunity: { id: SAMPLE_OPP_UUID, title: 'Five person team project' },
        createdAt: new Date('2020-01-01'),
        updatedAt: new Date('2020-06-01'),
      };
    }

    it('returns the lead’s written sections to every teammate on a 5-person team', async () => {
      const roster = fivePersonRoster();
      const leadReport = leadReportRow();
      const memberOrphan = {
        ...leadReport,
        id: 'orphan-member-2',
        studentId: 'member-2',
        section2: { problem_statement: '' },
        section3: {},
        section9: {},
        createdAt: new Date('2020-02-01'),
      };

      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          const row = roster.find(
            (p) => p.studentId === w.studentId && p.projectId === w.projectId,
          );
          return Promise.resolve(row ?? null);
        },
      );
      mockParticipantRepository.find.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          return Promise.resolve(
            roster.filter((row) => {
              if (w.projectId && row.projectId !== w.projectId) return false;
              if (w.teamId && row.teamId !== w.teamId) return false;
              if (
                w.applicationId &&
                row.applicationId !== w.applicationId
              ) {
                return false;
              }
              if (
                w.participationMode &&
                row.participationMode !== w.participationMode
              ) {
                return false;
              }
              if (
                w.isTeamLead !== undefined &&
                row.isTeamLead !== w.isTeamLead
              ) {
                return false;
              }
              return true;
            }),
          );
        },
      );
      mockStudentReportsRepository.findOne.mockResolvedValue(null);
      mockStudentReportsRepository.find.mockResolvedValue([
        leadReport,
        memberOrphan,
      ]);
      mockUsersRepository.findOne.mockResolvedValue({
        id: 'team-lead-student',
        name: 'Lead',
        email: 'lead@test.com',
      });

      for (const viewer of ['member-2', 'member-3', 'member-4', 'member-5']) {
        const result = await service.findOneByOpportunityOrId(
          SAMPLE_OPP_UUID,
          viewer,
        );
        const data = result.data as {
          section2?: { problem_statement?: string };
          section9?: { personal_learning?: string };
          report_access?: {
            is_team_lead?: boolean;
            can_submit_report?: boolean;
            can_edit_report_body?: boolean;
            team_member_count?: number;
          };
        };
        expect(data.section2?.problem_statement).toBe(WRITTEN);
        expect(data.section9?.personal_learning).toBe('Shared reflection.');
        expect(data.report_access?.is_team_lead).toBe(false);
        expect(data.report_access?.can_submit_report).toBe(false);
        expect(data.report_access?.can_edit_report_body).toBe(false);
      }
    });

    it('still returns the lead report when the teammate also has a leftover individual seat', async () => {
      const roster = fivePersonRoster();
      const leftover = {
        id: 'p-solo-2',
        studentId: 'member-2',
        projectId: SAMPLE_OPP_UUID,
        participationMode: 'individual',
        isTeamLead: false,
        createdAt: new Date('2019-01-01'),
        teamId: null,
        applicationId: null,
      };
      const leadReport = leadReportRow();
      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (w.studentId === 'member-2') return Promise.resolve(leftover);
          const row = roster.find(
            (p) => p.studentId === w.studentId && p.projectId === w.projectId,
          );
          return Promise.resolve(row ?? null);
        },
      );
      mockParticipantRepository.find.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (w.studentId === 'member-2' && w.projectId === SAMPLE_OPP_UUID) {
            return Promise.resolve([
              leftover,
              roster.find((p) => p.studentId === 'member-2'),
            ]);
          }
          return Promise.resolve(
            roster.filter((row) => {
              if (w.projectId && row.projectId !== w.projectId) return false;
              if (w.teamId && row.teamId !== w.teamId) return false;
              if (w.applicationId && row.applicationId !== w.applicationId) {
                return false;
              }
              if (
                w.participationMode &&
                row.participationMode !== w.participationMode
              ) {
                return false;
              }
              if (
                w.isTeamLead !== undefined &&
                row.isTeamLead !== w.isTeamLead
              ) {
                return false;
              }
              return true;
            }),
          );
        },
      );
      mockStudentReportsRepository.findOne.mockResolvedValue(null);
      mockStudentReportsRepository.find.mockResolvedValue([leadReport]);
      mockUsersRepository.findOne.mockResolvedValue({
        id: 'team-lead-student',
        name: 'Lead',
        email: 'lead@test.com',
      });

      const result = await service.findOneByOpportunityOrId(
        SAMPLE_OPP_UUID,
        'member-2',
      );
      const data = result.data as {
        section2?: { problem_statement?: string };
        report_access?: { can_submit_report?: boolean };
      };
      expect(data.section2?.problem_statement).toBe(WRITTEN);
      expect(data.report_access?.can_submit_report).toBe(false);
    });

    it('returns the lead report when the teammate only has a mis-tagged individual seat (no teamId)', async () => {
      const lead = {
        id: 'p-lead',
        studentId: 'team-lead-student',
        projectId: SAMPLE_OPP_UUID,
        participationMode: 'team',
        isTeamLead: true,
        createdAt: new Date('2020-01-01'),
        ...TEAM_SCOPE,
      };
      const mistaggedMember = {
        id: 'p-m2-solo',
        studentId: 'member-2',
        projectId: SAMPLE_OPP_UUID,
        participationMode: 'individual',
        isTeamLead: false,
        createdAt: new Date('2020-01-02'),
        teamId: null,
        applicationId: TEAM_SCOPE.applicationId,
      };
      const leadReport = leadReportRow();

      mockParticipantRepository.findOne.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (w.studentId === 'member-2') return Promise.resolve(mistaggedMember);
          if (w.studentId === 'team-lead-student') return Promise.resolve(lead);
          return Promise.resolve(null);
        },
      );
      mockParticipantRepository.find.mockImplementation(
        (opts: { where?: Record<string, unknown> }) => {
          const w = opts?.where ?? {};
          if (w.studentId === 'member-2' && w.projectId === SAMPLE_OPP_UUID) {
            return Promise.resolve([mistaggedMember]);
          }
          return Promise.resolve(
            [lead, mistaggedMember].filter((row) => {
              if (w.projectId && row.projectId !== w.projectId) return false;
              if (w.teamId && (row as { teamId?: string | null }).teamId !== w.teamId)
                return false;
              if (
                w.applicationId &&
                (row as { applicationId?: string | null }).applicationId !==
                  w.applicationId
              ) {
                return false;
              }
              return true;
            }),
          );
        },
      );
      mockStudentReportsRepository.findOne.mockResolvedValue(null);
      mockStudentReportsRepository.find.mockResolvedValue([leadReport]);
      mockUsersRepository.findOne.mockResolvedValue({
        id: 'team-lead-student',
        name: 'Lead',
        email: 'lead@test.com',
      });

      const result = await service.findOneByOpportunityOrId(
        SAMPLE_OPP_UUID,
        'member-2',
      );
      const data = result.data as {
        section2?: { problem_statement?: string };
        report_access?: {
          is_team_lead?: boolean;
          can_edit_report_body?: boolean;
        };
      };
      expect(data.section2?.problem_statement).toBe(WRITTEN);
      expect(data.report_access?.is_team_lead).toBe(false);
      expect(data.report_access?.can_edit_report_body).toBe(false);
    });
  });

  it('holds private-candidate submit on the reporting-fee gateway', async () => {
    mockOpportunityRepository.findOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Private listing',
      isStudentCreated: true,
      ...LIVE_OPP_GATES,
      admin_approved: true,
      workflowStage: 'live',
      status: 'active',
      faculty_verification_status: 'not_required',
      executing_context: { student_pathway: 'private' },
      timeline: null,
    });

    const result = await service.createReport(
      'student-1',
      {
        opportunityId: 'opp-1',
        ...MIN_VALID_SUBMIT_SECTIONS,
      },
      [],
      true,
    );

    expect(result.message).toBe('Report submitted successfully.');
    expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'payment_pending',
        opportunityId: 'opp-1',
      }),
    );
  });

  it('does not promote a draft report to paid because a leftover payment row is approved', async () => {
    const opp = '582da802-e41e-488d-bd3d-d6dee59982b7';
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-draft-1',
      studentId: 'student-1',
      opportunityId: opp,
      project_id: opp,
      status: 'draft',
      admin_status: 'pending',
      faculty_status: 'pending',
      partner_status: 'pending',
      section1: { team_lead: { fullName: 'Jane', cnic: '' } },
      section2: {},
      section3: {},
      section4: {},
      section5: {},
      section6: {},
      section7: {},
      section8: {},
      section9: {},
      section10: {},
      section11: {},
      student: { id: 'student-1', name: 'Jane', email: 'jane@test.com' },
      opportunity: { id: opp, title: 'SOS Class Transformation' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPaymentRepository.findOne.mockResolvedValue({
      status: 'approved',
      studentId: 'student-1',
      projectId: opp,
    });

    const result = await service.findOneByOpportunityOrId(opp, 'student-1');
    const data = result.data as { status?: string; is_editable?: boolean; payment_verified?: boolean };

    expect(data.status).toBe('draft');
    expect(data.is_editable).toBe(true);
    expect(data.payment_verified).toBe(false);
  });

  it('reads a closed report as "closed", not "verified", even with an old approved payment row', async () => {
    const opp = '7c2e7c79-6c2a-4e59-9b23-2f6d2d7b9b11';
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-closed-1',
      studentId: 'student-1',
      opportunityId: opp,
      project_id: opp,
      status: 'closed',
      admin_status: 'approved',
      faculty_status: 'approved',
      partner_status: 'approved',
      closedAt: new Date('2026-10-01T00:00:00Z'),
      closedByAdminId: 'admin-1',
      closeReason: 'Evidence disappeared after approval.',
      section1: { team_lead: { fullName: 'Jane', cnic: '' } },
      section2: {},
      section3: {},
      section4: {},
      section5: {},
      section6: {},
      section7: {},
      section8: {},
      section9: {},
      section10: {},
      section11: {},
      student: { id: 'student-1', name: 'Jane', email: 'jane@test.com' },
      opportunity: { id: opp, title: 'SOS Class Transformation' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPaymentRepository.findOne.mockResolvedValue({
      status: 'approved',
      studentId: 'student-1',
      projectId: opp,
    });

    const result = await service.findOneByOpportunityOrId(opp, 'student-1');
    const data = result.data as {
      status?: string;
      payment_verified?: boolean;
      closed_at?: Date | null;
      close_reason?: string | null;
    };

    expect(data.status).toBe('closed');
    expect(data.payment_verified).toBe(false);
    expect(data.closed_at).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(data.close_reason).toBe('Evidence disappeared after approval.');
  });

  it('never sends null team_lead or a non-array team_members on the student report payload', async () => {
    const opp = 'cfa251f1-2e5b-4836-b0d9-6508254386d7';
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-null-s1',
      studentId: 'student-1',
      opportunityId: opp,
      project_id: opp,
      status: 'draft',
      admin_status: 'pending',
      faculty_status: 'pending',
      partner_status: 'pending',
      section1: {
        team_lead: null,
        team_members: { 0: { name: 'Ghost' } },
        metrics: null,
        attendance_logs: null,
      },
      section2: {},
      section3: {},
      section4: {},
      section5: {},
      section6: {},
      section7: {},
      section8: {},
      section9: {},
      section10: {},
      section11: {},
      student: { id: 'student-1', name: 'Jane', email: 'jane@test.com' },
      opportunity: { id: opp, title: 'Teach to Transform' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.findOneByOpportunityOrId(opp, 'student-1');
    const section1 = (result.data as { section1: Record<string, unknown> }).section1;

    expect(section1.team_lead).toEqual(expect.objectContaining({ name: '', email: '' }));
    expect(Array.isArray(section1.team_members)).toBe(true);
    expect(section1.team_members).toEqual([]);
    expect(section1.metrics).toEqual(
      expect.objectContaining({ total_verified_hours: 0 }),
    );
    expect(Array.isArray(section1.attendance_logs)).toBe(true);
  });

  it('blocks partner or admin approve until reporting fee is cleared', async () => {
    const report = {
      id: 'report-1',
      status: 'payment_pending',
      partner_status: 'pending',
      admin_status: 'pending',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      project_id: 'opp-1',
      opportunity: {
        faculty_verification_status: 'not_required',
        executing_context: { student_pathway: 'private' },
      },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    mockPaymentRepository.findOne.mockResolvedValue(null);

    await expect(
      service.verifyReport('report-1', 'approve', 'admin'),
    ).rejects.toThrow('Reporting fee must be submitted and approved');
  });

  it('marks no-partner reports verified when admin approves', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'approved',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport('report-1', 'approve', 'admin');

    expect(report.status).toBe('verified');
    expect(report.admin_status).toBe('approved');
    expect(result.data.status).toBe('verified');
    expect(verifyReportQb.execute).toHaveBeenCalled();
  });

  it('blocks admin approve on a faculty-gated report until CII is locked (or legacy faculty approved)', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(service.verifyReport('report-1', 'approve', 'admin')).rejects.toThrow(
      'Run and confirm the CII analysis',
    );
  });

  it('lets CIEL PK publish a regular report after CII is locked, without prior Faculty action', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      ciiV45Lock: { locked: true },
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport('report-1', 'approve', 'admin');

    expect(report.admin_status).toBe('approved');
    expect(report.faculty_status).toBe('approved');
    expect(report.status).toBe('verified');
    expect(result.data.status).toBe('verified');
  });

  it('sends the student Impact Package after Super Admin publish; faculty/student/university get analysis, partner does not', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      ciiV45: { finalCII: 82 },
      ciiV45Lock: { locked: true },
      student: {
        name: 'Amina',
        email: 'amina@student.test',
        university: 'LUMS',
      },
      faculty: { email: 'faculty@uni.test' },
      review_package: {
        admin_review_href: 'https://app.cielpk.com/admin/pkg',
        ai_analyser_href: 'https://app.cielpk.com/admin/ai',
        documents: {
          flashcard: { href: 'https://app.cielpk.com/flash' },
          detailed_report: { href: 'https://app.cielpk.com/print' },
          evidence: { count: 2 },
        },
      },
      opportunity: {
        title: 'Clean water',
        requiresPartnerApproval: false,
        partner_organization: { official_email: 'ngo@partner.test' },
      },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    mockUsersRepository.find.mockImplementation(async (opts: { where?: { role?: string } }) => {
      if (opts?.where?.role === 'university') {
        return [
          {
            email: 'uni@campus.test',
            university: 'LUMS',
            institution: 'LUMS',
          },
        ];
      }
      if (opts?.where?.role === 'admin') {
        return [{ email: 'super@cielpk.com' }];
      }
      return [];
    });

    await service.verifyReport('report-1', 'approve', 'admin');
    await new Promise((resolve) => setTimeout(resolve, 40));

    const audiences = mockMailService.sendReportPackagePublished.mock.calls.map(
      (call) => call[0].audience,
    );
    expect(audiences).toEqual(
      expect.arrayContaining([
        'student',
        'faculty',
        'partner',
        'university',
        'admin',
      ]),
    );
    expect(mockMailService.sendReportPackagePublished).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'amina@student.test',
        audience: 'student',
        reviewHref: expect.stringContaining('view=flash'),
        flashHref: expect.stringContaining('view=flash'),
        detailedHref: expect.stringContaining('view=print'),
        includeAnalysis: true,
        evidenceCount: expect.any(Number),
      }),
    );
    expect(mockMailService.sendReportPackagePublished).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'faculty@uni.test',
        audience: 'faculty',
        reviewHref: expect.stringContaining('/dashboard/faculty/reports/report-1?view=dossier'),
        flashHref: expect.stringContaining('doc=flashcard'),
        detailedHref: expect.stringContaining('doc=report'),
        includeAnalysis: true,
      }),
    );
    expect(mockMailService.sendReportPackagePublished).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'uni@campus.test',
        audience: 'university',
        reviewHref: expect.stringContaining('/dashboard/partner/verify/report-1?package=1'),
        includeAnalysis: true,
      }),
    );
    expect(mockMailService.sendReportPackagePublished).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ngo@partner.test',
        audience: 'partner',
        reviewHref: expect.stringContaining('/dashboard/partner/verify/report-1?package=1'),
        includeAnalysis: false,
      }),
    );
  });

  it('lets CIEL PK publish a private-candidate report after CII is locked, without Faculty', async () => {
    const report = {
      id: 'report-pc',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      ciiV45Lock: { locked: true },
      opportunity: {
        requiresPartnerApproval: false,
        faculty_verification_status: 'not_required',
      },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport('report-pc', 'approve', 'admin');

    expect(report.admin_status).toBe('approved');
    expect(report.faculty_status).toBe('not_applicable');
    expect(report.status).toBe('verified');
    expect(result.data.status).toBe('verified');
  });

  it('refuses to publish a private-candidate report before CII is locked', async () => {
    const report = {
      id: 'report-pc',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { faculty_verification_status: 'not_required' },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(service.verifyReport('report-pc', 'approve', 'admin')).rejects.toThrow(
      'Run and confirm the CII analysis',
    );
  });

  it('blocks admin approve on a faculty-gated report until CII is locked (or legacy faculty approved)', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(service.verifyReport('report-1', 'approve', 'admin')).rejects.toThrow(
      'Run and confirm the CII analysis',
    );
  });

  it('lets CIEL PK publish a private-candidate report after CII is locked, without Faculty', async () => {
    const report = {
      id: 'report-pc',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      ciiV45Lock: { locked: true },
      opportunity: {
        requiresPartnerApproval: false,
        faculty_verification_status: 'not_required',
      },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport('report-pc', 'approve', 'admin');

    expect(report.admin_status).toBe('approved');
    expect(report.faculty_status).toBe('not_applicable');
    expect(report.status).toBe('verified');
    expect(result.data.status).toBe('verified');
  });

  it('refuses to publish a private-candidate report before CII is locked', async () => {
    const report = {
      id: 'report-pc',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { faculty_verification_status: 'not_required' },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(service.verifyReport('report-pc', 'approve', 'admin')).rejects.toThrow(
      'Run and confirm the CII analysis',
    );
  });

  it('blocks admin approve on a faculty-gated report until CII is locked (or legacy faculty approved)', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(service.verifyReport('report-1', 'approve', 'admin')).rejects.toThrow(
      'Run and confirm the CII analysis',
    );
  });

  it('lets CIEL PK publish a private-candidate report after CII is locked, without Faculty', async () => {
    const report = {
      id: 'report-pc',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      ciiV45Lock: { locked: true },
      opportunity: {
        requiresPartnerApproval: false,
        faculty_verification_status: 'not_required',
      },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport('report-pc', 'approve', 'admin');

    expect(report.admin_status).toBe('approved');
    expect(report.faculty_status).toBe('not_applicable');
    expect(report.status).toBe('verified');
    expect(result.data.status).toBe('verified');
  });

  it('refuses to publish a private-candidate report before CII is locked', async () => {
    const report = {
      id: 'report-pc',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { faculty_verification_status: 'not_required' },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(service.verifyReport('report-pc', 'approve', 'admin')).rejects.toThrow(
      'Run and confirm the CII analysis',
    );
  });

  it('refuses the decision when a concurrent reviewer already changed admin_status/partner_status (atomic compare-and-swap)', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'approved',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    verifyReportQb.__nextAffected = 0; // simulates another reviewer's write winning the race

    try {
      await expect(
        service.verifyReport('report-1', 'approve', 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      verifyReportQb.__nextAffected = undefined;
    }
  });

  it('marks partner-required reports verified on admin approve when platform partner gate is disabled', async () => {
    reportPartnerGateGloballyEnabled = false;
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'approved',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { requiresPartnerApproval: true },
      section7: { has_partners: 'yes' },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport('report-1', 'approve', 'admin');

    expect(report.status).toBe('verified');
    expect(report.partner_status).toBe('not_applicable');
    expect(result.data.status).toBe('verified');
  });

  it('marks partner-required reports verified on admin approve even when the opportunity asked for partner sign-off', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'approved',
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { requiresPartnerApproval: true },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport('report-1', 'approve', 'admin');

    expect(report.status).toBe('verified');
    expect(report.admin_status).toBe('approved');
    expect(report.partner_status).toBe('not_applicable');
    expect(result.data.status).toBe('verified');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mockMailService.sendReportPackagePublished).toHaveBeenCalled();
  });

  it('refuses partner report approve — CIEL PK Admin is the only report approver', async () => {
    const report = {
      id: 'report-1',
      status: 'paid',
      partner_status: 'pending',
      admin_status: 'approved',
      faculty_status: 'approved',
      partnerApprovedAt: null,
      adminApprovedAt: new Date('2026-05-01T00:00:00.000Z'),
      opportunity: { organizationId: 'org-1', requiresPartnerApproval: true },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(
      service.verifyReport(
        'report-1',
        'approve',
        'partner',
        undefined,
        'org-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(report.status).toBe('paid');
    expect(report.partner_status).toBe('pending');
    expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('refuses partner reject and university unlock — report decisions are admin-only', async () => {
    const report = {
      id: 'report-1',
      status: 'submitted',
      partner_status: 'pending',
      admin_status: 'pending',
      faculty_status: 'pending',
      opportunity: { organizationId: 'org-1', requiresPartnerApproval: true },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await expect(
      service.verifyReport(
        'report-1',
        'reject',
        'partner',
        'Not enough evidence',
        'org-1',
      ),
    ).rejects.toThrow('CIEL PK Admin only');

    await expect(
      service.verifyReport('report-1', 'reject', 'university', 'no', 'org-1'),
    ).rejects.toThrow('CIEL PK Admin only');

    await expect(
      service.verifyReport('report-1', 'unlock', 'university', undefined, 'org-1'),
    ).rejects.toThrow('CIEL PK Admin only');

    expect(report.status).toBe('submitted');
    expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('sets revision status when admin rejects so students can edit', async () => {
    const report = {
      id: 'report-1',
      status: 'submitted',
      partner_status: 'pending',
      admin_status: 'pending',
      admin_feedback: null as string | null,
      partnerApprovedAt: null,
      adminApprovedAt: new Date('2026-05-01T00:00:00.000Z'),
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    await service.verifyReport(
      'report-1',
      'reject',
      'admin',
      'Please fix attendance hours.',
    );

    expect(report.status).toBe('revision');
    expect(report.admin_status).toBe('rejected');
    expect(report.admin_feedback).toBe('Please fix attendance hours.');
    expect(report.adminApprovedAt).toBeNull();
  });

  it('admin close retracts a published report without sending it back as revision', async () => {
    const report = {
      id: 'report-1',
      status: 'verified',
      partner_status: 'not_applicable',
      admin_status: 'approved',
      faculty_status: 'approved',
      closedAt: null as Date | null,
      closedByAdminId: null as string | null,
      closeReason: null as string | null,
      opportunity: { requiresPartnerApproval: false },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.verifyReport(
      'report-1',
      'close',
      'admin',
      'Evidence disappeared after approval.',
      undefined,
      undefined,
      { id: 'admin-1', name: 'Admin' },
    );

    expect(report.status).toBe('closed');
    expect(report.closeReason).toBe('Evidence disappeared after approval.');
    expect(result.data.status).toBe('closed');
    expect(report.admin_status).toBe('approved');
  });

  it('refuses to close a report that is still in revision', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-1',
      status: 'revision',
      admin_status: 'rejected',
      partner_status: 'pending',
      opportunity: {},
    });

    await expect(
      service.verifyReport('report-1', 'close', 'admin', 'closing a revision'),
    ).rejects.toThrow(/already-approved\/published report can be closed/);
  });

  it('refuses to edit a verified report that was not legitimately rejected/revision', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-1',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      status: 'verified',
      admin_status: 'approved',
      partner_status: 'approved',
      faculty_status: 'approved',
    });

    await expect(
      service.createReport(
        'student-1',
        {
          opportunityId: 'opp-1',
          section2: { problem_statement: 'sneaky post-verification edit' },
        },
        [],
        false,
      ),
    ).rejects.toThrow('already been verified');
    expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('a late faculty revision request reopens an already-verified report for editing, and clears faculty_status on resubmit', async () => {
    const report: Record<string, unknown> = {
      id: 'report-1',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      status: 'verified',
      admin_status: 'approved',
      partner_status: 'approved',
      faculty_status: 'revision_requested',
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);

    const result = await service.createReport(
      'student-1',
      { opportunityId: 'opp-1', ...MIN_VALID_SUBMIT_SECTIONS },
      [],
      true,
    );

    expect(result.message).toBe('Report submitted successfully.');
    expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ faculty_status: 'pending' }),
    );
  });

  it('returns admin feedback and editable flag from checkReportStatus', async () => {
    const OPP = '582da802-e41e-488d-bd3d-d6dee59982b7';
    const report = {
      id: 'report-1',
      studentId: 'student-1',
      opportunityId: OPP,
      project_id: OPP,
      status: 'submitted',
      admin_status: 'rejected',
      partner_status: 'pending',
      admin_feedback: 'Revise Section 4 outputs.',
      section11: null,
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { title: 'Test' },
    };
    mockParticipantRepository.findOne.mockResolvedValue(null);
    mockStudentReportsRepository.findOne.mockImplementation(async () => report);

    const result = await service.checkReportStatus('student-1', OPP);
    const data = result.data as {
      feedback?: string;
      is_editable?: boolean;
      status?: string;
      private_candidate?: boolean;
      review_route?: string;
    };

    expect(data.feedback).toBe('Revise Section 4 outputs.');
    expect(data.is_editable).toBe(true);
    expect(data.status).toBe('revision');
    expect(data.private_candidate).toBe(false);
    expect(data.review_route).toBe('faculty');
  });

  it('prefers faculty_remarks over leftover admin_feedback when Faculty asked for revision', async () => {
    const OPP = '582da802-e41e-488d-bd3d-d6dee59982b7';
    const report = {
      id: 'report-1',
      studentId: 'student-1',
      opportunityId: OPP,
      project_id: OPP,
      status: 'revision',
      faculty_status: 'revision_requested',
      faculty_remarks:
        'Section(s): Section 4\nReason: Hours look thin.\nRequired Correction: Add session dates.',
      admin_status: 'pending',
      partner_status: 'pending',
      admin_feedback: 'Old partner note that must not hide Faculty comments.',
      section11: null,
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      partnerApprovedAt: null,
      adminApprovedAt: null,
      opportunity: { title: 'Test' },
    };
    mockParticipantRepository.findOne.mockResolvedValue(null);
    mockStudentReportsRepository.findOne.mockImplementation(async () => report);

    const result = await service.checkReportStatus('student-1', OPP);
    const data = result.data as { feedback?: string; status?: string };

    expect(data.status).toBe('revision');
    expect(data.feedback).toBe(
      'Section(s): Section 4\nReason: Hours look thin.\nRequired Correction: Add session dates.',
    );
  });

  it('includes faculty_remarks on listing rows for Action Required / rejected cards', async () => {
    const opp = '582da802-e41e-488d-bd3d-d6dee59982b8';
    const leadReport = {
      id: 'report-lead',
      studentId: 'lead-student',
      opportunityId: opp,
      project_id: opp,
      status: 'revision',
      faculty_status: 'revision_requested',
      faculty_remarks: 'Please add baseline evidence.',
      partner_status: 'pending',
      admin_status: 'pending',
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date('2026-09-01T10:00:00.000Z'),
      student: { name: 'Lead', email: 'lead@test.com' },
      opportunity: {
        title: 'Team Project',
        organizationId: 'org-1',
        organization: { name: 'Org' },
      },
      section11: null,
    };

    mockStudentReportsRepository.find.mockResolvedValue([leadReport]);
    mockParticipantRepository.find.mockResolvedValue([
      {
        studentId: 'lead-student',
        projectId: opp,
        participationMode: 'team',
        teamId: 'TEAM-1',
        isTeamLead: true,
        createdAt: new Date(1),
        id: 'p-lead',
      },
    ]);

    const result = await service.findAll({ page: 1, limit: 50 });
    const row = result.data[0] as {
      faculty_remarks?: string | null;
      last_edited_by?: string | null;
    };

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(row.faculty_remarks).toBe('Please add baseline evidence.');
    expect(row.last_edited_by).toBe('Lead');
  });

  it('exposes admin revision comments and is_editable on listing rows for student Action Required', async () => {
    const opp = '582da802-e41e-488d-bd3d-d6dee59982b9';
    const leadReport = {
      id: 'report-admin-rev',
      studentId: 'lead-student',
      opportunityId: opp,
      project_id: opp,
      status: 'revision',
      faculty_status: 'approved',
      faculty_remarks: null as string | null,
      partner_status: 'pending',
      admin_status: 'rejected',
      admin_feedback: 'Please add SDG evidence and resubmit.',
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date('2026-09-01T10:00:00.000Z'),
      student: { name: 'Lead', email: 'lead@test.com' },
      opportunity: {
        title: 'Team Project',
        organizationId: 'org-1',
        organization: { name: 'Org' },
      },
      section11: null,
    };

    mockStudentReportsRepository.find.mockResolvedValue([leadReport]);
    mockParticipantRepository.find.mockResolvedValue([]);

    const result = await service.findAll({ page: 1, limit: 50 });
    const row = result.data[0] as {
      status?: string;
      feedback?: string | null;
      admin_feedback?: string | null;
      is_editable?: boolean;
    };

    expect(row.status).toBe('revision');
    expect(row.admin_feedback).toBe('Please add SDG evidence and resubmit.');
    expect(row.feedback).toBe('Please add SDG evidence and resubmit.');
    expect(row.is_editable).toBe(true);
  });

  it('remindReportReviewer reminds CIEL PK Admin (not Faculty) without changing report status', async () => {
    const report = {
      id: 'report-1',
      studentId: 'student-1',
      status: 'submitted',
      faculty_status: 'pending',
      faculty: { email: 'teacher@uni.edu' },
      student: { name: 'Lead', email: 'lead@test.com' },
      opportunity: { title: 'Community garden' },
      opportunityId: '582da802-e41e-488d-bd3d-d6dee59982b7',
      project_id: '582da802-e41e-488d-bd3d-d6dee59982b7',
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    mockUsersRepository.findOne.mockResolvedValue({
      id: 'student-1',
      email: 'lead@test.com',
      role: 'student',
    });
    mockParticipantRepository.findOne.mockResolvedValue({
      studentId: 'student-1',
      projectId: report.opportunityId,
      isTeamLead: true,
    });

    const result = await service.remindReportReviewer('student-1', 'report-1');

    expect(result.success).toBe(true);
    expect(result.sent_to).toBe('admin');
    expect(mockMailService.sendAdminStudentReportSubmitted).toHaveBeenCalledWith(
      'Community garden',
      expect.any(String),
      'report-1',
      'Lead',
      expect.anything(),
    );
    expect(
      mockMailService.sendFacultyStudentReportAwaitingReview,
    ).not.toHaveBeenCalled();
    expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
  });

  it('refuses a draft remind so status cannot be nudged by the reminder route', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-1',
      studentId: 'student-1',
      status: 'draft',
      faculty_status: 'pending',
      student: { name: 'Lead', email: 'lead@test.com' },
    });
    mockUsersRepository.findOne.mockResolvedValue({
      id: 'student-1',
      email: 'lead@test.com',
      role: 'student',
    });

    await expect(
      service.remindReportReviewer('student-1', 'report-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      mockMailService.sendFacultyStudentReportAwaitingReview,
    ).not.toHaveBeenCalled();
  });

  it('refuses a reminder on a rejected report', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'report-1',
      studentId: 'student-1',
      status: 'rejected',
      faculty_status: 'rejected',
      student: { name: 'Lead', email: 'lead@test.com' },
    });
    mockUsersRepository.findOne.mockResolvedValue({
      id: 'student-1',
      email: 'lead@test.com',
      role: 'student',
    });

    await expect(
      service.remindReportReviewer('student-1', 'report-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      mockMailService.sendFacultyStudentReportAwaitingReview,
    ).not.toHaveBeenCalled();
  });

  it('lets the linked Partner/NGO remind CIEL PK (route allows NGO/ORGANIZATION_ADMIN)', async () => {
    const report = {
      id: 'report-1',
      studentId: 'student-1',
      status: 'submitted',
      faculty_status: 'pending',
      faculty: { email: 'teacher@uni.edu' },
      student: { name: 'Lead', email: 'lead@test.com' },
      opportunity: {
        title: 'Community garden',
        partner_organization: { official_email: 'contact@partner-ngo.org' },
      },
      opportunityId: '582da802-e41e-488d-bd3d-d6dee59982b7',
      project_id: '582da802-e41e-488d-bd3d-d6dee59982b7',
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    mockUsersRepository.findOne.mockResolvedValue({
      id: 'partner-user-1',
      email: 'Contact@Partner-NGO.org',
      role: 'ngo',
    });
    mockParticipantRepository.findOne.mockResolvedValue(null);

    const result = await service.remindReportReviewer(
      'partner-user-1',
      'report-1',
    );

    expect(result.success).toBe(true);
    expect(result.sent_to).toBe('admin');
  });

  it('blocks an unlinked NGO/Partner account from reminding on a report they are not attached to', async () => {
    const report = {
      id: 'report-1',
      studentId: 'student-1',
      status: 'submitted',
      faculty_status: 'pending',
      faculty: { email: 'teacher@uni.edu' },
      student: { name: 'Lead', email: 'lead@test.com' },
      opportunity: {
        title: 'Community garden',
        partner_organization: { official_email: 'contact@partner-ngo.org' },
      },
      opportunityId: '582da802-e41e-488d-bd3d-d6dee59982b7',
      project_id: '582da802-e41e-488d-bd3d-d6dee59982b7',
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    mockUsersRepository.findOne.mockResolvedValue({
      id: 'other-ngo-user',
      email: 'someone@unrelated-ngo.org',
      role: 'ngo',
    });
    mockParticipantRepository.findOne.mockResolvedValue(null);

    await expect(
      service.remindReportReviewer('other-ngo-user', 'report-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a University reviewer remind Faculty only when their university matches the student', async () => {
    const report = {
      id: 'report-1',
      studentId: 'student-1',
      status: 'submitted',
      faculty_status: 'pending',
      faculty: { email: 'teacher@uni.edu' },
      student: {
        name: 'Lead',
        email: 'lead@test.com',
        university: 'Beaconhouse National University',
      },
      opportunity: { title: 'Community garden' },
      opportunityId: '582da802-e41e-488d-bd3d-d6dee59982b7',
      project_id: '582da802-e41e-488d-bd3d-d6dee59982b7',
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    mockParticipantRepository.findOne.mockResolvedValue(null);

    mockUsersRepository.findOne.mockResolvedValue({
      id: 'uni-staff-1',
      email: 'staff@bnu.edu.pk',
      role: 'university',
      university: 'Beaconhouse National University',
    });
    const allowed = await service.remindReportReviewer(
      'uni-staff-1',
      'report-1',
    );
    expect(allowed.success).toBe(true);

    mockUsersRepository.findOne.mockResolvedValue({
      id: 'uni-staff-2',
      email: 'staff@other.edu.pk',
      role: 'university',
      university: 'Some Other University',
    });
    await expect(
      service.remindReportReviewer('uni-staff-2', 'report-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('persists admin-regenerated section11 AI score', async () => {
    const report = {
      id: 'report-ai-1',
      studentId: 'student-1',
      opportunityId: 'opp-1',
      project_id: 'opp-1',
      status: 'submitted',
      section11: { summary_text: 'Old summary' },
      student: { name: 'Student' },
      opportunity: { id: 'opp-1', title: 'Test' },
    };
    mockStudentReportsRepository.findOne.mockResolvedValue(report);
    mockStudentReportsRepository.save.mockImplementation(async (row) => row);

    const result = await service.updateReportAiScore('report-ai-1', {
      section11: {
        summary_text: 'New AI audit',
        is_ai_generated: true,
      },
      cii_index: { totalScore: 82, level: 'High Impact Engagement' },
    });

    expect(verifyReportQb.execute).toHaveBeenCalled();
    expect(
      (report.section11 as { ai_generated_impact_score?: number })
        .ai_generated_impact_score,
    ).toBe(82);
    expect(result.success).toBe(true);
  });

  it('refuses admin AI score writes on CII-locked or verified reports', async () => {
    for (const row of [
      { status: 'submitted', ciiV45Lock: { lockedAt: new Date() } },
      { status: 'verified' },
      { status: 'paid' },
    ]) {
      mockStudentReportsRepository.findOne.mockResolvedValue({
        id: 'report-ai-2',
        section11: {},
        ...row,
      });
      await expect(
        service.updateReportAiScore('report-ai-2', { section11: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('verifyReport refuses approving a draft and reject/unlock of verified reports without force', async () => {
    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'r-d',
      status: 'draft',
      admin_status: 'pending',
      partner_status: 'pending',
      opportunity: {},
    });
    await expect(
      service.verifyReport('r-d', 'approve', 'admin'),
    ).rejects.toBeInstanceOf(BadRequestException);

    for (const action of ['reject', 'unlock'] as const) {
      mockStudentReportsRepository.findOne.mockResolvedValue({
        id: 'r-v',
        status: 'verified',
        admin_status: 'approved',
        partner_status: 'approved',
        faculty_status: 'approved',
        opportunity: {},
      });
      await expect(
        service.verifyReport('r-v', action, 'admin', 'needs work'),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    mockStudentReportsRepository.findOne.mockResolvedValue({
      id: 'r-v',
      status: 'verified',
      admin_status: 'approved',
      partner_status: 'approved',
      faculty_status: 'approved',
      opportunity: {},
    });
    const forced = await service.verifyReport(
      'r-v',
      'reject',
      'admin',
      'needs work',
      undefined,
      true,
      { id: 'admin-1', name: 'Admin' },
    );
    expect(forced.success).toBe(true);
    expect(verifyReportQb.__patch).toMatchObject({
      adminReviewedBy: 'Admin (admin-1)',
    });
  });

  it('admin findAll returns only canonical team lead report per team project', async () => {
    const opp = '582da802-e41e-488d-bd3d-d6dee59982b8';
    const leadReport = {
      id: 'report-lead',
      studentId: 'lead-student',
      opportunityId: opp,
      project_id: opp,
      status: 'submitted',
      partner_status: 'pending',
      admin_status: 'pending',
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      createdAt: new Date(),
      student: { name: 'Lead', email: 'lead@test.com' },
      opportunity: {
        title: 'Team Project',
        organizationId: 'org-1',
        organization: { name: 'Org' },
      },
      section11: null,
    };
    const memberReport = {
      ...leadReport,
      id: 'report-member',
      studentId: 'member-student',
      status: 'draft',
      student: { name: 'Member', email: 'member@test.com' },
    };

    mockStudentReportsRepository.find.mockResolvedValue([
      memberReport,
      leadReport,
    ]);
    mockParticipantRepository.find
      .mockResolvedValueOnce([
        {
          studentId: 'lead-student',
          projectId: opp,
          participationMode: 'team',
          teamId: 'TEAM-1',
          isTeamLead: true,
          createdAt: new Date(1),
          id: 'p-lead',
        },
        {
          studentId: 'member-student',
          projectId: opp,
          participationMode: 'team',
          teamId: 'TEAM-1',
          isTeamLead: false,
          createdAt: new Date(2),
          id: 'p-member',
        },
      ])
      .mockResolvedValueOnce([
        {
          studentId: 'lead-student',
          projectId: opp,
          participationMode: 'team',
          teamId: 'TEAM-1',
          isTeamLead: true,
          createdAt: new Date(1),
          id: 'p-lead',
        },
      ]);

    const result = await service.findAll({ page: 1, limit: 50 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('report-lead');
    expect(result.pagination.total).toBe(1);
  });

  it('admin findAll returns per-queue counts and applies q/status filters before pagination', async () => {
    const mk = (id: string, status: string, admin_status: string, name: string) => ({
      id,
      studentId: `s-${id}`,
      opportunityId: 'plain',
      project_id: 'plain',
      status,
      partner_status: 'pending',
      admin_status,
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      createdAt: new Date(),
      student: { name, email: `${id}@t.com` },
      opportunity: { title: 'T', organizationId: 'org-1', organization: { name: 'Org' } },
      section11: null,
    });
    mockStudentReportsRepository.find.mockResolvedValue([
      mk('a', 'submitted', 'pending', 'Alice'),
      mk('b', 'partner_verified', 'pending', 'Bob'),
      mk('c', 'verified', 'approved', 'Carol'),
      mk('d', 'revision', 'rejected', 'Dave'),
      mk('e', 'draft', 'pending', 'Eve'),
    ]);
    const all = await service.findAll({ page: 1, limit: 50 });
    expect((all as any).meta.counts).toEqual({
      needsReview: 2,
      verified: 1,
      revision: 1,
      all: 5,
    });
    const filtered = await service.findAll({
      page: 1,
      limit: 1,
      status: 'submitted',
      q: 'alice',
      includeHidden: 'true',
    });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.pagination.total).toBe(1);
    expect((filtered as any).meta.counts.all).toBe(1);
  });

  it('admin findAll returns one report per team when multiple teams share a project', async () => {
    const opp = '582da802-e41e-488d-bd3d-d6dee59982b8';
    const teamOneLeadReport = {
      id: 'report-team-one',
      studentId: 'lead-team-one',
      opportunityId: opp,
      project_id: opp,
      status: 'submitted',
      partner_status: 'pending',
      admin_status: 'pending',
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      createdAt: new Date(),
      student: { name: 'Lead One', email: 'lead1@test.com' },
      opportunity: {
        title: 'Shared Project',
        organizationId: 'org-1',
        organization: { name: 'Org' },
      },
      section11: null,
    };
    const teamTwoLeadReport = {
      ...teamOneLeadReport,
      id: 'report-team-two',
      studentId: 'lead-team-two',
      student: { name: 'Lead Two', email: 'lead2@test.com' },
    };

    mockStudentReportsRepository.find.mockResolvedValue([
      teamTwoLeadReport,
      teamOneLeadReport,
    ]);

    const participationRows = [
      {
        studentId: 'lead-team-one',
        projectId: opp,
        participationMode: 'team',
        teamId: 'TEAM-ONE',
        isTeamLead: true,
        createdAt: new Date(1),
        id: 'p-lead-one',
      },
      {
        studentId: 'lead-team-two',
        projectId: opp,
        participationMode: 'team',
        teamId: 'TEAM-TWO',
        isTeamLead: true,
        createdAt: new Date(2),
        id: 'p-lead-two',
      },
    ];
    mockParticipantRepository.find.mockImplementation(
      (opts: { where?: Record<string, unknown> }) => {
        const w = opts?.where ?? {};
        const matches = (row: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(w)) {
            if (value === undefined) continue;
            if (row[key] !== value) return false;
          }
          return true;
        };
        if (Array.isArray(w.studentId) || Array.isArray(w.projectId)) {
          const studentIds = Array.isArray(w.studentId)
            ? w.studentId
            : [w.studentId];
          const projectIds = Array.isArray(w.projectId)
            ? w.projectId
            : [w.projectId];
          return Promise.resolve(
            participationRows.filter(
              (row) =>
                studentIds.includes(row.studentId) &&
                projectIds.includes(row.projectId),
            ),
          );
        }
        return Promise.resolve(participationRows.filter((row) => matches(row)));
      },
    );

    const result = await service.findAll({ page: 1, limit: 50 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data.map((r: { id: string }) => r.id).sort()).toEqual([
      'report-team-one',
      'report-team-two',
    ]);
    expect(result.pagination.total).toBe(2);
  });

  it('admin findAll marks payment as paid for verified reports without a manual payment row', async () => {
    const opp = '582da802-e41e-488d-bd3d-d6dee59982b8';
    const verifiedReport = {
      id: 'report-verified',
      studentId: 'student-1',
      opportunityId: opp,
      project_id: opp,
      status: 'verified',
      partner_status: 'approved',
      admin_status: 'approved',
      submission_date: new Date(),
      reportSubmittedAt: new Date(),
      createdAt: new Date(),
      student: { name: 'Raouf', email: 'raouf@test.com' },
      opportunity: {
        title: 'Climate Campaign',
        organizationId: 'org-1',
        organization: { name: 'School' },
      },
      section11: null,
    };

    mockStudentReportsRepository.find.mockResolvedValue([verifiedReport]);
    mockPaymentRepository.find.mockResolvedValue([]);

    const result = await service.findAll({ page: 1, limit: 50 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    const row = result.data[0] as {
      payment_verified?: boolean;
      payment_status?: string;
    };
    expect(row.payment_verified).toBe(true);
    expect(row.payment_status).toBe('paid');
  });

  it('admin findAll keeps separate reports when three teams share applicationId without teamId', async () => {
    const opp = '582da802-e41e-488d-bd3d-d6dee59982b8';
    const sharedApp = 'shared-app-1';
    const reports = ['lead-a', 'lead-b', 'lead-c'].map((leadId, index) => ({
      id: `report-${leadId}`,
      studentId: leadId,
      opportunityId: opp,
      project_id: opp,
      status: 'submitted',
      partner_status: 'pending',
      admin_status: 'pending',
      submission_date: new Date(index),
      reportSubmittedAt: new Date(index),
      createdAt: new Date(index),
      student: { name: `Lead ${index + 1}`, email: `${leadId}@test.com` },
      opportunity: {
        title: 'Shared Project',
        organizationId: 'org-1',
        organization: { name: 'Org' },
      },
      section11: null,
    }));

    mockStudentReportsRepository.find.mockResolvedValue(reports);

    const participationRows = reports.map((report, index) => ({
      studentId: report.studentId,
      projectId: opp,
      participationMode: 'team',
      teamId: '',
      applicationId: sharedApp,
      isTeamLead: true,
      createdAt: new Date(index),
      id: `p-${index}`,
      fullName: report.student.name,
      email: report.student.email,
    }));

    mockParticipantRepository.find.mockImplementation(
      (opts: { where?: Record<string, unknown> }) => {
        const w = opts?.where ?? {};
        if (Array.isArray(w.studentId) || Array.isArray(w.projectId)) {
          const studentIds = Array.isArray(w.studentId)
            ? w.studentId
            : [w.studentId];
          const projectIds = Array.isArray(w.projectId)
            ? w.projectId
            : [w.projectId];
          return Promise.resolve(
            participationRows.filter(
              (row) =>
                studentIds.includes(row.studentId) &&
                projectIds.includes(row.projectId),
            ),
          );
        }
        if (w.projectId && w.applicationId) {
          return Promise.resolve(
            participationRows.filter(
              (row) =>
                row.projectId === w.projectId &&
                row.applicationId === w.applicationId,
            ),
          );
        }
        if (w.projectId && w.teamId) {
          return Promise.resolve(
            participationRows.filter(
              (row) => row.projectId === w.projectId && row.teamId === w.teamId,
            ),
          );
        }
        if (w.studentId && w.projectId) {
          return Promise.resolve(
            participationRows.filter(
              (row) =>
                row.studentId === w.studentId && row.projectId === w.projectId,
            ),
          );
        }
        return Promise.resolve(participationRows);
      },
    );
    mockParticipantRepository.findOne.mockImplementation(
      (opts: { where?: Record<string, unknown> }) => {
        const w = opts?.where ?? {};
        const row = participationRows.find(
          (part) =>
            part.studentId === w.studentId && part.projectId === w.projectId,
        );
        return Promise.resolve(row ?? null);
      },
    );

    const result = await service.findAll({ page: 1, limit: 50 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
    expect(result.data.map((r: { id: string }) => r.id).sort()).toEqual([
      'report-lead-a',
      'report-lead-b',
      'report-lead-c',
    ]);
    expect(
      new Set(
        (result.data as Array<{ team_lead?: { email?: string } }>).map(
          (r) => r.team_lead?.email,
        ),
      ),
    ).toEqual(
      new Set(['lead-a@test.com', 'lead-b@test.com', 'lead-c@test.com']),
    );
  });

  describe('findOneForPartner — open only after submit, university scope', () => {
    const OPP = '11111111-1111-4111-8111-111111111111';
    const ORG = 'org-1';
    const row = (status: string, extra: Record<string, unknown> = {}) => ({
      id: 'r-1',
      studentId: 'stu-1',
      opportunityId: OPP,
      project_id: OPP,
      status,
      admin_status: 'pending',
      faculty_status: 'pending',
      partner_status: 'pending',
      section1: { team_lead: { fullName: 'Lead', email: 'l@t.com', cnic: '' }, team_members: [] },
      section2: { problem_statement: 'secret draft answer' },
      section3: {},
      section4: {},
      section5: {},
      section6: {},
      section7: {},
      section8: {},
      section9: {},
      section10: {},
      section11: {},
      student: { id: 'stu-1', name: 'Stu', email: 's@t.com' },
      opportunity: { id: OPP, title: 'P', organizationId: ORG },
      createdAt: new Date('2020-01-01'),
      updatedAt: new Date('2020-06-01'),
      ...extra,
    });

    beforeEach(() => {
      mockParticipantRepository.findOne.mockResolvedValue(null);
      mockParticipantRepository.find.mockResolvedValue([]);
      mockStudentReportsRepository.find.mockResolvedValue([]);
      mockUsersRepository.findOne.mockResolvedValue({ id: 'stu-1', name: 'Stu', email: 's@t.com' });
    });

    it('refuses a draft report to partner/university even for the owning org', async () => {
      for (const status of ['draft', 'continue', '']) {
        mockStudentReportsRepository.findOne.mockResolvedValueOnce(row(status));
        await expect(service.findOneForPartner('r-1', ORG, { viewerRole: 'university' })).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
    });

    it('opens a report for the owning org once CIEL PK Admin has accepted it', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValueOnce({
        ...row('submitted'),
        admin_status: 'approved',
      });
      const res = await service.findOneForPartner('r-1', ORG, { viewerRole: 'ngo' });
      expect((res.data as { id: string }).id).toBe('r-1');
    });

    it('keeps a submitted report closed to the partner until CIEL PK Admin accepts it', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValueOnce({
        ...row('submitted'),
        admin_status: 'pending',
      });
      await expect(service.findOneForPartner('r-1', ORG, { viewerRole: 'ngo' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('refuses another org with no university scope', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValueOnce(row('submitted'));
      await expect(service.findOneForPartner('r-1', 'other-org', { viewerRole: 'ngo' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('opens a submitted report on an opportunity inside the university scope', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValueOnce(row('submitted'));
      const res = await service.findOneForPartner('r-1', 'uni-org', {
        viewerRole: 'university',
        universityScopeOpportunityIds: [OPP],
      });
      expect((res.data as { id: string }).id).toBe('r-1');
    });

    it('still refuses a report outside the university scope', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValueOnce(row('submitted'));
      await expect(
        service.findOneForPartner('r-1', 'uni-org', {
          viewerRole: 'university',
          universityScopeOpportunityIds: ['some-other-opp'],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a university-scope draft is still refused', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValueOnce(row('draft'));
      await expect(
        service.findOneForPartner('r-1', 'uni-org', {
          viewerRole: 'university',
          universityScopeOpportunityIds: [OPP],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('report lifecycle hardening', () => {
    const lockedCii = () => ({
      locked: true,
      hash: 'h',
      lockedAt: '2026-05-01T00:00:00.000Z',
      aiRecommendedScore: 70,
      adminApprovedScore: 70,
    });

    it('a second submit of an already-submitted report is locked: no overwrite, no status regression', async () => {
      const report: Record<string, any> = {
        id: 'report-1',
        studentId: 'student-1',
        opportunityId: 'opp-1',
        status: 'partner_verified',
        admin_status: 'approved',
        partner_status: 'approved',
        faculty_status: 'approved',
        section2: { problem_statement: 'ORIGINAL' },
        reportSubmittedAt: new Date('2026-05-01T00:00:00.000Z'),
      };
      mockStudentReportsRepository.findOne.mockResolvedValue(report);
      mockStudentReportsRepository.save.mockClear();

      const res: any = await service.createReport(
        'student-1',
        { opportunityId: 'opp-1', section2: { problem_statement: 'SNEAKY EDIT' } },
        [],
        true,
      );

      expect(res.success).toBe(true);
      expect(res.data.already_submitted).toBe(true);
      expect(res.data.status).toBe('partner_verified');
      expect(report.section2.problem_statement).toBe('ORIGINAL');
      expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
    });

    it('a submit that cannot resolve a project is refused instead of skipping every gate', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValue(null);
      mockStudentReportsRepository.save.mockClear();
      await expect(
        service.createReport('student-1', { section2: { problem_statement: 'x' } }, [], true),
      ).rejects.toThrow(/not linked to a valid project/);
      expect(mockStudentReportsRepository.save).not.toHaveBeenCalled();
    });

    it('a finally rejected report cannot be "submitted" again with a fake success', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValue({
        id: 'report-1',
        studentId: 'student-1',
        opportunityId: 'opp-1',
        status: 'rejected',
        admin_status: 'pending',
        faculty_status: 'rejected',
      });
      await expect(
        service.createReport('student-1', { opportunityId: 'opp-1' }, [], true),
      ).rejects.toThrow(/rejected/);
    });

    it('admin cannot accept a report that is still in revision', async () => {
      mockStudentReportsRepository.findOne.mockResolvedValue({
        id: 'report-1',
        status: 'revision',
        admin_status: 'rejected',
        partner_status: 'pending',
        opportunity: { requiresPartnerApproval: false },
      });
      await expect(service.verifyReport('report-1', 'approve', 'admin')).rejects.toThrow(/sent back for revision/);
    });

    it('rejecting retires the CII lock (kept as history) and clears awards, so the score must be re-run', async () => {
      const report: Record<string, any> = {
        id: 'report-1',
        studentId: 'student-1',
        status: 'submitted',
        admin_status: 'approved',
        partner_status: 'pending',
        ciiV45: { finalCII: 72, sectionScores: [] },
        ciiV45Lock: lockedCii(),
        awardBadges: [{ rank: 1 }],
        opportunity: { title: 'Beach clean-up', requiresPartnerApproval: false },
        student: { id: 'student-1', name: 'Ali Khan', email: 'ali@uni.edu' },
      };
      mockStudentReportsRepository.findOne.mockResolvedValue(report);
      mockMailService.sendStudentReportAdminDecision = jest.fn().mockResolvedValue(undefined);

      await service.verifyReport('report-1', 'reject', 'admin', 'Hours do not match the register.', undefined, true);

      expect(report.status).toBe('revision');
      expect(report.ciiV45Lock).toBeNull();
      expect(report.ciiV45.finalCII).toBe(72); // old score text kept for audit …
      expect(report.ciiV45.previousLocks).toHaveLength(1); // … but the lock is retired
      expect(report.ciiV45.previousLocks[0]).toMatchObject({ locked: true, supersededBy: 'rejected' });
      expect(report.awardBadges).toEqual([]);
      await new Promise((r) => setTimeout(r, 30));
      expect(mockMailService.sendStudentReportAdminDecision).toHaveBeenCalledWith(
        'ali@uni.edu',
        'Ali',
        'Beach clean-up',
        'revision',
        'Hours do not match the register.',
      );
    });

    it('unlock turns the report back into a real draft: submit stamp cleared so autosaves persist', async () => {
      const report: Record<string, any> = {
        id: 'report-1',
        studentId: 'student-1',
        status: 'submitted',
        admin_status: 'pending',
        partner_status: 'pending',
        reportSubmittedAt: new Date('2026-05-01T00:00:00.000Z'),
        ciiV45: { finalCII: 60 },
        ciiV45Lock: lockedCii(),
        opportunity: { title: 'T', requiresPartnerApproval: false },
        student: { id: 'student-1', name: 'Ali', email: 'a@b.c' },
      };
      mockStudentReportsRepository.findOne.mockResolvedValue(report);
      mockMailService.sendStudentReportAdminDecision = jest.fn().mockResolvedValue(undefined);

      await service.verifyReport('report-1', 'unlock', 'admin', 'Please add attendance proof.');

      expect(report.status).toBe('draft');
      expect(report.reportSubmittedAt).toBeNull();
      expect(report.ciiV45Lock).toBeNull();
      // the compare-and-swap UPDATE must actually persist the cleared stamp
      expect(verifyReportQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ reportSubmittedAt: null, ciiV45Lock: null, status: 'draft' }),
      );
    });

    it('re-approving does not move the publish timestamp', async () => {
      const publishedAt = new Date('2026-05-01T00:00:00.000Z');
      const report: Record<string, any> = {
        id: 'report-1',
        status: 'submitted',
        admin_status: 'approved',
        partner_status: 'pending',
        faculty_status: 'approved',
        adminApprovedAt: publishedAt,
        ciiV45Lock: lockedCii(),
        opportunity: { requiresPartnerApproval: true },
      };
      mockStudentReportsRepository.findOne.mockResolvedValue(report);
      await service.verifyReport('report-1', 'approve', 'admin');
      expect(report.adminApprovedAt).toBe(publishedAt);
    });
  });

  describe('hours gate is scoped to the submitting team', () => {
    const run = (roster: any[], logs: any[], submitter = 'student-1') => {
      mockOpportunityRepository.findOne.mockResolvedValue({
        id: 'opp-1', title: 'T', isStudentCreated: false, admin_approved: true,
        workflowStage: 'live', status: 'active', timeline: { expected_hours: 16 },
      });
      mockParticipantRepository.find.mockResolvedValue(roster);
      mockAttendanceLogsRepository.find.mockResolvedValue(logs);
      mockStudentReportsRepository.findOne.mockResolvedValue(null);
      return (service as any).assertEveryTeamMemberMetRequiredHours('opp-1', 16, submitter);
    };
    const row = (id: string, studentId: string, extra: Record<string, unknown> = {}) => ({
      id, projectId: 'opp-1', studentId, status: 'accepted', fullName: id, ...extra,
    });
    const hrs = (participantId: string, h: number) => ({
      participantId, projectId: 'opp-1', sessionHours: h, approvalStatus: 'approved', entryStatus: 'verified',
    });

    it("another team's short member does not block this team", async () => {
      await expect(
        run(
          [row('a1', 'student-1', { teamId: 'T1' }), row('a2', 'student-2', { teamId: 'T1' }), row('b1', 'student-9', { teamId: 'T2' })],
          [hrs('a1', 16), hrs('a2', 16)], // team T2's member logged nothing
        ),
      ).resolves.toBeUndefined();
    });

    it('a pending / withdrawn applicant does not block the team', async () => {
      await expect(
        run(
          [row('a1', 'student-1', { teamId: 'T1' }), row('p1', 'student-3', { teamId: 'T1', status: 'pending' })],
          [hrs('a1', 16)],
        ),
      ).resolves.toBeUndefined();
    });

    it("this team's own short member still blocks, even if the team total is high", async () => {
      await expect(
        run(
          [row('a1', 'student-1', { teamId: 'T1' }), row('a2', 'student-2', { teamId: 'T1' })],
          [hrs('a1', 40)],
        ),
      ).rejects.toThrow(/individually meet the required hours/);
    });

    it('a solo participant is judged alone', async () => {
      await expect(
        run(
          [row('s1', 'student-1', { participationMode: 'individual' }), row('s2', 'student-2', { participationMode: 'individual' })],
          [hrs('s1', 16)],
        ),
      ).resolves.toBeUndefined();
    });
  });
});

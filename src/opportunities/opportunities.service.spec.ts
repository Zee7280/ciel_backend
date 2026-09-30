import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityWorkflowService } from './opportunity-workflow.service';
import { Opportunity } from './entities/opportunity.entity';

// create() gates on a fully-complete profile before it even looks at approval routing — stub it
// out so these tests can focus on the approval-status decision without building a fully valid
// user profile.
jest.mock('../users/profile-completion.util', () => ({
    ...jest.requireActual('../users/profile-completion.util'),
    getProfileCompletionStatus: () => ({ profile_complete: true, profile_missing_fields: [] }),
}));

/** Fake EntityManager whose `connection.createQueryRunner()` hands out ONE pinned runner. */
function lockManager(query: jest.Mock) {
    const runner = { connect: jest.fn(), query, release: jest.fn() };
    return { query: jest.fn(), connection: { createQueryRunner: () => runner }, runner };
}

/** Repo bits POST /opportunities' idempotency guard needs: pinned lock runner + recent-row query. */
function createDedupeStubs(recent: unknown = null) {
    const lockQuery = jest.fn().mockResolvedValue(undefined);
    const dedupeGetOne = jest.fn().mockResolvedValue(recent);
    const dedupeQb: any = {};
    for (const m of ['where', 'andWhere', 'orderBy']) dedupeQb[m] = jest.fn(() => dedupeQb);
    dedupeQb.getOne = dedupeGetOne;
    return {
        stubs: { manager: lockManager(lockQuery), createQueryBuilder: jest.fn(() => dedupeQb) },
        lockQuery,
        dedupeGetOne,
        dedupeQb,
    };
}

function makeService(opportunitiesRepo: Record<string, unknown>) {
    const noop = {} as any;
    return new OpportunitiesService(
        opportunitiesRepo as any,
        noop, // participationRepository
        noop, // usersRepository
        noop, // organizationsRepository
        noop, // organizationsService
        noop, // engagementService
        noop, // mailService
        noop, // notificationsService
        noop, // opportunityWorkflow
        noop, // opportunityApplicationsService
        noop, // facultyUniversityScope
    );
}

describe('OpportunitiesService — public partner verification', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('getPublicPartnerVerificationPreview', () => {
        it('returns a safe summary keyed strictly by partnerToken, never faculty/liaison tokens', async () => {
            const opp = {
                id: 'opp-1',
                title: 'Community clean-up',
                partnerToken: 'secret-token',
                partnerVerified: false,
                supervision: { supervisor_name: 'Dr Khan', contact: 'khan@uni.edu' },
            } as unknown as Opportunity;
            const findOne = jest.fn().mockResolvedValue(opp);
            const service = makeService({ findOne });

            const preview = await service.getPublicPartnerVerificationPreview('secret-token');

            expect(findOne).toHaveBeenCalledWith({ where: { partnerToken: 'secret-token' } });
            expect(preview.title).toBe('Community clean-up');
            expect(preview.alreadyVerified).toBe(false);
            expect(preview.detail.supervision.faculty.name).toBe('Dr Khan');
        });

        it('reflects an already-verified opportunity', async () => {
            const opp = { id: 'opp-1', title: 'X', partnerToken: 't', partnerVerified: true } as unknown as Opportunity;
            const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });
            const preview = await service.getPublicPartnerVerificationPreview('t');
            expect(preview.alreadyVerified).toBe(true);
        });

        it('throws NotFoundException for an unknown or expired token', async () => {
            const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });
            await expect(service.getPublicPartnerVerificationPreview('bad-token')).rejects.toThrow(NotFoundException);
        });
    });

    describe('verifyOpportunityToken — identity gate', () => {
        it('allows anonymous partner-token verification even when VERIFICATION_REQUIRE_AUTH is on', async () => {
            process.env.VERIFICATION_REQUIRE_AUTH = 'true';
            const opp = {
                id: 'opp-1',
                partnerToken: 'partner-tok',
                partnerVerified: true, // already-verified short-circuit — no side effects to mock
                isStudentCreated: false,
                title: 'Community clean-up',
            } as unknown as Opportunity;
            const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });

            const result = await service.verifyOpportunityToken('partner-tok', undefined);
            expect(result.success).toBe(true);
        });

        it('allows anonymous faculty-token verification even when VERIFICATION_REQUIRE_AUTH is on', async () => {
            process.env.VERIFICATION_REQUIRE_AUTH = 'true';
            const opp = {
                id: 'opp-1',
                faculty_verification_token: 'faculty-tok',
                isStudentCreated: true,
                faculty_verified: true,
                title: 'Community clean-up',
            } as unknown as Opportunity;
            const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });

            const result = await service.verifyOpportunityToken('faculty-tok', undefined);
            expect(result.success).toBe(true);
        });

        it('refuses a faculty token that is not awaiting review, without asking for login', async () => {
            process.env.VERIFICATION_REQUIRE_AUTH = 'true';
            const opp = {
                id: 'opp-1',
                faculty_verification_token: 'faculty-tok',
                isStudentCreated: true,
                faculty_verified: false,
                admin_approved: true,
                creatorId: 'student-1',
                workflowStage: 'live',
                status: 'active',
                title: 'Community clean-up',
            } as unknown as Opportunity;
            const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });

            await expect(service.verifyOpportunityToken('faculty-tok', undefined)).rejects.toThrow(BadRequestException);
        });

        it('allows anonymous faculty-token verification when VERIFICATION_REQUIRE_AUTH is off (dev default)', async () => {
            process.env.VERIFICATION_REQUIRE_AUTH = 'false';
            const opp = {
                id: 'opp-1',
                faculty_verification_token: 'faculty-tok',
                isStudentCreated: true,
                faculty_verified: true, // already-verified short-circuit — no side effects to mock
                title: 'Community clean-up',
            } as unknown as Opportunity;
            const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });

            const result = await service.verifyOpportunityToken('faculty-tok', undefined);
            expect(result.success).toBe(true);
        });
    });
});

describe('OpportunitiesService — public faculty verification', () => {
    it('previews by faculty token and omits the token from the flashcard record', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Food rescue',
            faculty_verification_token: 'faculty-secret',
            partnerToken: 'partner-secret',
            isStudentCreated: true,
            faculty_verified: false,
            admin_approved: false,
            creatorId: 'student-1',
            status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            types: ['Community Service'],
            mode: 'On-site',
        } as unknown as Opportunity;
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });
        const preview = await service.getPublicFacultyVerificationPreview('faculty-secret');
        expect(preview.title).toBe('Food rescue');
        expect(preview.canDecide).toBe(true);
        expect(preview.record).not.toHaveProperty('faculty_verification_token');
        expect(preview.record).not.toHaveProperty('partnerToken');
        expect(JSON.stringify(preview)).not.toContain('faculty-secret');
    });

    it('rejects via the faculty token without a login', async () => {
        const opp = {
            id: 'opp-f',
            faculty_verification_token: 'ftok',
            isStudentCreated: false,
            faculty_verified: false,
            facultyApprovalStatus: 'pending',
            admin_approved: false,
            creatorId: 'ngo-1',
            status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            title: 'Campus drive',
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        const result = await service.decideOpportunityViaFacultyToken('ftok', 'reject', 'Not a fit');

        expect(save).toHaveBeenCalled();
        expect((opp as any).status).toBe('rejected');
        expect((opp as any).rejectionReason).toBe('Not a fit');
        expect(result.success).toBe(true);
    });
});

describe('OpportunitiesService — public directory visibility (isPubliclyVisibleOpportunity)', () => {
    const service = makeService({});
    const isVisible = (opp: Partial<Opportunity>) =>
        (service as any).isPubliclyVisibleOpportunity(opp as Opportunity);

    it('shows a scoped faculty/partner opportunity publicly when a real participation_scope backs it (card public, Apply Now gated)', () => {
        expect(
            isVisible({
                isStudentCreated: false,
                visibility_and_academic_linkage: { visibility_type: 'own_university_only' },
                participation_scope: { rule: 'own_university_only', university_names: ['University A'] },
            }),
        ).toBe(true);
    });

    it('hides a restrictive faculty/partner opportunity with no participation_scope to gate Apply Now with', () => {
        expect(
            isVisible({
                isStudentCreated: false,
                visibility_and_academic_linkage: { visibility_type: 'restricted_specific_universities' },
                participation_scope: null,
            }),
        ).toBe(false);
    });

    it('always shows an "open to all" opportunity', () => {
        expect(
            isVisible({
                isStudentCreated: false,
                visibility_and_academic_linkage: { visibility_type: 'open_all_universities' },
            }),
        ).toBe(true);
    });

    it('still respects the legacy visibility fallback when no explicit linkage type is set', () => {
        expect(isVisible({ isStudentCreated: false, visibility: 'restricted', participation_scope: null })).toBe(false);
        expect(
            isVisible({
                isStudentCreated: false,
                visibility: 'restricted',
                participation_scope: { rule: 'own_university_only' },
            }),
        ).toBe(true);
    });

    it('hides a student-created opportunity until CIEL approval, then lists it even when visibility is restricted', () => {
        expect(
            isVisible({
                isStudentCreated: true,
                visibility: 'restricted',
                participation_scope: { rule: 'own_university_only' },
            }),
        ).toBe(false);
        expect(
            isVisible({
                isStudentCreated: true,
                admin_approved: true,
                workflowStage: 'pending_admin',
                status: 'pending_admin',
                visibility_and_academic_linkage: { visibility_type: 'open_all_universities' },
            }),
        ).toBe(false);
        expect(
            isVisible({
                isStudentCreated: true,
                admin_approved: true,
                workflowStage: 'live',
                status: 'active',
                visibility: 'restricted',
            }),
        ).toBe(true);
    });
});

describe('OpportunitiesService — student create-opportunity is locked to their own university', () => {
    const baseDto = () => ({
        title: 'Beach clean-up',
        mode: 'Remote', // keep location.pin out of the way — these tests are about university scoping
        supervision: { contact: 'teacher@uni.edu', faculty_department: 'CS' },
        executing_context: {
            type: 'independent',
            independent_community_activity: { activity_site_description: 'Local park' },
        },
        safety_declaration: {
            environment_safe_and_appropriate: true,
            students_guided_and_supervised: true,
            lawful_ethical_and_non_hazardous: true,
            precautions_and_basic_safety: true,
        },
        submission_confirmations: {
            academically_valid_and_accurately_described: true,
            activity_properly_supervised: true,
            environment_safe_and_appropriate: true,
            information_correct_and_verifiable: true,
        },
    });

    it('rejects a student trying to scope their own opportunity to "open to all universities"', async () => {
        const service = makeService({});
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                role: 'student',
                name: 'Ali',
                phone: '0300',
                email: 'ali@uni.edu',
                city: 'Lahore',
                university: 'University A',
                department: 'CS',
            }),
        };

        await expect(
            service.createStudentOpportunity('student-1', {
                ...baseDto(),
                participation_scope: { rule: 'open_all_universities' },
            } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a student trying to restrict/target a university other than their own', async () => {
        const service = makeService({});
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                role: 'student',
                name: 'Ali',
                phone: '0300',
                email: 'ali@uni.edu',
                city: 'Lahore',
                university: 'University A',
                department: 'CS',
            }),
        };

        await expect(
            service.createStudentOpportunity('student-1', {
                ...baseDto(),
                participation_scope: {
                    rule: 'restricted_specific_universities',
                    university_names: ['University B'],
                },
            } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('OpportunitiesService — createStudentOpportunity advisory lock', () => {
    it('acquires and releases the per-student advisory lock around the duplicate-title check and create, even on the happy path', async () => {
        const managerQuery = jest.fn().mockResolvedValue(undefined);
        const opportunitiesRepo = {
            manager: lockManager(managerQuery),
            create: jest.fn((payload: any) => payload),
            save: jest.fn(async (row: any) => ({ ...row, id: 'opp-new' })),
        };
        const service = makeService(opportunitiesRepo);
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                role: 'student',
                name: 'Ali',
                phone: '0300',
                email: 'ali@uni.edu',
                city: 'Lahore',
                university: 'University A',
                department: 'CS',
            }),
        };
        (service as any).organizationsRepository = {
            create: jest.fn((row: any) => row),
            save: jest.fn(async (row: any) => ({ ...row, id: 'org-1' })),
        };
        (service as any).opportunityWorkflow = { initStudentCreated: jest.fn() };
        (service as any).mailService = {
            sendFacultyStudentOpportunityVerification: jest.fn().mockResolvedValue(undefined),
        };

        const result = await service.createStudentOpportunity('student-1', {
            title: 'CS', // < 6 chars — findSimilarStudentCreatedOpportunities short-circuits, no queryBuilder needed
            mode: 'Remote', // location.pin isn't relevant to this test — keep it out of the way
            timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
            supervision: { contact: 'teacher@uni.edu', faculty_department: 'CS' },
            executing_context: {
                type: 'independent',
                independent_community_activity: { activity_site_description: 'Local park' },
            },
            safety_declaration: {
                environment_safe_and_appropriate: true,
                students_guided_and_supervised: true,
                lawful_ethical_and_non_hazardous: true,
                precautions_and_basic_safety: true,
            },
            submission_confirmations: {
                academically_valid_and_accurately_described: true,
                activity_properly_supervised: true,
                environment_safe_and_appropriate: true,
                information_correct_and_verifiable: true,
            },
        } as any);

        expect(result).toEqual(expect.objectContaining({ success: true }));
        expect(managerQuery.mock.calls[0][0]).toContain('pg_advisory_lock');
        expect(managerQuery.mock.calls[0][1]).toEqual(['create_student_opportunity:student-1']);
        expect(managerQuery.mock.calls[1][0]).toContain('pg_advisory_unlock');
        expect(managerQuery.mock.calls[1][1]).toEqual(['create_student_opportunity:student-1']);
        // lock + unlock go through the ONE pinned query runner (same DB session), which is then
        // released back to the pool — never through pooled `manager.query` (two arbitrary sessions).
        expect(opportunitiesRepo.manager.query).not.toHaveBeenCalled();
        expect(opportunitiesRepo.manager.runner.connect).toHaveBeenCalledTimes(1);
        expect(opportunitiesRepo.manager.runner.release).toHaveBeenCalledTimes(1);
    });

    it('still releases the lock when the duplicate-title check throws', async () => {
        const managerQuery = jest.fn().mockResolvedValue(undefined);
        const opportunitiesRepo = { manager: lockManager(managerQuery) };
        const service = makeService(opportunitiesRepo);
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                role: 'student',
                name: 'Ali',
                phone: '0300',
                email: 'ali@uni.edu',
                city: 'Lahore',
                university: 'University A',
                department: 'CS',
            }),
        };
        jest.spyOn(service, 'findSimilarStudentCreatedOpportunities').mockResolvedValue([
            { id: 'existing-1', title: 'Beach clean-up drive' } as any,
        ]);

        await expect(
            service.createStudentOpportunity('student-1', {
                title: 'Beach clean-up drive', // >= 6 chars — reaches the real duplicate check
                mode: 'Remote', // location.pin isn't relevant to this test — keep it out of the way
                timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
                supervision: { contact: 'teacher@uni.edu', faculty_department: 'CS' },
                executing_context: {
                    type: 'independent',
                    independent_community_activity: { activity_site_description: 'Local park' },
                },
                safety_declaration: {
                    environment_safe_and_appropriate: true,
                    students_guided_and_supervised: true,
                    lawful_ethical_and_non_hazardous: true,
                    precautions_and_basic_safety: true,
                },
                submission_confirmations: {
                    academically_valid_and_accurately_described: true,
                    activity_properly_supervised: true,
                    environment_safe_and_appropriate: true,
                    information_correct_and_verifiable: true,
                },
            } as any),
        ).rejects.toThrow('similar title');
        expect(managerQuery).toHaveBeenCalledTimes(2);
        expect(managerQuery.mock.calls[1][0]).toContain('pg_advisory_unlock');
    });
});

describe('OpportunitiesService — student edit/resubmit after faculty revision', () => {
    it('re-enters pending_faculty (not stuck in "revision") when the student saves an edit', async () => {
        const opp = {
            id: 'opp-1',
            creatorId: 'student-1',
            isStudentCreated: true,
            status: 'revision',
            workflowStage: 'revision',
            facultyApprovalStatus: 'revision_requested',
            partnerApprovalStatus: 'not_applicable',
            adminApprovalStatus: 'pending',
            faculty_verified: false,
            faculty_verification_status: 'pending_faculty',
            partnerVerified: true,
            requiresPartnerApproval: false,
            supervision: { contact: 'teacher@uni.edu' },
        } as unknown as Opportunity;
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'student-1', role: 'student' }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue(null),
        };

        const saved = await service.update('student-1', {
            id: 'opp-1',
            title: 'Updated title after fixing supervision details',
        } as any);

        expect((saved as any).workflowStage).toBe('pending_faculty');
        expect((saved as any).status).toBe('pending_faculty');
        expect((saved as any).facultyApprovalStatus).toBe('pending');
        expect((saved as any).faculty_verification_token).toBeTruthy();
    });

    it('does not force a private-candidate (no faculty line) resubmit back into pending_faculty', async () => {
        const opp = {
            id: 'opp-2',
            creatorId: 'student-2',
            isStudentCreated: true,
            status: 'rejected',
            workflowStage: 'rejected',
            facultyApprovalStatus: 'not_applicable',
            partnerApprovalStatus: 'rejected',
            adminApprovalStatus: 'pending',
            faculty_verified: true,
            faculty_verification_status: 'not_required',
            partnerVerified: false,
            requiresPartnerApproval: true,
            partner_organization: { official_email: 'partner@org.com' },
        } as unknown as Opportunity;
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'student-2', role: 'student' }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue(null),
        };

        const saved = await service.update('student-2', {
            id: 'opp-2',
            title: 'Fixed after partner rejection',
        } as any);

        expect((saved as any).workflowStage).toBe('pending_partner');
        expect((saved as any).facultyApprovalStatus).toBe('not_applicable');
    });
});

describe('OpportunitiesService — partnerDashboardApprove ownership guard', () => {
    const makeApprovedOpp = () => ({
        id: 'opp-partner-1',
        isStudentCreated: false,
        organizationId: 'org-A',
        partnerApprovalStatus: 'approved',
        workflowStage: 'pending_admin',
        partner_organization: { official_email: 'realpartner@org.com' },
    });

    it('refuses a partner who is not the assigned reviewer, even for an already-approved opportunity', async () => {
        const opp = makeApprovedOpp();
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });

        await expect(
            service.partnerDashboardApprove('opp-partner-1', {
                email: 'someoneelse@org.com',
                organizationId: 'org-B',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets the logged-in organisation approve when only the contact person name contains the org name', async () => {
        const opp = {
            id: 'opp-contact-name',
            isStudentCreated: true,
            organizationId: 'student-placeholder',
            faculty_verified: true,
            partnerVerified: false,
            requiresPartnerApproval: true,
            partnerApprovalStatus: 'pending',
            workflowStage: 'pending_partner',
            status: 'pending_partner',
            supervision: { partner_contact_person: 'Fellah Khalid' },
            partner_organization: { official_email: 'fellah.khalid@example.com' },
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });
        (service as any).organizationsService = {
            findOne: jest.fn().mockRejectedValue(new Error('stale org id')),
            getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-fellah', name: 'FELLAH' }),
        };
        (service as any).facultyUniversityScope = {
            normalizeOrgName: (name: string) => (name || '').trim().toLowerCase(),
        };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        jest.spyOn(service as any, 'handlePartnerApprovedSideEffects').mockResolvedValue(undefined);

        const result = await service.partnerDashboardApprove('opp-contact-name', {
            email: 'fatima@fellah.org',
            organizationId: 'stale-org-id',
            id: 'user-fatima',
            name: 'Fatima Khalid',
        });

        expect(result).toBe(opp);
        expect(save).toHaveBeenCalled();
    });

    it('lets the organisation named on a student opportunity approve when the contact email is someone else', async () => {
        const opp = {
            id: 'opp-named-org',
            isStudentCreated: true,
            organizationId: 'student-placeholder',
            faculty_verified: true,
            partnerVerified: false,
            requiresPartnerApproval: true,
            partnerApprovalStatus: 'pending',
            workflowStage: 'pending_partner',
            status: 'pending_partner',
            supervision: { partner_org_name: 'Fellah Khalid' },
            partner_organization: {
                organization_name: 'FELLAH',
                official_email: 'fellah.khalid@example.com',
            },
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });
        (service as any).organizationsService = {
            findOne: jest.fn().mockResolvedValue({ id: 'org-fellah', name: 'FELLAH' }),
        };
        (service as any).facultyUniversityScope = {
            normalizeOrgName: (name: string) => (name || '').trim().toLowerCase(),
        };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        jest.spyOn(service as any, 'handlePartnerApprovedSideEffects').mockResolvedValue(undefined);

        const result = await service.partnerDashboardApprove('opp-named-org', {
            email: 'fatima@fellah.org',
            organizationId: 'org-fellah',
            id: 'user-fatima',
            name: 'Fatima Khalid',
        });

        expect(result).toBe(opp);
        expect(save).toHaveBeenCalled();
    });

    it('lets the correct partner double-click approve on an already-approved opportunity without erroring', async () => {
        const opp = makeApprovedOpp();
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });

        const result = await service.partnerDashboardApprove('opp-partner-1', {
            email: 'realpartner@org.com',
            organizationId: 'org-A',
        });

        expect(result).toBe(opp);
        expect(save).not.toHaveBeenCalled();
    });

    it('allows the assigned partner to request revision on a non-student-created (faculty/NGO) opportunity', async () => {
        const opp = {
            ...makeApprovedOpp(),
            partnerApprovalStatus: 'pending',
            partnerVerified: false,
            requiresPartnerApproval: true,
            workflowStage: 'pending_partner',
            status: 'pending_partner',
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        const notifySpy = jest
            .spyOn(service as any, 'notifyStudentOpportunityUpdate')
            .mockResolvedValue(undefined);

        const saved = await service.partnerDashboardRevise(
            'opp-partner-1',
            { email: 'realpartner@org.com', organizationId: 'org-A' },
            'Please confirm the exact venue address',
        );

        expect((saved as any).partnerApprovalStatus).toBe('revision_requested');
        expect((saved as any).status).toBe('revision');
        expect(notifySpy).toHaveBeenCalled();
    });
});

describe('OpportunitiesService — decideOpportunityViaPartnerToken (public flashcard reject/revision)', () => {
    it('rejects a student-created opportunity by token and notifies the student', async () => {
        const opp = {
            id: 'opp-tok-1',
            partnerToken: 'tok-1',
            partnerVerified: false,
            isStudentCreated: true,
            title: 'Beach clean-up',
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        const notifySpy = jest
            .spyOn(service as any, 'notifyStudentOpportunityUpdate')
            .mockResolvedValue(undefined);

        const result = await service.decideOpportunityViaPartnerToken('tok-1', 'reject', 'Not a fit');

        expect(save).toHaveBeenCalled();
        expect((opp as any).status).toBe('rejected');
        expect((opp as any).rejectionReason).toBe('Not a fit');
        expect(notifySpy).toHaveBeenCalled();
        expect(result.success).toBe(true);
    });

    it('allows a revision request for a non-student-created (faculty/NGO) opportunity too — creator still gets notified', async () => {
        const opp = {
            id: 'opp-tok-2',
            partnerToken: 'tok-2',
            partnerVerified: false,
            isStudentCreated: false,
            creatorId: undefined,
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        const notifySpy = jest
            .spyOn(service as any, 'notifyStudentOpportunityUpdate')
            .mockResolvedValue(undefined);

        const result = await service.decideOpportunityViaPartnerToken('tok-2', 'revision', 'Please add exact venue');

        expect(save).toHaveBeenCalled();
        expect((opp as any).partnerApprovalStatus).toBe('revision_requested');
        expect((opp as any).status).toBe('revision');
        expect(notifySpy).toHaveBeenCalled();
        expect(result.success).toBe(true);
    });

    it('refuses to decide an opportunity that was already verified through this link', async () => {
        const opp = {
            id: 'opp-tok-3',
            partnerToken: 'tok-3',
            partnerVerified: true,
            isStudentCreated: true,
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const service = makeService({ findOne, save: jest.fn() });

        await expect(
            service.decideOpportunityViaPartnerToken('tok-3', 'reject'),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException for an unknown token', async () => {
        const findOne = jest.fn().mockResolvedValue(null);
        const service = makeService({ findOne });

        await expect(
            service.decideOpportunityViaPartnerToken('missing-token', 'reject'),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to replay a stale link to revive an already-rejected opportunity (partnerVerified stays false on reject, so that guard alone would not catch this)', async () => {
        const opp = {
            id: 'opp-tok-4',
            partnerToken: 'tok-4',
            partnerVerified: false,
            workflowStage: 'rejected',
            status: 'rejected',
            isStudentCreated: false,
        };
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: any) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        await expect(
            service.decideOpportunityViaPartnerToken('tok-4', 'revision', 'trying to resurrect it'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(save).not.toHaveBeenCalled();
    });
});

describe('OpportunitiesService — validateLocation (accurate-pin gate)', () => {
    const service = makeService({});

    it('requires a non-empty location.pin for a non-Remote opportunity', () => {
        expect(() => service.validateLocation('On site', { city: 'Lahore', venue: 'Park', pin: '' })).toThrow(
            BadRequestException,
        );
        expect(() => service.validateLocation('On site', undefined)).toThrow(BadRequestException);
        expect(() => service.validateLocation('Hybrid', { city: 'Lahore' })).toThrow(BadRequestException);
    });

    it('allows a Remote opportunity with no pin at all', () => {
        expect(() => service.validateLocation('Remote', undefined)).not.toThrow();
        expect(() => service.validateLocation('Remote', { city: '' })).not.toThrow();
    });

    it('allows a non-Remote opportunity once a real pin is set', () => {
        expect(() =>
            service.validateLocation('On site', { city: 'Lahore', venue: 'Park', pin: '31.5204,74.3587' }),
        ).not.toThrow();
    });
});

describe('OpportunitiesService — saveStudentOpportunityDraft (first-save regression)', () => {
    it('always fills the required sdg column on a brand-new draft, even before the student has picked an SDG', async () => {
        const create = jest.fn((payload) => payload);
        const save = jest.fn((payload) => Promise.resolve({ id: 'new-draft-id', ...payload }));
        const service = makeService({ create, save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'student-1' }),
        };

        // Mirrors exactly what the wizard sends on an early "Save Draft" click: only a title, no
        // sdg_info yet — the wizard nests any SDG pick under sdg_info.sdg_id, never a bare `sdg`
        // field, but the Opportunity entity's `sdg` column is NOT NULL with no default.
        await service.saveStudentOpportunityDraft('student-1', null, {
            draft: true,
            title: 'Untitled draft',
        });

        expect(create).toHaveBeenCalledWith(expect.objectContaining({ sdg: expect.any(String) }));
        expect(create.mock.calls[0][0].sdg).toBeTruthy();
    });

    it('uses the picked SDG once sdg_info is present', async () => {
        const create = jest.fn((payload) => payload);
        const save = jest.fn((payload) => Promise.resolve({ id: 'new-draft-id', ...payload }));
        const service = makeService({ create, save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'student-1' }),
        };

        await service.saveStudentOpportunityDraft('student-1', null, {
            draft: true,
            title: 'Digital Skills for Young Learners',
            sdg_info: { sdg_id: '4', target_id: '4.1', indicator_id: '', why_relevant: '' },
        });

        expect(create.mock.calls[0][0].sdg).toBe('4');
    });
});

describe('OpportunitiesService — create() CIEL PK review requirement is server-computed, not client-trusted', () => {
    function minimalOrgCreatorDto(overrides: Record<string, unknown> = {}) {
        return {
            title: 'Beach cleanup drive',
            mode: 'Remote', // sidesteps the location.pin requirement — not the concern of this test
            timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
            safety_declaration: {
                environment_safe_and_appropriate: true,
                students_guided_and_supervised: true,
                lawful_ethical_and_non_hazardous: true,
                precautions_and_basic_safety: true,
            },
            submission_confirmations: {
                academically_valid_and_accurately_described: true,
                activity_properly_supervised: true,
                environment_safe_and_appropriate: true,
                information_correct_and_verifiable: true,
            },
            sdg_info: { sdg_id: '14' },
            ...overrides,
        } as any;
    }

    function makeOrgCreatorService() {
        const create = jest.fn((payload) => payload);
        const save = jest.fn((payload) => Promise.resolve({ id: 'new-opp-id', ...payload }));
        const { stubs, lockQuery, dedupeGetOne, dedupeQb } = createDedupeStubs();
        const service = makeService({ create, save, findOne: jest.fn(), ...stubs });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'ngo-user-1', role: 'ngo', email: 'contact@ngo.org' }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }),
        };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = { sendAdminOpportunityReviewNeeded: jest.fn() };
        return { service, save, lockQuery, dedupeGetOne, dedupeQb };
    }

    it.each(['student', 'investor'])('rejects %s accounts on the generic create endpoint (403)', async (role) => {
        const { service, save } = makeOrgCreatorService();
        (service as any).usersRepository.findOne = jest
            .fn()
            .mockResolvedValue({ id: 'u-1', role, email: 'u@x.org' });
        await expect(service.create('u-1', minimalOrgCreatorDto())).rejects.toThrow(/not allowed/i);
        expect(save).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only title and persists nothing', async () => {
        const { service, save } = makeOrgCreatorService();
        await expect(service.create('ngo-user-1', minimalOrgCreatorDto({ title: '   ' }))).rejects.toThrow(/title/i);
        expect(save).not.toHaveBeenCalled();
    });

    it('rejects a malformed executing/partner organization email', async () => {
        const { service, save } = makeOrgCreatorService();
        await expect(
            service.create('ngo-user-1', minimalOrgCreatorDto({ executing_organization: { official_email: 'not-an-email' } })),
        ).rejects.toThrow(/official_email/);
        await expect(
            service.create('ngo-user-1', minimalOrgCreatorDto({ partner_organization: { official_email: 'a@b' } })),
        ).rejects.toThrow(/official_email/);
        expect(save).not.toHaveBeenCalled();
    });

    it('rejects a malformed supervision WhatsApp number', async () => {
        const { service } = makeOrgCreatorService();
        await expect(
            service.create('ngo-user-1', minimalOrgCreatorDto({ supervision: { whatsapp_e164: '0300-1234567' } })),
        ).rejects.toThrow(/whatsapp/i);
    });

    it('routes to pending_approval even when the client omits admin_approval_required', async () => {
        const { service, save } = makeOrgCreatorService();

        const saved: any = await service.create('ngo-user-1', minimalOrgCreatorDto());

        expect(saved.status).toBe('pending_approval');
        expect(save).toHaveBeenCalled();
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).toHaveBeenCalledWith(
            'Beach cleanup drive',
            'new-opp-id',
            'new submission',
            expect.any(String),
        );
    });

    it('routes to pending_approval even when the client explicitly sends admin_approval_required: false', async () => {
        const { service } = makeOrgCreatorService();

        const saved: any = await service.create(
            'ngo-user-1',
            minimalOrgCreatorDto({ admin_approval_required: false }),
        );

        // Before the fix this fell through to `pending_execution` — a status with no further
        // stage, so the row could never be approved (`approve()` explicitly refuses it) and
        // never reached CIEL PK either. It must never depend on a client-supplied flag.
        expect(saved.status).toBe('pending_approval');
    });

    it('gates on a linked faculty (NGO/Partner Org "Academic / faculty link" section) before CIEL PK ever sees it', async () => {
        const { service, save } = makeOrgCreatorService();
        (service as any).mailService.sendFacultyStudentOpportunityVerification = jest.fn();

        const saved: any = await service.create(
            'ngo-user-1',
            minimalOrgCreatorDto({
                visibility_and_academic_linkage: {
                    faculty_institutional_representative: {
                        name: 'Dr. Hina Malik',
                        official_email: 'hina.malik@bnu.edu.pk',
                    },
                },
            }),
        );

        expect(saved.status).toBe('pending_faculty');
        expect(saved.facultyApprovalStatus).toBe('pending');
        expect(saved.faculty_verification_token).toBeTruthy();
        expect(save).toHaveBeenCalled();
        expect((service as any).mailService.sendFacultyStudentOpportunityVerification).toHaveBeenCalled();
    });

    it('marks the faculty line not_applicable (never blocks CIEL PK) when no faculty is linked', async () => {
        const { service } = makeOrgCreatorService();

        const saved: any = await service.create('ngo-user-1', minimalOrgCreatorDto());

        expect(saved.facultyApprovalStatus).toBe('not_applicable');
        expect(saved.status).toBe('pending_approval');
        expect(saved.workflowStage).toBe('pending_admin');
        expect(saved.admin_approved).toBe(false);
        expect(saved.adminApprovalStatus).toBe('pending');
    });

    it('ignores a crafted admin_approved:true from the client payload', async () => {
        const { service } = makeOrgCreatorService();

        const saved: any = await service.create(
            'ngo-user-1',
            minimalOrgCreatorDto({ admin_approved: true, status: 'active' }),
        );

        expect(saved.admin_approved).toBe(false);
        expect(saved.status).toBe('pending_approval');
        expect(saved.workflowStage).toBe('pending_admin');
    });

    it('routes partner-organization ack to pending_partner (not premature CIEL PK email)', async () => {
        const { service } = makeOrgCreatorService();
        (service as any).mailService.sendPartnerVerification = jest.fn();

        const saved: any = await service.create(
            'ngo-user-1',
            minimalOrgCreatorDto({
                partner_organization: {
                    name: 'City Parks Trust',
                    official_email: 'parks@city.org',
                },
            }),
        );

        // When a distinct partner org must ack, CIEL PK must wait — do not email admin yet.
        expect(saved.requiresPartnerApproval).toBe(true);
        expect(saved.partnerToken).toBeTruthy();
        expect(saved.status).toBe('pending_partner');
        expect(saved.workflowStage).toBe('pending_partner');
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
    });

    it('keeps faculty link gate when executing-org portal confirm is also required', async () => {
        const { service } = makeOrgCreatorService();
        (service as any).mailService.sendFacultyStudentOpportunityVerification = jest.fn();
        (service as any).mailService.sendExecutingOrganizationVerificationEmail = jest.fn();

        const saved: any = await service.create(
            'ngo-user-1',
            minimalOrgCreatorDto({
                partner_organization: {
                    organization_name: 'City Parks Trust',
                    official_email: 'parks@city.org',
                },
                executing_organization: {
                    official_email: 'host@exec.org',
                    name: 'Exec Host',
                },
                visibility_and_academic_linkage: {
                    faculty_institutional_representative: {
                        name: 'Dr. Hina Malik',
                        official_email: 'hina.malik@bnu.edu.pk',
                    },
                },
            }),
        );

        expect(saved.status).toBe('pending_execution');
        expect(saved.execution_verification_token).toBeTruthy();
        expect(saved.execution_verified).toBe(false);
        expect(saved.faculty_verification_token).toBeTruthy();
        expect(saved.facultyApprovalStatus).toBe('pending');
        expect(saved.admin_approved).toBe(false);
        expect(saved.adminApprovalStatus).toBe('pending');
        // Faculty email waits until executing-org confirms (verifyExecutingOrganizationForUser).
        expect((service as any).mailService.sendFacultyStudentOpportunityVerification).not.toHaveBeenCalled();
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
    });
});

describe('OpportunitiesService — Super Admin create skips a second CIEL gate unless a stakeholder is named', () => {
    function makeCielAdminService() {
        const create = jest.fn((payload) => payload);
        const save = jest.fn((payload) => Promise.resolve({ id: 'ciel-opp-id', ...payload }));
        const service = makeService({ create, save, findOne: jest.fn(), ...createDedupeStubs().stubs });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'admin-1',
                role: 'admin',
                email: 'admin@ciel.pk',
            }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue(null),
        };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendAdminOpportunityReviewNeeded: jest.fn(),
            sendFacultyStudentOpportunityVerification: jest.fn(),
            sendPartnerVerification: jest.fn(),
            sendPartnerOpportunityNotice: jest.fn(),
        };
        return { service, save };
    }

    function minimalAdminDto(overrides: Record<string, unknown> = {}) {
        return {
            title: 'National tree plantation',
            mode: 'Remote',
            timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
            safety_declaration: {
                environment_safe_and_appropriate: true,
                students_guided_and_supervised: true,
                lawful_ethical_and_non_hazardous: true,
                precautions_and_basic_safety: true,
            },
            submission_confirmations: {
                academically_valid_and_accurately_described: true,
                activity_properly_supervised: true,
                environment_safe_and_appropriate: true,
                information_correct_and_verifiable: true,
            },
            sdg_info: { sdg_id: '15' },
            ...overrides,
        } as any;
    }

    it('publishes immediately when CIEL Admin names neither a partner nor a faculty stakeholder', async () => {
        const { service } = makeCielAdminService();
        const saved: any = await service.create('admin-1', minimalAdminDto());
        expect(saved.status).toBe('active');
        expect(saved.adminApprovalStatus).toBe('approved');
        expect(saved.admin_approved).toBe(true);
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
    });

    it('does not treat the Super Admin creator email as a faculty stakeholder', async () => {
        const { service } = makeCielAdminService();
        const saved: any = await service.create(
            'admin-1',
            minimalAdminDto({
                supervision: { contact: 'admin@ciel.pk', supervisor_name: 'CIEL PK Admin' },
            }),
        );
        expect(saved.status).toBe('active');
        expect(saved.facultyApprovalStatus).toBe('not_applicable');
        expect(saved.faculty_verification_token).toBeFalsy();
    });

    it('waits on a named faculty (not CIEL) without a second admin queue', async () => {
        const { service } = makeCielAdminService();
        const saved: any = await service.create(
            'admin-1',
            minimalAdminDto({
                supervision: { contact: 'hina.malik@bnu.edu.pk', supervisor_name: 'Dr. Hina Malik' },
            }),
        );
        expect(saved.status).toBe('pending_faculty');
        expect(saved.facultyApprovalStatus).toBe('pending');
        expect(saved.adminApprovalStatus).toBe('approved');
        expect(saved.admin_approved).toBe(false);
        expect(saved.faculty_verification_token).toBeTruthy();
        expect((service as any).mailService.sendFacultyStudentOpportunityVerification).toHaveBeenCalled();
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
    });

    it('waits on a named partner from the faculty-form collaboration payload without a second admin queue', async () => {
        const { service } = makeCielAdminService();
        const saved: any = await service.create(
            'admin-1',
            minimalAdminDto({
                external_partner_collaboration: {
                    organization_name: 'Abroo',
                    contact_person: 'Host',
                    official_email: 'host@abroo.org',
                },
                supervision: {
                    contact: 'admin@ciel.pk',
                    supervisor_name: 'CIEL PK Admin',
                    external_partner_email: 'host@abroo.org',
                },
            }),
        );
        expect(saved.status).toBe('pending_partner');
        expect(saved.partnerApprovalStatus).toBe('pending');
        expect(saved.adminApprovalStatus).toBe('approved');
        expect(saved.admin_approved).toBe(false);
        expect(saved.partnerToken).toBeTruthy();
        expect((service as any).mailService.sendPartnerVerification).toHaveBeenCalled();
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
    });

    it('does not email the partner until faculty has approved when both stakeholders are named', async () => {
        const { service } = makeCielAdminService();
        const saved: any = await service.create(
            'admin-1',
            minimalAdminDto({
                external_partner_collaboration: {
                    organization_name: 'Abroo',
                    contact_person: 'Host',
                    official_email: 'host@abroo.org',
                },
                supervision: {
                    contact: 'hina.malik@bnu.edu.pk',
                    supervisor_name: 'Dr. Hina Malik',
                    external_partner_email: 'host@abroo.org',
                },
            }),
        );
        expect(saved.status).toBe('pending_faculty');
        expect(saved.partnerToken).toBeTruthy();
        expect((service as any).mailService.sendFacultyStudentOpportunityVerification).toHaveBeenCalled();
        expect((service as any).mailService.sendPartnerVerification).not.toHaveBeenCalled();
    });
});

describe('OpportunitiesService — afterFacultyVerified now also completes an NGO/Partner-linked faculty gate', () => {
    it('approving via the faculty token link moves a non-student, non-faculty-created opportunity on to pending_approval (no partner required)', () => {
        const workflow = new OpportunityWorkflowService();
        const opp = {
            isStudentCreated: false,
            status: 'pending_faculty',
            workflowStage: null,
            facultyApprovalStatus: 'pending',
            requiresPartnerApproval: false,
            partnerApprovalStatus: 'not_applicable',
        } as unknown as Opportunity;

        workflow.afterFacultyVerified(opp);

        expect(opp.facultyApprovalStatus).toBe('approved');
        expect(opp.faculty_verified).toBe(true);
        expect(opp.status).toBe('pending_approval');
        expect(opp.workflowStage).toBe('pending_admin');
    });

    it('routes to pending_partner instead when a partner/co-host is also required', () => {
        const workflow = new OpportunityWorkflowService();
        const opp = {
            isStudentCreated: false,
            status: 'pending_faculty',
            workflowStage: null,
            facultyApprovalStatus: 'pending',
            requiresPartnerApproval: true,
            partnerApprovalStatus: 'pending',
        } as unknown as Opportunity;

        workflow.afterFacultyVerified(opp);

        expect(opp.facultyApprovalStatus).toBe('approved');
        expect(opp.status).toBe('pending_partner');
        expect(opp.workflowStage).toBe('pending_partner');
    });
});

describe('OpportunitiesService — faculty approve then emails partner', () => {
    it('sends the partner verify link only after faculty magic-link approval', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Community garden',
            isStudentCreated: true,
            creatorId: 'student-1',
            facultyId: 'faculty-1',
            faculty_verification_token: 'ftok',
            faculty_verified: false,
            facultyApprovalStatus: 'pending',
            faculty_verification_status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            status: 'pending_faculty',
            requiresPartnerApproval: true,
            partnerToken: 'ptok',
            partnerVerified: false,
            partnerApprovalStatus: 'pending',
            partner_organization: { official_email: 'host@ngo.org' },
            admin_approved: false,
            adminApprovalStatus: 'pending',
        } as unknown as Opportunity;
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save,
        });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendPartnerVerification: jest.fn().mockResolvedValue(undefined),
            sendStudentOpportunityStatusUpdate: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                email: 'ali@uni.edu',
                name: 'Ali',
            }),
        };
        (service as any).notificationsService = {
            createApprovalNotification: jest.fn().mockResolvedValue(undefined),
        };

        await service.verifyFaculty('ftok');

        expect(opp.status).toBe('pending_partner');
        expect((service as any).mailService.sendPartnerVerification).toHaveBeenCalledWith(
            'host@ngo.org',
            'Community garden',
            'ptok',
            expect.anything(),
            expect.objectContaining({ path: '/verify/partner' }),
        );
    });

    it('faculty dashboard approve also emails the partner (same loop as the magic link)', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Community garden',
            isStudentCreated: true,
            creatorId: 'student-1',
            facultyId: 'faculty-1',
            faculty_verified: false,
            facultyApprovalStatus: 'pending',
            faculty_verification_status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            status: 'pending_faculty',
            requiresPartnerApproval: true,
            partnerToken: 'ptok',
            partnerVerified: false,
            partnerApprovalStatus: 'pending',
            partner_organization: { official_email: 'host@ngo.org' },
            admin_approved: false,
            adminApprovalStatus: 'pending',
            supervision: { contact: 'teacher@uni.edu' },
        } as unknown as Opportunity;
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save,
        });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendPartnerVerification: jest.fn().mockResolvedValue(undefined),
            sendStudentOpportunityStatusUpdate: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                email: 'ali@uni.edu',
                name: 'Ali',
            }),
        };
        (service as any).notificationsService = {
            createApprovalNotification: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).opportunityApplicationsService = {
            findActionablePendingFacultyApplicationForDashboard: jest
                .fn()
                .mockResolvedValue(null),
        };

        await service.facultyDashboardApprove(
            'opp-1',
            'faculty-1',
            'teacher@uni.edu',
            'Dr Khan',
        );

        expect(opp.status).toBe('pending_partner');
        expect((service as any).mailService.sendPartnerVerification).toHaveBeenCalled();
    });

    it('mints a partner token if faculty approved but the token was missing', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Community garden',
            isStudentCreated: true,
            creatorId: 'student-1',
            facultyId: 'faculty-1',
            faculty_verification_token: 'ftok',
            faculty_verified: false,
            facultyApprovalStatus: 'pending',
            faculty_verification_status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            status: 'pending_faculty',
            requiresPartnerApproval: true,
            partnerToken: undefined,
            partnerVerified: false,
            partnerApprovalStatus: 'pending',
            partner_organization: { official_email: 'host@ngo.org' },
            admin_approved: false,
            adminApprovalStatus: 'pending',
        } as unknown as Opportunity;
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save,
        });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendPartnerVerification: jest.fn().mockResolvedValue(undefined),
            sendStudentOpportunityStatusUpdate: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                email: 'ali@uni.edu',
                name: 'Ali',
            }),
        };
        (service as any).notificationsService = {
            createApprovalNotification: jest.fn().mockResolvedValue(undefined),
        };

        await service.verifyFaculty('ftok');

        expect(opp.partnerToken).toBeTruthy();
        expect((service as any).mailService.sendPartnerVerification).toHaveBeenCalledWith(
            'host@ngo.org',
            'Community garden',
            opp.partnerToken,
            expect.anything(),
            expect.anything(),
        );
    });

    it('after partner magic-link approve, emails CIEL PK for final review', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Community garden',
            isStudentCreated: true,
            faculty_verified: true,
            facultyApprovalStatus: 'approved',
            partnerToken: 'ptok',
            partnerVerified: false,
            requiresPartnerApproval: true,
            partnerApprovalStatus: 'pending',
            workflowStage: 'pending_partner',
            status: 'pending_partner',
            partner_organization: { official_email: 'host@ngo.org' },
            creatorId: 'student-1',
            facultyId: 'faculty-1',
            admin_approved: false,
            adminApprovalStatus: 'pending',
            execution_verification_token: null,
            execution_verified: true,
        } as unknown as Opportunity;
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save,
        });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendAdminOpportunityReviewNeeded: jest.fn().mockResolvedValue(undefined),
            sendStudentOpportunityStatusUpdate: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                email: 'ali@uni.edu',
                name: 'Ali',
            }),
        };
        (service as any).notificationsService = {
            createApprovalNotification: jest.fn().mockResolvedValue(undefined),
        };

        await (service as any).verifyOpportunityToken('ptok');

        expect(opp.status).toBe('pending_approval');
        expect(
            (service as any).mailService.sendAdminOpportunityReviewNeeded,
        ).toHaveBeenCalledWith('Community garden', 'opp-1', 'partner approval', expect.any(String));
    });

    it('remind-reviewer after faculty approval resends the partner link without changing stage', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Community garden',
            creatorId: 'student-1',
            requiresPartnerApproval: true,
            partnerVerified: false,
            partnerApprovalStatus: 'pending',
            workflowStage: 'pending_partner',
            status: 'pending_partner',
            partnerToken: 'ptok',
            partner_organization: { official_email: 'host@ngo.org' },
            faculty_verified: true,
            facultyApprovalStatus: 'approved',
        } as unknown as Opportunity;
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save,
        });
        (service as any).mailService = {
            sendPartnerVerification: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                email: 'ali@uni.edu',
                role: 'student',
            }),
        };

        const result = await service.remindOpportunityReviewer('student-1', 'opp-1');

        expect(result.sent_to).toBe('partner');
        expect(opp.status).toBe('pending_partner');
        expect((service as any).mailService.sendPartnerVerification).toHaveBeenCalled();
    });
});

describe('OpportunitiesService — Faculty / Partner / CIEL notify loop', () => {
    function mailReadyService(opp: Opportunity) {
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save,
        });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendPartnerVerification: jest.fn().mockResolvedValue(undefined),
            sendAdminOpportunityReviewNeeded: jest.fn().mockResolvedValue(undefined),
            sendStudentOpportunityStatusUpdate: jest.fn().mockResolvedValue(undefined),
            sendOpportunityLiveStartReportEmail: jest.fn().mockResolvedValue(undefined),
            sendAdminStudentMayStartReport: jest.fn().mockResolvedValue(undefined),
            sendFacultyStudentOpportunityVerification: jest.fn().mockResolvedValue(undefined),
            sendStudentOpportunityRejectedByFaculty: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'student-1',
                email: 'ali@uni.edu',
                name: 'Ali',
                role: 'student',
            }),
        };
        (service as any).notificationsService = {
            createApprovalNotification: jest.fn().mockResolvedValue(undefined),
        };
        (service as any).opportunityApplicationsService = {
            findActionablePendingFacultyApplicationForDashboard: jest
                .fn()
                .mockResolvedValue(null),
        };
        return { service, save };
    }

    it('faculty approve with no partner emails CIEL PK next', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Campus garden',
            isStudentCreated: true,
            creatorId: 'student-1',
            facultyId: 'faculty-1',
            faculty_verification_token: 'ftok',
            faculty_verified: false,
            facultyApprovalStatus: 'pending',
            faculty_verification_status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            status: 'pending_faculty',
            requiresPartnerApproval: false,
            partnerVerified: true,
            partnerApprovalStatus: 'not_applicable',
            admin_approved: false,
            adminApprovalStatus: 'pending',
        } as unknown as Opportunity;
        const { service } = mailReadyService(opp);

        await service.verifyFaculty('ftok');

        expect(opp.status).toBe('pending_approval');
        expect(opp.workflowStage).toBe('pending_admin');
        expect((service as any).mailService.sendPartnerVerification).not.toHaveBeenCalled();
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).toHaveBeenCalledWith(
            'Campus garden',
            'opp-1',
            'faculty approval',
            expect.any(String),
        );
    });

    it('refuses CIEL final approve while still waiting on faculty or partner', async () => {
        const facultyHold = {
            id: 'opp-1',
            isStudentCreated: true,
            workflowStage: 'pending_faculty',
            status: 'pending_faculty',
            admin_approved: false,
        } as unknown as Opportunity;
        const { service: facultyService } = mailReadyService(facultyHold);
        await expect(facultyService.approve('opp-1')).rejects.toBeInstanceOf(
            BadRequestException,
        );

        const partnerHold = {
            id: 'opp-2',
            isStudentCreated: true,
            workflowStage: 'pending_partner',
            status: 'pending_partner',
            admin_approved: false,
        } as unknown as Opportunity;
        const { service: partnerService } = mailReadyService(partnerHold);
        await expect(partnerService.approve('opp-2')).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('CIEL approve goes live and emails the creator plus the admin start-report notice', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Campus garden',
            isStudentCreated: true,
            creatorId: 'student-1',
            workflowStage: 'pending_admin',
            status: 'pending_approval',
            admin_approved: false,
            adminApprovalStatus: 'pending',
            faculty_verified: true,
            facultyApprovalStatus: 'approved',
            requiresPartnerApproval: false,
            partnerVerified: true,
            partnerApprovalStatus: 'not_applicable',
            timeline: { expected_hours: 16 },
        } as unknown as Opportunity;
        const { service } = mailReadyService(opp);

        const saved = await service.approve('opp-1', {
            id: 'admin-1',
            name: 'CIEL PK',
        });

        expect(saved.status).toBe('active');
        expect(saved.workflowStage).toBe('live');
        expect(saved.admin_approved).toBe(true);
        expect(
            (service as any).mailService.sendOpportunityLiveStartReportEmail,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'ali@uni.edu',
                projectTitle: 'Campus garden',
            }),
        );
        expect(
            (service as any).mailService.sendAdminStudentMayStartReport,
        ).toHaveBeenCalledWith('Campus garden', 'opp-1', 'Ali');
    });

    it('remind-reviewer on the CIEL queue emails admin without changing stage', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Campus garden',
            creatorId: 'student-1',
            workflowStage: 'pending_admin',
            status: 'pending_approval',
            admin_approved: false,
            faculty_verified: true,
        } as unknown as Opportunity;
        const { service } = mailReadyService(opp);

        const result = await service.remindOpportunityReviewer('student-1', 'opp-1');

        expect(result.sent_to).toBe('admin');
        expect(opp.status).toBe('pending_approval');
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).toHaveBeenCalledWith(
            'Campus garden',
            'opp-1',
            'CIEL PK final approval',
            expect.any(String),
        );
    });

    it('partner dashboard approve emails CIEL PK for final review', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Campus garden',
            isStudentCreated: true,
            creatorId: 'student-1',
            facultyId: 'faculty-1',
            faculty_verified: true,
            facultyApprovalStatus: 'approved',
            requiresPartnerApproval: true,
            partnerVerified: false,
            partnerApprovalStatus: 'pending',
            workflowStage: 'pending_partner',
            status: 'pending_partner',
            partner_organization: { official_email: 'host@ngo.org' },
            admin_approved: false,
            adminApprovalStatus: 'pending',
            execution_verification_token: null,
            execution_verified: true,
        } as unknown as Opportunity;
        const { service } = mailReadyService(opp);
        (service as any).organizationsService = {
            findOne: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Host NGO' }),
            getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Host NGO' }),
        };
        (service as any).facultyUniversityScope = {
            normalizeOrgName: (name: string) => (name || '').trim().toLowerCase(),
        };

        await service.partnerDashboardApprove('opp-1', {
            email: 'host@ngo.org',
            organizationId: 'org-1',
            id: 'partner-1',
            name: 'Host NGO',
        });

        expect(opp.status).toBe('pending_approval');
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).toHaveBeenCalledWith(
            'Campus garden',
            'opp-1',
            'partner approval',
            expect.any(String),
        );
    });

    it('faculty reject emails the student and closes the listing', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Campus garden',
            isStudentCreated: true,
            creatorId: 'student-1',
            facultyId: 'faculty-1',
            faculty_verified: false,
            facultyApprovalStatus: 'pending',
            faculty_verification_status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            status: 'pending_faculty',
            admin_approved: false,
            supervision: { contact: 'teacher@uni.edu' },
        } as unknown as Opportunity;
        const { service } = mailReadyService(opp);

        await service.facultyDashboardReject(
            'opp-1',
            'faculty-1',
            'teacher@uni.edu',
            'Unsafe site',
            'Dr Khan',
        );

        expect(opp.status).toBe('rejected');
        expect(
            (service as any).mailService.sendStudentOpportunityRejectedByFaculty,
        ).toHaveBeenCalledWith('ali@uni.edu', 'Campus garden', 'Unsafe site');
    });

    it('executing-org confirm emails the partner when that is the next gate', async () => {
        const opp = {
            id: 'opp-1',
            title: 'Campus garden',
            isStudentCreated: false,
            creatorId: 'faculty-1',
            facultyId: 'faculty-1',
            faculty_verified: true,
            facultyApprovalStatus: 'approved',
            execution_verification_token: 'etok',
            execution_verified: false,
            executing_organization: { official_email: 'host@ngo.org' },
            requiresPartnerApproval: true,
            partnerVerified: false,
            partnerApprovalStatus: 'pending',
            partnerToken: 'ptok',
            partner_organization: { official_email: 'ack@ngo.org' },
            admin_approved: false,
            adminApprovalStatus: 'pending',
            status: 'pending_execution',
            workflowStage: null,
        } as unknown as Opportunity;
        const { service } = mailReadyService(opp);
        (service as any).usersRepository.findOne = jest.fn().mockResolvedValue({
            id: 'partner-user',
            email: 'host@ngo.org',
        });

        await service.verifyExecutingOrganizationForUser(
            'partner-user',
            'host@ngo.org',
            'opp-1',
        );

        expect(opp.status).toBe('pending_partner');
        expect((service as any).mailService.sendPartnerVerification).toHaveBeenCalled();
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
    });
});

describe('OpportunitiesService — update() faculty-owned opportunity resubmit scoping', () => {
    function makeFacultyOpp(overrides: Record<string, unknown> = {}) {
        return {
            id: 'fac-opp-1',
            creatorId: 'faculty-1',
            facultyId: 'faculty-1',
            isStudentCreated: false,
            organizationId: null,
            status: 'active',
            workflowStage: 'live',
            admin_approved: true,
            adminApprovalStatus: 'approved',
            requiresPartnerApproval: true,
            partnerApprovalStatus: 'approved',
            partnerVerified: true,
            partnerToken: 'existing-partner-token',
            partner_organization: { official_email: 'partner@org.com' },
            execution_verification_token: null,
            execution_verified: true,
            ...overrides,
        } as unknown as Opportunity;
    }

    function makeFacultyService(opp: Opportunity) {
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'faculty-1', role: 'faculty' }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue(null),
        };
        return service;
    }

    it('leaves a live, fully-approved opportunity untouched on a routine edit (no reset, stays published)', async () => {
        const opp = makeFacultyOpp();
        const service = makeFacultyService(opp);

        const saved = await service.update('faculty-1', {
            id: 'fac-opp-1',
            title: 'Fixed a typo in the title',
        } as any);

        expect((saved as any).status).toBe('active');
        expect((saved as any).workflowStage).toBe('live');
        expect((saved as any).admin_approved).toBe(true);
        expect((saved as any).partnerApprovalStatus).toBe('approved');
        expect((saved as any).adminApprovalStatus).toBe('approved');
    });

    it('after CIEL PK requests revision mid-chain, resubmitting only rewinds the admin line — the already-approved partner line is untouched', async () => {
        const opp = makeFacultyOpp({
            status: 'revision',
            workflowStage: 'revision',
            admin_approved: false,
            adminApprovalStatus: 'revision_requested',
            // Partner already approved before CIEL PK's own (revision-requesting) review.
            partnerApprovalStatus: 'approved',
            partnerVerified: true,
        });
        const service = makeFacultyService(opp);

        const saved = await service.update('faculty-1', {
            id: 'fac-opp-1',
            title: 'Addressed CIEL PK feedback',
        } as any);

        expect((saved as any).partnerApprovalStatus).toBe('approved');
        expect((saved as any).partnerVerified).toBe(true);
        expect((saved as any).adminApprovalStatus).toBe('pending');
        expect((saved as any).status).toBe('pending_approval');
        expect((saved as any).workflowStage).toBe('pending_admin');
    });

    it('(scoped-reset branch) if the partner line is flagged after the opportunity had already gone live, resubmitting rewinds both the partner and admin lines back to pending', async () => {
        // Deliberately atypical combination (partner rejected while workflowStage is still 'live')
        // to isolate and exercise `partnerLineFlagged` inside the scoped-reset branch specifically —
        // see the next test for the realistic "rejected before admin ever decided" full-reset case.
        const opp = makeFacultyOpp({
            status: 'active', // stale mirror from before the rejection was recorded
            workflowStage: 'live',
            admin_approved: true,
            adminApprovalStatus: 'approved',
            partnerApprovalStatus: 'rejected',
            partnerVerified: false,
        });
        const service = makeFacultyService(opp);

        const saved = await service.update('faculty-1', {
            id: 'fac-opp-1',
            title: 'Addressed partner feedback',
        } as any);

        expect((saved as any).partnerApprovalStatus).toBe('pending');
        expect((saved as any).partnerVerified).toBe(false);
        expect((saved as any).adminApprovalStatus).toBe('pending');
        expect((saved as any).status).toBe('pending_partner');
        expect((saved as any).workflowStage).toBe('pending_partner');
    });

    it('(full-reset branch) partner rejected before admin ever reviewed — resubmitting recomputes the pipeline and lands back in pending_partner', async () => {
        const opp = makeFacultyOpp({
            status: 'rejected',
            workflowStage: 'rejected',
            admin_approved: false,
            adminApprovalStatus: 'pending', // admin never got a chance to decide
            partnerApprovalStatus: 'rejected',
            partnerVerified: false,
        });
        const service = makeFacultyService(opp);
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        const saved = await service.update('faculty-1', {
            id: 'fac-opp-1',
            title: 'Addressed partner feedback',
        } as any);

        expect((saved as any).partnerApprovalStatus).toBe('pending');
        expect((saved as any).partnerVerified).toBe(false);
        expect((saved as any).adminApprovalStatus).toBe('pending');
        expect((saved as any).status).toBe('pending_partner');
        expect((saved as any).workflowStage).toBe('pending_partner');
    });

    it('resubmit into pending_partner issues a fresh partner token and re-emails the partner; a mail failure does not fail the save', async () => {
        const opp = makeFacultyOpp({
            status: 'revision',
            workflowStage: 'revision',
            admin_approved: false,
            adminApprovalStatus: 'pending',
            partnerApprovalStatus: 'revision_requested',
            partnerVerified: false,
        });
        const service = makeFacultyService(opp);
        const sendPartnerVerification = jest.fn().mockRejectedValue(new Error('smtp down'));
        (service as any).mailService = { sendPartnerVerification };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        const saved = await service.update('faculty-1', { id: 'fac-opp-1', title: 'Addressed partner feedback' } as any);

        expect((saved as any).status).toBe('pending_partner');
        expect((saved as any).partnerToken).toBeTruthy();
        expect((saved as any).partnerToken).not.toBe('existing-partner-token');
        expect(sendPartnerVerification).toHaveBeenCalledTimes(1);
        expect(sendPartnerVerification.mock.calls[0][0]).toBe('partner@org.com');
        expect(sendPartnerVerification.mock.calls[0][2]).toBe((saved as any).partnerToken);
    });
});

describe('OpportunitiesService — update() partner token rotation (scoped-reset branch)', () => {
    it('a live row whose partner line was flagged gets a fresh token and a new partner email on resubmit', async () => {
        const opp = {
            id: 'fac-opp-9',
            title: 'T',
            creatorId: 'faculty-1',
            facultyId: 'faculty-1',
            isStudentCreated: false,
            status: 'active',
            workflowStage: 'live',
            admin_approved: true,
            adminApprovalStatus: 'approved',
            facultyApprovalStatus: 'approved',
            faculty_verified: true,
            requiresPartnerApproval: true,
            partnerApprovalStatus: 'rejected',
            partnerVerified: false,
            partnerToken: 'old-token',
            partner_organization: { official_email: 'partner@org.com' },
            execution_verification_token: null,
            execution_verified: true,
        } as unknown as Opportunity;
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save: jest.fn(async (row: Opportunity) => row),
        });
        (service as any).usersRepository = { findOne: jest.fn().mockResolvedValue({ id: 'faculty-1', role: 'faculty' }) };
        (service as any).organizationsService = { getMyOrganization: jest.fn().mockResolvedValue(null) };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        const sendPartnerVerification = jest.fn().mockResolvedValue(true);
        (service as any).mailService = { sendPartnerVerification };

        const saved: any = await service.update('faculty-1', { id: 'fac-opp-9', title: 'T2' } as any);

        expect(saved.status).toBe('pending_partner');
        expect(saved.partnerToken).not.toBe('old-token');
        expect(sendPartnerVerification).toHaveBeenCalledTimes(1);
        expect(sendPartnerVerification.mock.calls[0][2]).toBe(saved.partnerToken);
    });
});

describe('OpportunitiesService — revise() now supports non-student-created opportunities before first admin approval', () => {
    it('no longer throws for a faculty-created opportunity awaiting its first CIEL PK decision', async () => {
        const opp = {
            id: 'fac-opp-2',
            isStudentCreated: false,
            admin_approved: false, // never approved yet — this used to be rejected outright
            status: 'pending_approval',
            workflowStage: 'pending_admin',
            adminApprovalStatus: 'pending',
        } as unknown as Opportunity;
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        const saved = await service.revise(
            'fac-opp-2',
            'Please add a specific location.',
            { id: 'admin-1', name: 'Ayesha (CIEL PK)' },
        );

        expect((saved as any).status).toBe('revision');
        expect((saved as any).adminApprovalStatus).toBe('revision_requested');
        expect((saved as any).rejectionReason).toBe('Please add a specific location.');
    });
});

describe('OpportunitiesService — approval actions record actor + timestamp + version (audit trail)', () => {
    it('approve() refuses pending_execution even when admin_approval_required is true', async () => {
        const opp = {
            id: 'opp-exec-1',
            isStudentCreated: false,
            status: 'pending_execution',
            workflowStage: null,
            admin_approval_required: true,
            admin_approved: false,
            adminApprovalStatus: 'pending',
            facultyApprovalStatus: 'not_applicable',
            execution_verification_token: 'etok',
            execution_verified: false,
            requiresPartnerApproval: false,
        } as unknown as Opportunity;
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save: jest.fn(async (row: Opportunity) => row),
        });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        await expect(service.approve('opp-exec-1')).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(opp.admin_approved).toBe(false);
        expect(opp.status).toBe('pending_execution');
    });

    it('approve() appends an actor-stamped, versioned entry to approvalHistory', async () => {
        const opp = {
            id: 'opp-audit-1',
            isStudentCreated: true,
            workflowStage: 'pending_admin',
            status: 'pending_approval',
            version: 3,
            approvalHistory: [],
        } as unknown as Opportunity;
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = { sendAdminOpportunityReviewNeeded: jest.fn() };

        const before = Date.now();
        const saved = await service.approve('opp-audit-1', { id: 'admin-1', name: 'Ayesha (CIEL PK)' });
        const after = Date.now();

        const history = (saved as any).approvalHistory;
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
            line: 'admin',
            action: 'approved',
            actorId: 'admin-1',
            actorName: 'Ayesha (CIEL PK)',
            version: 3,
        });
        const stampedAt = new Date(history[0].at).getTime();
        expect(stampedAt).toBeGreaterThanOrEqual(before);
        expect(stampedAt).toBeLessThanOrEqual(after);
    });

    it('reject() and revise() also stamp their own line, action and actor — never mutating earlier entries', async () => {
        const opp = {
            id: 'opp-audit-2',
            isStudentCreated: false,
            admin_approved: false,
            status: 'pending_approval',
            workflowStage: 'pending_admin',
            adminApprovalStatus: 'pending',
            version: 1,
            approvalHistory: [
                { line: 'faculty', action: 'approved', actorId: 'fac-1', actorName: 'Dr. Hina Malik', at: '2026-01-01T00:00:00.000Z', version: 1 },
            ],
        } as unknown as Opportunity;
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        const saved = await service.revise('opp-audit-2', 'Please clarify the timeline', {
            id: 'admin-1',
            name: 'Ayesha (CIEL PK)',
        });

        const history = (saved as any).approvalHistory;
        expect(history).toHaveLength(2);
        // The pre-existing faculty entry must survive untouched.
        expect(history[0]).toMatchObject({ line: 'faculty', action: 'approved', actorId: 'fac-1' });
        expect(history[1]).toMatchObject({
            line: 'admin',
            action: 'revision_requested',
            actorId: 'admin-1',
            actorName: 'Ayesha (CIEL PK)',
            reason: 'Please clarify the timeline',
        });
    });
});


describe('OpportunitiesService — update() strips server-controlled fields (mass-assignment guard)', () => {
    const forged = {
        status: 'active',
        admin_approved: true,
        workflowStage: 'live',
        adminApprovalStatus: 'approved',
        facultyApprovalStatus: 'approved',
        partnerApprovalStatus: 'approved',
        partnerVerified: true,
        execution_verified: true,
        creatorId: 'attacker',
        organizationId: 'other-org',
        isStudentCreated: true,
        rejectionReason: 'x',
        version: 99,
        approvalHistory: [{ forged: true }],
        partnerToken: 'known-token',
        faculty_verification_token: 'known-token',
    };

    function makeOrgService() {
        const opp = {
            id: 'org-opp-1',
            creatorId: 'ngo-1',
            organizationId: 'org-1',
            isStudentCreated: false,
            status: 'pending_approval',
            workflowStage: 'pending_admin',
            admin_approved: false,
            adminApprovalStatus: 'pending',
            version: 1,
            approvalHistory: [],
            title: 'Old title',
        } as unknown as Opportunity;
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'ngo-1', role: 'ngo' }),
        };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        return { service, opp, save };
    }

    it('keeps legitimate edits but ignores forged approval/ownership fields', async () => {
        const { service, opp } = makeOrgService();
        await service.update('ngo-1', { id: 'org-opp-1', title: 'New title', ...forged } as any, 'org-1');
        expect(opp.title).toBe('New title');
        expect(opp.status).toBe('pending_approval');
        expect(opp.admin_approved).toBe(false);
        expect(opp.workflowStage).toBe('pending_admin');
        expect(opp.adminApprovalStatus).toBe('pending');
        expect(opp.creatorId).toBe('ngo-1');
        expect(opp.organizationId).toBe('org-1');
        expect(opp.isStudentCreated).toBe(false);
        expect(opp.version).toBe(1);
        expect(opp.approvalHistory).toEqual([]);
        expect((opp as any).partnerToken).toBeUndefined();
    });

    it('rejects a user from another organization with 403', async () => {
        const { service } = makeOrgService();
        await expect(
            service.update('ngo-1', { id: 'org-opp-1', title: 'Hijack' } as any, 'someone-elses-org'),
        ).rejects.toThrow(/access/i);
    });
});

describe('OpportunitiesService — public token hardening', () => {
    const past = new Date(Date.now() - 60_000);
    const build = (opp: Partial<Opportunity> | null) => {
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (o: Opportunity) => o);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        return { service, findOne, save };
    };

    it.each([undefined, null, '', '   ', 'a'.repeat(200), 'tok en', "x' OR 1=1", ['a'] as any, { a: 1 } as any])(
        'malformed token %p gets the generic 404 without querying the DB',
        async (bad) => {
            const { service, findOne } = build(null);
            await expect(service.verifyFaculty(bad as any)).rejects.toThrow(NotFoundException);
            await expect(service.verifyOpportunityToken(bad as any)).rejects.toThrow(NotFoundException);
            await expect(service.getPublicPartnerVerificationPreview(bad as any)).rejects.toThrow(NotFoundException);
            await expect(service.getPublicFacultyVerificationPreview(bad as any)).rejects.toThrow(NotFoundException);
            await expect(service.decideOpportunityViaPartnerToken(bad as any, 'reject')).rejects.toThrow(NotFoundException);
            await expect(service.decideOpportunityViaFacultyToken(bad as any, 'reject')).rejects.toThrow(NotFoundException);
            expect(findOne).not.toHaveBeenCalled();
        },
    );

    it('expired partner token is rejected on preview, decision and verify with the same 404', async () => {
        const opp = { id: 'o', partnerToken: 'ptok', partnerVerified: false, partnerTokenExpiresAt: past, status: 'pending_partner' } as any;
        const { service, save } = build(opp);
        await expect(service.getPublicPartnerVerificationPreview('ptok')).rejects.toThrow(NotFoundException);
        await expect(service.decideOpportunityViaPartnerToken('ptok', 'reject')).rejects.toThrow(NotFoundException);
        await expect(service.verifyOpportunityToken('ptok')).rejects.toThrow(NotFoundException);
        expect(save).not.toHaveBeenCalled();
    });

    it('expired faculty token is rejected everywhere and does not mutate', async () => {
        const opp = { id: 'o', faculty_verification_token: 'ftok', facultyTokenExpiresAt: past, creatorId: 'c', status: 'pending_faculty', workflowStage: 'pending_faculty' } as any;
        const { service, save } = build(opp);
        await expect(service.getPublicFacultyVerificationPreview('ftok')).rejects.toThrow(NotFoundException);
        await expect(service.decideOpportunityViaFacultyToken('ftok', 'reject')).rejects.toThrow(NotFoundException);
        await expect(service.verifyFaculty('ftok')).rejects.toThrow(NotFoundException);
        expect(save).not.toHaveBeenCalled();
    });

    it('rejects over-long or non-string decision reasons without state change', async () => {
        const opp = { id: 'o', partnerToken: 'ptok', faculty_verification_token: 'ftok', partnerVerified: false, isStudentCreated: true, creatorId: 'c', status: 'pending_partner', workflowStage: 'pending_partner', approvalHistory: [] } as any;
        const { service, save } = build(opp);
        await expect(service.decideOpportunityViaPartnerToken('ptok', 'reject', 'x'.repeat(2001))).rejects.toThrow(BadRequestException);
        await expect(service.decideOpportunityViaFacultyToken('ftok', 'reject', 123 as any)).rejects.toThrow(BadRequestException);
        expect(save).not.toHaveBeenCalled();
        expect(opp.approvalHistory).toHaveLength(0);
    });

    it('faculty token cannot approve after a partner rejected the opportunity (stale facultyApprovalStatus)', async () => {
        const opp = { id: 'o', faculty_verification_token: 'ftok', isStudentCreated: true, faculty_verified: false, creatorId: 'c', facultyApprovalStatus: 'pending', workflowStage: 'rejected', status: 'rejected', approvalHistory: [] } as any;
        const { service, save } = build(opp);
        await expect(service.verifyFaculty('ftok')).rejects.toThrow(BadRequestException);
        await expect(service.verifyOpportunityToken('ftok')).rejects.toThrow(BadRequestException);
        expect(save).not.toHaveBeenCalled();
        expect(opp.approvalHistory).toHaveLength(0);
    });

    it('faculty token cannot approve or decide while the opportunity is in revision', async () => {
        const opp = { id: 'o', faculty_verification_token: 'ftok', isStudentCreated: true, faculty_verified: false, creatorId: 'c', faculty_verification_status: 'pending_faculty', facultyApprovalStatus: 'revision_requested', workflowStage: 'revision', status: 'revision', approvalHistory: [] } as any;
        const { service, save } = build(opp);
        await expect(service.verifyFaculty('ftok')).rejects.toThrow(BadRequestException);
        await expect(service.decideOpportunityViaFacultyToken('ftok', 'revision', 'again')).rejects.toThrow(BadRequestException);
        expect(save).not.toHaveBeenCalled();
        expect(opp.approvalHistory).toHaveLength(0);
    });

    it('partner token cannot request revision twice or act on a live opportunity', async () => {
        const inRevision = { id: 'o', partnerToken: 'ptok', partnerVerified: false, isStudentCreated: true, workflowStage: 'revision', status: 'revision', approvalHistory: [] } as any;
        const a = build(inRevision);
        await expect(a.service.decideOpportunityViaPartnerToken('ptok', 'revision', 'r')).rejects.toThrow(BadRequestException);
        expect(a.save).not.toHaveBeenCalled();
        expect(inRevision.approvalHistory).toHaveLength(0);

        const live = { id: 'o', partnerToken: 'ptok', partnerVerified: false, isStudentCreated: true, workflowStage: 'live', status: 'active', approvalHistory: [] } as any;
        const b = build(live);
        await expect(b.service.decideOpportunityViaPartnerToken('ptok', 'reject')).rejects.toThrow(BadRequestException);

    });

    it('legacy partner token cannot approve a rejected, draft, revision or live opportunity', async () => {
        for (const [status, workflowStage] of [['rejected', 'rejected'], ['draft', null], ['revision', 'revision'], ['active', 'live']] as const) {
            const opp = { id: 'o', partnerToken: 'ptok', partnerVerified: false, isStudentCreated: false, status, workflowStage, approvalHistory: [] } as any;
            const { service, save } = build(opp);
            await expect(service.verifyOpportunityToken('ptok')).rejects.toThrow(BadRequestException);
            expect(save).not.toHaveBeenCalled();
            expect(opp.partnerVerified).toBe(false);
            expect(opp.approvalHistory).toHaveLength(0);
        }
    });

    it('student partner token cannot approve a rejected opportunity even if faculty_verified/status are stale', async () => {
        const opp = { id: 'o', partnerToken: 'ptok', partnerVerified: false, isStudentCreated: true, faculty_verified: true, status: 'rejected', workflowStage: 'rejected', approvalHistory: [] } as any;
        const { service, save } = build(opp);
        await expect(service.verifyOpportunityToken('ptok')).rejects.toThrow(BadRequestException);
        expect(save).not.toHaveBeenCalled();
    });

    it('liaison token cannot flip a rejected opportunity or activate outside pending_verification', async () => {
        const rejected = { id: 'o', liaisonToken: 'ltok', liaisonVerified: false, status: 'rejected', workflowStage: 'rejected' } as any;
        const a = build(rejected);
        await expect(a.service.verifyOpportunityToken('ltok')).rejects.toThrow(BadRequestException);
        expect(rejected.liaisonVerified).toBe(false);

        const pending = { id: 'o', title: 'T', liaisonToken: 'ltok', liaisonVerified: false, partnerVerified: true, status: 'pending_approval', workflowStage: 'pending_admin', facultyId: 'f' } as any;
        const b = build(pending);
        (b.service as any).assignFacultyIdFromSupervisionIfMissing = jest.fn();
        await b.service.verifyOpportunityToken('ltok');
        expect(pending.status).toBe('pending_approval');
    });

    it('executing-org confirm is refused for a rejected or live opportunity', async () => {
        const opp = { id: 'o', execution_verification_token: 'x', execution_verified: false, status: 'rejected', workflowStage: 'rejected' } as any;
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp), save: jest.fn() });
        (service as any).usersRepository = { findOne: jest.fn().mockResolvedValue({ id: 'u', email: 'a@b.org' }) };
        (service as any).findOne = jest.fn().mockResolvedValue(opp);
        await expect(service.verifyExecutingOrganizationForUser('u', 'a@b.org', 'o')).rejects.toThrow(BadRequestException);
    });

    it('a valid partner-token approval records actor+version and is not repeatable', async () => {
        const opp = { id: 'o', title: 'T', partnerToken: 'ptok', partnerVerified: false, isStudentCreated: true, faculty_verified: true, status: 'pending_partner', workflowStage: 'pending_partner', version: 3, approvalHistory: [] } as any;
        const { service, save } = build(opp);
        (service as any).assignFacultyIdFromSupervisionIfMissing = jest.fn();
        (service as any).handlePartnerApprovedSideEffects = jest.fn();
        await service.verifyOpportunityToken('ptok');
        expect(opp.status).toBe('pending_approval');
        expect(opp.workflowStage).toBe('pending_admin');
        expect(opp.approvalHistory).toHaveLength(1);
        expect(opp.approvalHistory[0]).toMatchObject({ line: 'partner', action: 'approved', version: 3 });
        expect(opp.approvalHistory[0].at).toBeTruthy();
        await service.verifyOpportunityToken('ptok'); // replay: idempotent, no new entry / save
        expect(opp.approvalHistory).toHaveLength(1);
        expect(save).toHaveBeenCalledTimes(1);
    });
});

describe('OpportunitiesService — e2e-found regressions', () => {
    const baseOrgRow = (over: Record<string, unknown>) =>
        ({
            id: 'opp-r',
            isStudentCreated: false,
            admin_approved: false,
            adminApprovalStatus: 'pending',
            facultyApprovalStatus: 'not_applicable',
            partnerApprovalStatus: 'not_applicable',
            requiresPartnerApproval: false,
            execution_verified: true,
            ...over,
        }) as unknown as Opportunity;

    it.each([
        ['rejected', { status: 'rejected', workflowStage: 'rejected' }],
        ['revision', { status: 'revision', workflowStage: 'revision' }],
    ])('CIEL approve refuses an org/faculty row that is %s (must be resubmitted first)', async (_l, over) => {
        const opp = baseOrgRow(over);
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save: jest.fn(async (row: Opportunity) => row),
        });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        await expect(service.approve('opp-r', { id: 'a1' })).rejects.toBeInstanceOf(BadRequestException);
        expect(opp.admin_approved).toBe(false);
    });

    it('org member edit after a CIEL PK revision request re-enters the admin queue (was stuck in revision)', async () => {
        const opp = baseOrgRow({
            creatorId: 'ngo-1',
            organizationId: 'org-1',
            status: 'revision',
            workflowStage: 'revision',
            adminApprovalStatus: 'revision_requested',
            rejectionReason: 'Add detail',
        });
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save: jest.fn(async (row: Opportunity) => row),
        });
        (service as any).usersRepository = { findOne: jest.fn().mockResolvedValue({ id: 'ngo-1', role: 'ngo' }) };
        (service as any).mailService = { sendAdminOpportunityReviewNeeded: jest.fn() };
        const saved: any = await service.update('ngo-1', { id: 'opp-r', title: 'Better' } as any, 'org-1');
        expect(saved.status).toBe('pending_approval');
        expect(saved.workflowStage).toBe('pending_admin');
        expect(saved.adminApprovalStatus).toBe('pending');
        expect(saved.version).toBe(2);
        expect(saved.rejectionReason).toBeNull();
    });

    it('a partial edit (validation-pipe leaves un-sent DTO fields undefined) never wipes stored JSON blocks', async () => {
        const supervision = { contact: 'fac@uni.edu' };
        const opp = baseOrgRow({
            creatorId: 'ngo-1',
            organizationId: 'org-1',
            status: 'pending_approval',
            workflowStage: 'pending_admin',
            supervision,
        });
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save: jest.fn(async (row: Opportunity) => row),
        });
        (service as any).usersRepository = { findOne: jest.fn().mockResolvedValue({ id: 'ngo-1', role: 'ngo' }) };
        const saved: any = await service.update(
            'ngo-1',
            { id: 'opp-r', title: 'Only a title', supervision: undefined, partner_organization: undefined } as any,
            'org-1',
        );
        expect(saved.title).toBe('Only a title');
        expect(saved.supervision).toBe(supervision);
    });

    it('a student cannot edit their own LIVE or CIEL-rejected opportunity through the generic update endpoint', async () => {
        for (const over of [
            { status: 'active', workflowStage: 'live', admin_approved: true },
            { status: 'rejected', workflowStage: 'rejected', adminApprovalStatus: 'rejected' },
        ]) {
            const opp = baseOrgRow({ creatorId: 's1', isStudentCreated: true, ...over });
            const service = makeService({
                findOne: jest.fn().mockResolvedValue(opp),
                save: jest.fn(async (row: Opportunity) => row),
            });
            (service as any).usersRepository = { findOne: jest.fn().mockResolvedValue({ id: 's1', role: 'student' }) };
            await expect(service.update('s1', { id: 'opp-r', title: 'sneaky' } as any)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(opp.title).toBeUndefined();
        }
    });
});


describe('OpportunitiesService — admin reject / revise require a reason', () => {
    function setup() {
        const opp = {
            id: 'opp-r-1',
            isStudentCreated: false,
            status: 'pending_approval',
            workflowStage: 'pending_admin',
            adminApprovalStatus: 'pending',
            admin_approved: false,
        } as unknown as Opportunity;
        const findOne = jest.fn().mockResolvedValue(opp);
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne, save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).notifyStudentOpportunityUpdate = jest.fn();
        return { service, opp, save, findOne };
    }

    it.each([
        ['reject', undefined],
        ['reject', ''],
        ['reject', '   \n\t '],
        ['reject', 42],
        ['reject', 'x'.repeat(2001)],
        ['revise', undefined],
        ['revise', null],
        ['revise', '   '],
        ['revise', { a: 1 }],
        ['revise', 'y'.repeat(2001)],
    ])('%s with reason %p -> 400 and no state change', async (action, reason) => {
        const { service, opp, save } = setup();
        await expect((service as any)[action]('opp-r-1', reason, { id: 'a', name: 'A' })).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(save).not.toHaveBeenCalled();
        expect(opp.status).toBe('pending_approval');
        expect(opp.adminApprovalStatus).toBe('pending');
    });

    it('stores the trimmed reason and accepts exactly 2000 chars', async () => {
        const a = setup();
        const r = await a.service.reject('opp-r-1', '  Not a fit.  ', { id: 'a', name: 'A' });
        expect(r.status).toBe('rejected');
        expect(r.rejectionReason).toBe('Not a fit.');
        const b = setup();
        const v = await b.service.revise('opp-r-1', 'z'.repeat(2000), { id: 'a', name: 'A' });
        expect(v.status).toBe('revision');
        expect(v.rejectionReason).toHaveLength(2000);
    });
});

describe('OpportunitiesService — create() idempotency for org / faculty / admin creators', () => {
    function setup(recent: unknown = null) {
        const create = jest.fn((payload) => payload);
        const save = jest.fn((payload) => Promise.resolve({ id: 'new-opp-id', ...payload }));
        const d = createDedupeStubs(recent);
        const service = makeService({ create, save, findOne: jest.fn(), ...d.stubs });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'ngo-user-1', role: 'ngo', email: 'contact@ngo.org' }),
        };
        (service as any).organizationsService = { getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }) };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        const mailService = { sendAdminOpportunityReviewNeeded: jest.fn() };
        (service as any).mailService = mailService;
        return { service, save, mailService, ...d };
    }
    const dto = (over: Record<string, unknown> = {}) => ({
        title: 'Beach cleanup drive',
        mode: 'Remote',
        timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
        safety_declaration: {
            environment_safe_and_appropriate: true,
            students_guided_and_supervised: true,
            lawful_ethical_and_non_hazardous: true,
            precautions_and_basic_safety: true,
        },
        submission_confirmations: {
            academically_valid_and_accurately_described: true,
            activity_properly_supervised: true,
            environment_safe_and_appropriate: true,
            information_correct_and_verifiable: true,
        },
        ...over,
    });

    it('returns the recently created identical row: no save, no mail, lock taken and released', async () => {
        const existing = { id: 'existing-opp', title: 'Beach cleanup drive' };
        const { service, save, mailService, lockQuery, dedupeQb } = setup(existing);
        const out = await service.create('ngo-user-1', dto() as any);
        expect(out).toBe(existing);
        expect(save).not.toHaveBeenCalled();
        expect(mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
        expect(lockQuery.mock.calls[0][0]).toContain('pg_advisory_lock');
        expect(lockQuery.mock.calls[0][1]).toEqual(['create_creator_opportunity:ngo-user-1']);
        expect(lockQuery.mock.calls[1][0]).toContain('pg_advisory_unlock');
        // rejected / deleted rows are excluded from the lookup
        const ignored = dedupeQb.andWhere.mock.calls.find((c: any[]) => c[1]?.ignored)?.[1].ignored;
        expect(ignored).toEqual(expect.arrayContaining(['rejected', 'deleted']));
    });

    it('creates normally when nothing matches, stamps a fingerprint, and never returns it', async () => {
        const { service, save } = setup(null);
        const out: any = await service.create('ngo-user-1', dto() as any);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0].createFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(out.createFingerprint).toBeUndefined();
        expect(out.id).toBe('new-opp-id');
    });

    it('releases the lock even when creation throws', async () => {
        const { service, lockQuery } = setup(null);
        await expect(service.create('ngo-user-1', dto({ mode: 'Onsite' }) as any)).rejects.toBeDefined();
        // validation fails before the lock is needed OR the lock is released — never left held
        const locks = lockQuery.mock.calls.filter((c) => String(c[0]).includes('pg_advisory_lock')).length;
        const unlocks = lockQuery.mock.calls.filter((c) => String(c[0]).includes('pg_advisory_unlock')).length;
        expect(locks).toBe(unlocks);
    });
});

describe('OpportunitiesService — university-scope (delegated) faculty can open and act on rows they are listed', () => {
    function makeDelegateService(delegatedIds: string[] | null) {
        const opp = {
            id: 'opp-scope-1',
            creatorId: 'student-1',
            facultyId: 'named-faculty',
            isStudentCreated: true,
            status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            faculty_verification_status: 'pending_faculty',
            facultyApprovalStatus: 'pending',
            admin_approved: false,
            supervision: { contact: 'named@uni.edu' },
        } as unknown as Opportunity;
        const service = makeService({
            findOne: jest.fn().mockResolvedValue(opp),
            save: jest.fn(async (row: Opportunity) => row),
        });
        (service as any).facultyUniversityScope = {
            getDelegatedOrganizationId: jest.fn().mockResolvedValue(delegatedIds ? 'uni-org-1' : null),
            resolveOpportunityIdsForUniversityOrganization: jest.fn().mockResolvedValue(delegatedIds ?? []),
        };
        (service as any).opportunityApplicationsService = {
            findActionablePendingFacultyApplicationForDashboard: jest.fn().mockResolvedValue(null),
        };
        (service as any).participationRepository = { count: jest.fn().mockResolvedValue(0) };
        (service as any).opportunitiesRepository.manager = {
            getRepository: () => ({
                count: async () => 0,
                createQueryBuilder: () => ({
                    where() { return this; },
                    andWhere() { return this; },
                    getCount: async () => 0,
                }),
            }),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'student-1', name: 'S', email: 's@uni.edu' }),
        };
        return { service, opp };
    }

    const delegate = { id: 'liaison-1', email: 'liaison@uni.edu', role: 'faculty', organizationId: null };

    it('detail: a delegated faculty gets the record (not 404)', async () => {
        const { service } = makeDelegateService(['opp-scope-1']);
        const data: any = await service.findOneWithCreator('opp-scope-1', delegate as any);
        expect(data.id).toBe('opp-scope-1');
    });

    it('detail: a faculty with no delegation for it still gets 404', async () => {
        const { service } = makeDelegateService(['some-other-opp']);
        await expect(service.findOneWithCreator('opp-scope-1', delegate as any)).rejects.toThrow(/not found/i);
    });

    it('detail: a faculty with no scope assignment at all still gets 404', async () => {
        const { service } = makeDelegateService(null);
        await expect(service.findOneWithCreator('opp-scope-1', delegate as any)).rejects.toThrow(/not found/i);
    });

    it('approve: delegated faculty passes the supervisor check (no 403)', async () => {
        const { service } = makeDelegateService(['opp-scope-1']);
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendPartnerVerification: jest.fn(),
            sendStudentOpportunityStatusUpdate: jest.fn(),
        };
        (service as any).notificationsService = { createApprovalNotification: jest.fn() };
        await expect(
            service.facultyDashboardApprove('opp-scope-1', delegate.id, delegate.email, 'Liaison'),
        ).resolves.toBeDefined();
    });

    it.each(['facultyDashboardApprove', 'facultyDashboardReject', 'facultyDashboardRevise'])(
        '%s: a faculty outside the delegation is still refused with 403',
        async (method) => {
            const { service } = makeDelegateService(['some-other-opp']);
            await expect(
                (service as any)[method]('opp-scope-1', delegate.id, delegate.email, 'A reason that is long enough'),
            ).rejects.toThrow(/not the assigned faculty supervisor/i);
        },
    );
});

describe('OpportunitiesService — every list-visible reviewer identity can open and act (access consistency)', () => {
    function makeAccessService(
        oppOver: Record<string, unknown> = {},
        opts: { uniOrg?: { id: string; orgType: string; name: string } | null; uniIds?: string[]; hasApplication?: boolean } = {},
    ) {
        const opp = {
            id: 'opp-acc-1',
            creatorId: 'creator-1',
            facultyId: null,
            organizationId: 'host-org',
            isStudentCreated: false,
            status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            admin_approved: false,
            supervision: {},
            ...oppOver,
        } as unknown as Opportunity;
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });
        (service as any).facultyUniversityScope = {
            getDelegatedOrganizationId: jest.fn().mockResolvedValue(null),
            resolveOpportunityIdsForUniversityOrganization: jest.fn().mockResolvedValue(opts.uniIds ?? []),
            isUniversityOrganization: (o: { orgType?: string }) => String(o?.orgType || '').toLowerCase().includes('university'),
            normalizeOrgName: (n: string) => (n || '').trim().toLowerCase(),
        };
        (service as any).participationRepository = { count: jest.fn().mockResolvedValue(0) };
        (service as any).opportunitiesRepository.manager = {
            getRepository: () => ({
                count: async () => (opts.hasApplication ? 1 : 0),
                createQueryBuilder: () => ({
                    where() { return this; },
                    andWhere() { return this; },
                    getCount: async () => 0,
                }),
            }),
        };
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'creator-1', name: 'C', email: 'creator@x.org', phone: '123' }),
        };
        (service as any).organizationsService = {
            findOne: jest.fn(async (id: string) => {
                if (opts.uniOrg && id === opts.uniOrg.id) return opts.uniOrg;
                throw new Error('not found');
            }),
            getMyOrganization: jest.fn().mockResolvedValue(null),
        };
        return { service, opp };
    }

    const viewer = (email: string, role = 'faculty', organizationId: string | null = null) => ({
        id: `u-${email}`,
        email,
        role,
        organizationId,
    });

    it('detail: the faculty named only as the NGO "faculty link" representative can open the record', async () => {
        const { service } = makeAccessService({
            visibility_and_academic_linkage: { faculty_institutional_representative: { official_email: 'fir@uni.edu' } },
            supervision: { contact: 'someone.else@uni.edu' },
        });
        const data: any = await service.findOneWithCreator('opp-acc-1', viewer('fir@uni.edu') as any);
        expect(data.creator.email).toBe('creator@x.org'); // reviewer sees the contact
    });

    it('detail: every partner contact email works, not only the first non-empty source', async () => {
        const { service } = makeAccessService({
            external_partner_collaboration: { official_email: 'first@ngo.org' },
            supervision: { external_partner_email: 'second@ngo.org' },
            partner_organization: { official_email: 'third@ngo.org' },
        });
        for (const em of ['first@ngo.org', 'second@ngo.org', 'third@ngo.org']) {
            const data: any = await service.findOneWithCreator('opp-acc-1', viewer(em, 'ngo') as any);
            expect(data.id).toBe('opp-acc-1');
        }
    });

    it('detail: the executing-organization contact can open the record they are asked to confirm', async () => {
        const { service } = makeAccessService({ executing_organization: { official_email: 'exec@org.pk' } });
        const data: any = await service.findOneWithCreator('opp-acc-1', viewer('exec@org.pk', 'ngo') as any);
        expect(data.id).toBe('opp-acc-1');
    });

    it('detail: an unrelated login still gets 404', async () => {
        const { service } = makeAccessService({
            visibility_and_academic_linkage: { faculty_institutional_representative: { official_email: 'fir@uni.edu' } },
            executing_organization: { official_email: 'exec@org.pk' },
        });
        await expect(service.findOneWithCreator('opp-acc-1', viewer('stranger@x.org', 'ngo', 'other-org') as any)).rejects.toThrow(/not found/i);
    });

    it('detail: a university dashboard can open a record in its scope, with contacts redacted and no edit right', async () => {
        const uni = { id: 'uni-org', orgType: 'UNIVERSITY', name: 'Uni' };
        const { service } = makeAccessService({}, { uniOrg: uni, uniIds: ['opp-acc-1'] });
        const data: any = await service.findOneWithCreator('opp-acc-1', viewer('reg@uni.edu', 'university', 'uni-org') as any);
        expect(data.id).toBe('opp-acc-1');
        expect(data.creator.email).toBeUndefined(); // contact keys stripped for non-reviewers
        expect(data.viewer_access.can_edit).toBe(false);
    });

    it('detail: a university whose scope does not contain the record, or a non-university org, still gets 404', async () => {
        const uni = { id: 'uni-org', orgType: 'UNIVERSITY', name: 'Uni' };
        const a = makeAccessService({}, { uniOrg: uni, uniIds: ['other-opp'] });
        await expect(a.service.findOneWithCreator('opp-acc-1', viewer('reg@uni.edu', 'university', 'uni-org') as any)).rejects.toThrow(/not found/i);
        const ngo = { id: 'ngo-org', orgType: 'NGO', name: 'Ngo' };
        const b = makeAccessService({}, { uniOrg: ngo, uniIds: ['opp-acc-1'] });
        await expect(b.service.findOneWithCreator('opp-acc-1', viewer('x@ngo.org', 'ngo', 'ngo-org') as any)).rejects.toThrow(/not found/i);
    });

    it('detail: a student with their own pending join request can still open a non-public listing', async () => {
        const { service } = makeAccessService({}, { hasApplication: true });
        const data: any = await service.findOneWithCreator('opp-acc-1', viewer('stu@uni.edu', 'student') as any);
        expect(data.id).toBe('opp-acc-1');
        expect(data.creator.email).toBeUndefined();
    });

    it('viewer_access.can_edit: creator org / owner yes; named partner, exec contact, university no', async () => {
        const { service, opp } = makeAccessService({ organizationId: 'host-org', partner_organization: { official_email: 'p@ngo.org' } });
        const edit = (v: any) => (service as any).viewerMayEditOpportunity(opp, v);
        expect(edit({ id: 'colleague', role: 'ngo', organizationId: 'host-org' })).toBe(true);
        expect(edit({ id: 'p', email: 'p@ngo.org', role: 'ngo', organizationId: 'partner-org' })).toBe(false);
        expect(edit({ id: 'creator-1', role: 'faculty', organizationId: null })).toBe(true); // faculty creator (facultyId unset)
        (opp as any).facultyId = 'another-faculty';
        expect(edit({ id: 'creator-1', role: 'faculty', organizationId: null })).toBe(false); // update() would 403 here too
        expect(edit({ role: 'ngo', organizationId: 'host-org' })).toBe(false);
    });

    it('faculty action: FIR-listed faculty passes the supervisor gate even when supervision.contact names someone else', async () => {
        const { service, opp } = makeAccessService({
            visibility_and_academic_linkage: { faculty_institutional_representative: { official_email: 'fir@uni.edu' } },
            supervision: { contact: 'someone.else@uni.edu' },
        });
        await expect(
            (service as any).assertFacultySupervisorForStudentOpportunity(opp, 'fac-1', 'fir@uni.edu'),
        ).resolves.toBeUndefined();
        await expect(
            (service as any).assertFacultySupervisorForStudentOpportunity(opp, 'fac-2', 'nobody@uni.edu'),
        ).rejects.toThrow(/not the assigned faculty supervisor/i);
    });

    it('partner action: a partner named in a later contact field passes the ownership gate; a stranger does not', async () => {
        const { service, opp } = makeAccessService({
            isStudentCreated: true,
            organizationId: null,
            external_partner_collaboration: { official_email: 'first@ngo.org' },
            executing_context: { partner: { official_email: 'ctx@ngo.org' } },
        });
        await expect(
            (service as any).assertPartnerOwnsOpportunity(opp, 'ctx@ngo.org', null, null),
        ).resolves.toBeUndefined();
        await expect(
            (service as any).assertPartnerOwnsOpportunity(opp, 'stranger@ngo.org', null, null),
        ).rejects.toThrow(/not the assigned partner reviewer/i);
    });

    it('org-created row: a same-org colleague is NOT a partner reviewer (gate unchanged)', async () => {
        const { service, opp } = makeAccessService({ isStudentCreated: false, organizationId: 'host-org' });
        await expect(
            (service as any).partnerReviewIdentityMatches(opp, 'colleague@ngo.org', 'host-org', 'col-1', ['Host Org']),
        ).resolves.toBe(false);
    });
});

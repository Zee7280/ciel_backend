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
        const releaseMock = jest.fn();
        const opportunitiesRepo = {
            manager: { connection: { createQueryRunner: () => ({ connect: jest.fn(), release: releaseMock, query: managerQuery }) } },
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
        expect(releaseMock).toHaveBeenCalledTimes(1); // connection returned to the pool
    });

    it('still releases the lock when the duplicate-title check throws', async () => {
        const managerQuery = jest.fn().mockResolvedValue(undefined);
        const releaseMock = jest.fn();
        const opportunitiesRepo = { manager: { connection: { createQueryRunner: () => ({ connect: jest.fn(), release: releaseMock, query: managerQuery }) } } };
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
        expect(releaseMock).toHaveBeenCalledTimes(1);
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

    it('does not write draft/id/approval columns, and stores a blank mode as null', async () => {
        const create = jest.fn((payload) => payload);
        const save = jest.fn((payload) => Promise.resolve({ id: 'new-draft-id', ...payload }));
        const service = makeService({ create, save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'student-1' }),
        };

        await service.saveStudentOpportunityDraft('student-1', null, {
            draft: true,
            id: 'should-not-land',
            title: 'Untitled opportunity',
            mode: '',
            types: [],
            verification_method: [],
            admin_approved: true,
            creatorId: 'attacker',
            status: 'active',
        });

        const payload = create.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.draft).toBeUndefined();
        expect(payload.id).toBeUndefined();
        expect(payload.admin_approved).toBeUndefined();
        expect(payload.creatorId).toBe('student-1');
        expect(payload.status).toBe('draft');
        expect(payload.mode).toBeNull();
        expect(payload.types).toEqual([]);
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
        const service = makeService({ create, save, findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'ngo-user-1', role: 'ngo', email: 'contact@ngo.org' }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }),
        };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = { sendAdminOpportunityReviewNeeded: jest.fn() };
        return { service, save };
    }

    it('routes to pending_approval even when the client omits admin_approval_required', async () => {
        const { service, save } = makeOrgCreatorService();

        const saved = await service.create('ngo-user-1', minimalOrgCreatorDto());

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

        const saved = await service.create(
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

        const saved = await service.create(
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

        const saved = await service.create('ngo-user-1', minimalOrgCreatorDto());

        expect(saved.facultyApprovalStatus).toBe('not_applicable');
        expect(saved.status).toBe('pending_approval');
        expect(saved.workflowStage).toBe('pending_admin');
        expect(saved.admin_approved).toBe(false);
        expect(saved.adminApprovalStatus).toBe('pending');
    });

    it('ignores a crafted admin_approved:true from the client payload', async () => {
        const { service } = makeOrgCreatorService();

        const saved = await service.create(
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

        const saved = await service.create(
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

        const saved = await service.create(
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
        const service = makeService({ create, save, findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) });
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
        const saved = await service.create('admin-1', minimalAdminDto());
        expect(saved.status).toBe('active');
        expect(saved.adminApprovalStatus).toBe('approved');
        expect(saved.admin_approved).toBe(true);
        expect((service as any).mailService.sendAdminOpportunityReviewNeeded).not.toHaveBeenCalled();
    });

    it('does not treat the Super Admin creator email as a faculty stakeholder', async () => {
        const { service } = makeCielAdminService();
        const saved = await service.create(
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
        const saved = await service.create(
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
        const saved = await service.create(
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
        const saved = await service.create(
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
    it('reject() is idempotent, requires a reason, and approve() refuses rejected/revision rows', async () => {
        const opp = {
            id: 'opp-rej-1',
            isStudentCreated: false,
            admin_approved: false,
            status: 'pending_approval',
            workflowStage: 'pending_admin',
            adminApprovalStatus: 'pending',
            version: 1,
            approvalHistory: [],
        } as unknown as Opportunity;
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp), save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();

        await expect(service.reject('opp-rej-1', '  ')).rejects.toBeInstanceOf(BadRequestException);
        await service.reject('opp-rej-1', 'Not suitable', { id: 'a1', name: 'A' });
        await service.reject('opp-rej-1', 'Not suitable', { id: 'a1', name: 'A' });
        expect((opp as any).approvalHistory).toHaveLength(1);
        expect(save).toHaveBeenCalledTimes(1);
        await expect(service.revise('opp-rej-1', 'again')).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.approve('opp-rej-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('setStatus() only allows closed/draft', async () => {
        const opp = { id: 'o', status: 'active' } as unknown as Opportunity;
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp), save });
        await expect(service.setStatus('o', 'active')).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.setStatus('o', 'rejected')).rejects.toBeInstanceOf(BadRequestException);
        const saved = await service.setStatus('o', 'closed');
        expect(saved.status).toBe('closed');
    });
});

describe('OpportunitiesService — update() mass-assignment hardening', () => {
    const baseOpp = () =>
        ({
            id: 'opp-ma',
            creatorId: 'fac-1',
            facultyId: 'fac-1',
            organizationId: 'org-1',
            isStudentCreated: false,
            title: 'Original',
            status: 'pending_admin',
            workflowStage: 'pending_admin',
            admin_approved: false,
            adminApprovalStatus: 'pending',
            facultyApprovalStatus: 'approved',
            partnerApprovalStatus: 'not_applicable',
            partnerToken: 'tok-secret',
        }) as unknown as Opportunity;

    function setup(opp: Opportunity, role: string, userId: string) {
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp), save });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: userId, role }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }),
        };
        (service as any).opportunityWorkflow = { initFacultyCreated: jest.fn() };
        return service;
    }

    it('ignores workflow / ownership / token keys sent through the untyped PATCH body', async () => {
        const opp = baseOpp();
        const service = setup(opp, 'faculty', 'fac-1');
        const saved = (await service.update('fac-1', {
            id: 'opp-ma',
            title: 'Edited title',
            admin_approved: true,
            status: 'active',
            workflowStage: 'live',
            adminApprovalStatus: 'approved',
            creatorId: 'attacker',
            organizationId: 'org-evil',
            partnerToken: 'forged',
            requiredHours: 1,
            sdg: 'forged-sdg',
        } as any)) as any;
        const row = saved.data ?? saved;
        expect(row.title).toBe('Edited title');
        expect(row.admin_approved).not.toBe(true);
        expect(row.status).not.toBe('active');
        expect(row.workflowStage).not.toBe('live');
        expect(row.adminApprovalStatus).not.toBe('approved');
        expect(row.creatorId).toBe('fac-1');
        expect(row.organizationId).toBe('org-1');
        expect(row.partnerToken).toBe('tok-secret');
        expect(row.sdg).not.toBe('forged-sdg');
    });

    it('does not let a student edit an approved/live opportunity through update()', async () => {
        const opp = {
            ...baseOpp(),
            creatorId: 'stu-1',
            facultyId: null,
            isStudentCreated: true,
            admin_approved: true,
            status: 'active',
            workflowStage: 'live',
        } as unknown as Opportunity;
        const service = setup(opp, 'student', 'stu-1');
        await expect(
            service.update('stu-1', {
                id: 'opp-ma',
                title: 'Rewrite live listing',
                participation_scope: { rule: 'open_all_universities' },
            } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a student editing their own unapproved listing cannot widen its scope', async () => {
        const opp = {
            ...baseOpp(),
            creatorId: 'stu-2',
            facultyId: null,
            isStudentCreated: true,
            status: 'pending_faculty',
            workflowStage: 'pending_faculty',
            participation_scope: { rule: 'own_university_only' },
            restricted_universities: ['BNU'],
        } as unknown as Opportunity;
        const service = setup(opp, 'student', 'stu-2');
        const saved = (await service.update('stu-2', {
            id: 'opp-ma',
            title: 'New title',
            participation_scope: { rule: 'open_all_universities' },
            restricted_universities: [],
        } as any)) as any;
        const row = saved.data ?? saved;
        expect(row.participation_scope).toEqual({ rule: 'own_university_only' });
        expect(row.restricted_universities).toEqual(['BNU']);
    });
});

describe('OpportunitiesService — nested contact email validation', () => {
    const service = makeService({});
    const call = (patch: any) => (service as any).validateEditPatch(patch);

    it('rejects malformed executing / partner / faculty-rep emails', () => {
        expect(() => call({ executing_organization: { official_email: 'not-an-email' } })).toThrow(BadRequestException);
        expect(() => call({ partner_organization: { official_email: 'x@' } })).toThrow(BadRequestException);
        expect(() =>
            call({
                visibility_and_academic_linkage: {
                    faculty_institutional_representative: { official_email: 'nope' },
                },
            }),
        ).toThrow(BadRequestException);
    });

    it('accepts valid or empty emails', () => {
        expect(() => call({ executing_organization: { official_email: 'ok@org.com' } })).not.toThrow();
        expect(() => call({ executing_organization: { official_email: '' } })).not.toThrow();
        expect(() => call({})).not.toThrow();
    });

    it('edit keeps the create-time all-true safety / confirmation rules', () => {
        expect(() => call({ safety_declaration: { environment_safe_and_appropriate: false } })).toThrow(BadRequestException);
        expect(() => call({ submission_confirmations: {} })).toThrow(BadRequestException);
        expect(() => call({ supervision: { contact: 'not-an-email' } })).toThrow(BadRequestException);
    });
});

describe('OpportunitiesService — org-created routing, live-edit re-review, admin re-gating', () => {
    const exec = {
        supervisor_name: 'Org Contact',
        role: 'Executing organization — official contact',
        contact: 'contact@ngo.org',
        safe_environment: true,
        supervised: true,
    };
    const orgDto = (over: Record<string, unknown> = {}) =>
        ({
            title: 'Beach cleanup drive',
            mode: 'Remote',
            timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
            supervision: exec,
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
            ...over,
        }) as any;

    function orgCreate() {
        const save = jest.fn((payload) => Promise.resolve({ id: 'new-opp', ...payload }));
        const service = makeService({ create: jest.fn((p) => p), save, findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'ngo-1', role: 'ngo', email: 'creator@ngo.org' }),
        };
        (service as any).organizationsService = { getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }) };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendAdminOpportunityReviewNeeded: jest.fn(),
            sendFacultyStudentOpportunityVerification: jest.fn(),
        };
        return service;
    }

    it('the executing-org contact mirrored into supervision.contact is NOT treated as a faculty (faculty stays optional)', async () => {
        const service = orgCreate();
        const saved = (await service.create('ngo-1', orgDto())) as any;
        expect(saved.status).toBe('pending_approval');
        expect(saved.faculty_verification_token ?? null).toBeNull();
        expect(saved.facultyApprovalStatus).toBe('not_applicable');
    });

    it('a real faculty representative still gates the listing, and the executing-org contact does not replace them', async () => {
        const service = orgCreate();
        const saved = (await service.create(
            'ngo-1',
            orgDto({
                visibility_and_academic_linkage: {
                    faculty_institutional_representative: { official_email: 'prof@uni.edu' },
                },
            }),
        )) as any;
        expect(saved.status).toBe('pending_faculty');
        expect(saved.faculty_verification_token).toBeTruthy();
        expect((service as any).resolveFacultyEmail(saved)).toBe('prof@uni.edu');
    });

    // ---------- update(): live material edits ----------
    const liveOpp = (over: Record<string, unknown> = {}) =>
        ({
            id: 'opp-live',
            title: 'Live listing',
            creatorId: 'fac-1',
            facultyId: 'fac-1',
            organizationId: 'org-1',
            isStudentCreated: false,
            status: 'active',
            workflowStage: 'live',
            admin_approved: true,
            adminApprovalStatus: 'approved',
            facultyApprovalStatus: 'approved',
            partnerApprovalStatus: 'not_applicable',
            partnerVerified: true,
            requiresPartnerApproval: false,
            participation_scope: { rule: 'open_all_universities' },
            restricted_universities: [],
            mode: 'Remote',
            location: null,
            sdg_info: { sdg_id: '4' },
            supervision: { contact: 'prof@uni.edu' },
            ...over,
        }) as unknown as Opportunity;

    function updater(opp: Opportunity, role: string, userId: string, email = 'x@y.z') {
        const save = jest.fn(async (row: Opportunity) => row);
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp), save });
        (service as any).usersRepository = { findOne: jest.fn().mockResolvedValue({ id: userId, role, email }) };
        (service as any).organizationsService = { getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }) };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = {
            sendAdminOpportunityReviewNeeded: jest.fn(),
            sendPartnerVerification: jest.fn().mockResolvedValue(undefined),
            sendFacultyStudentOpportunityVerification: jest.fn().mockResolvedValue(undefined),
        };
        return { service, save };
    }

    it('faculty: a typo fix keeps a LIVE listing live', async () => {
        const { service } = updater(liveOpp(), 'faculty', 'fac-1');
        const saved = (await service.update('fac-1', { id: 'opp-live', title: 'Live listing (fixed typo)' } as any)) as any;
        expect(saved.admin_approved).toBe(true);
        expect(saved.workflowStage).toBe('live');
        expect(saved.status).toBe('active');
    });

    it('faculty: widening the audience of a LIVE listing sends it back through CIEL PK review', async () => {
        const { service } = updater(liveOpp({ participation_scope: { rule: 'own_university_only' } }), 'faculty', 'fac-1');
        const saved = (await service.update('fac-1', {
            id: 'opp-live',
            participation_scope: { rule: 'open_all_universities' },
        } as any)) as any;
        expect(saved.admin_approved).toBe(false);
        expect(saved.workflowStage).toBe('pending_admin');
        expect(saved.adminApprovalStatus).toBe('pending');
    });

    it('org member: a material edit of a LIVE listing is re-reviewed; a cosmetic edit is not', async () => {
        const cosmetic = updater(liveOpp({ creatorId: 'ngo-1', facultyId: null }), 'ngo', 'ngo-1');
        const a = (await cosmetic.service.update('ngo-1', { id: 'opp-live', title: 'Renamed' } as any, 'org-1')) as any;
        expect(a.admin_approved).toBe(true);
        expect(a.workflowStage).toBe('live');

        const material = updater(liveOpp({ creatorId: 'ngo-1', facultyId: null }), 'ngo', 'ngo-1');
        const b = (await material.service.update(
            'ngo-1',
            { id: 'opp-live', restricted_universities: ['LUMS'] } as any,
            'org-1',
        )) as any;
        expect(b.admin_approved).toBe(false);
        expect(b.workflowStage).toBe('pending_admin');
        expect(b.status).toBe('pending_approval');
    });

    it('org member: saving after a revision request resubmits into review instead of getting stuck', async () => {
        const opp = liveOpp({
            creatorId: 'ngo-1',
            facultyId: null,
            status: 'revision',
            workflowStage: 'revision',
            admin_approved: false,
            adminApprovalStatus: 'revision_requested',
        });
        const { service } = updater(opp, 'ngo', 'ngo-1');
        const saved = (await service.update('ngo-1', { id: 'opp-live', title: 'Fixed per feedback' } as any, 'org-1')) as any;
        expect(saved.workflowStage).toBe('pending_admin');
        expect(saved.status).toBe('pending_approval');
        expect(saved.adminApprovalStatus).toBe('pending');
    });

    it('admin: adding a partner contact while editing opens the partner gate (token + email)', async () => {
        const opp = liveOpp({ creatorId: 'admin-1', facultyId: null, supervision: {} });
        const { service } = updater(opp, 'admin', 'admin-1', 'admin@cielpk.com');
        const saved = (await service.update('admin-1', {
            id: 'opp-live',
            partner_organization: { organization_name: 'Partner', official_email: 'partner@org.com' },
            external_partner_collaboration: {
                organization_name: 'Partner',
                contact_person: 'P',
                official_email: 'partner@org.com',
            },
        } as any)) as any;
        expect(saved.partnerToken).toBeTruthy();
        expect(saved.status).toBe('pending_partner');
        expect(saved.admin_approved).toBe(false);
        expect((service as any).mailService.sendPartnerVerification).toHaveBeenCalled();
    });
});

describe('OpportunitiesService — student create does not leave orphan placeholder organizations', () => {
    const user = { id: 'stu-1', name: 'Ali', email: 'ali@uni.edu', university: 'BNU' } as any;
    const dto = {
        title: 'Reading circles',
        mode: 'Remote',
        timeline: { start_date: '2026-10-01', end_date: '2026-10-31' },
        supervision: { contact: 'teacher@uni.edu', faculty_department: 'CS' },
        sdg_info: { sdg_id: '4' },
    } as any;

    function build(opportunitySave: jest.Mock) {
        const orgDelete = jest.fn().mockResolvedValue(undefined);
        const service = makeService({
            create: jest.fn((p) => p),
            save: opportunitySave,
        });
        (service as any).organizationsRepository = {
            create: jest.fn((r) => r),
            save: jest.fn(async (r) => ({ ...r, id: 'org-placeholder' })),
            delete: orgDelete,
        };
        (service as any).usersRepository = { findOne: jest.fn().mockResolvedValue(null) };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = { sendFacultyStudentOpportunityVerification: jest.fn().mockResolvedValue(undefined) };
        return { service, orgDelete };
    }

    it('removes the placeholder organization when the opportunity INSERT fails', async () => {
        const { service, orgDelete } = build(jest.fn().mockRejectedValue(new Error('db down')));
        await expect(
            (service as any).finishCreatingStudentOpportunity(dto, user, false, false, null, ['BNU'], false),
        ).rejects.toThrow('db down');
        expect(orgDelete).toHaveBeenCalledWith('org-placeholder');
    });

    it('keeps the organization on success', async () => {
        const { service, orgDelete } = build(jest.fn(async (row) => ({ id: 'opp-1', ...row })));
        const res = await (service as any).finishCreatingStudentOpportunity(dto, user, false, false, null, ['BNU'], false);
        expect(res).toEqual(expect.objectContaining({ success: true }));
        expect(orgDelete).not.toHaveBeenCalled();
    });
});

describe('OpportunitiesService — content hygiene applies to every creator type', () => {
    const svc = () => makeService({}) as any;

    it('strips control characters and collapses the title whitespace', () => {
        const dto: any = {
            title: '  Beach \n  clean\u0007up ',
            objectives: { description: 'Line1\u0000\u0008 text\r\n\r\n\r\n\r\n\r\nEnd' },
            activity_details: { student_responsibilities: 'a\u0001b', skills_gained: [' Teaching ', ''] },
        };
        svc().sanitizeAndBoundContent(dto);
        expect(dto.title).toBe('Beach clean up');
        expect(dto.objectives.description).not.toMatch(/[\u0000-\u0008]/);
        expect(dto.activity_details.student_responsibilities).toBe('ab');
        expect(dto.activity_details.skills_gained).toEqual(['Teaching']);
    });

    it('rejects an unbounded description or responsibilities field', () => {
        expect(() =>
            svc().sanitizeAndBoundContent({ objectives: { description: 'x'.repeat(12001) } }),
        ).toThrow(BadRequestException);
        expect(() =>
            svc().sanitizeAndBoundContent({ activity_details: { student_responsibilities: 'x'.repeat(12001) } }),
        ).toThrow(BadRequestException);
        expect(() =>
            svc().sanitizeAndBoundContent({ objectives: { description: 'x'.repeat(12000) } }),
        ).not.toThrow();
    });
});

describe('OpportunitiesService — non-student creators cannot double-submit the same title', () => {
    const dto = () =>
        ({
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
            sdg_info: { sdg_id: '14' },
        }) as any;

    const build = (existing: Array<Record<string, unknown>>) => {
        const save = jest.fn((p) => Promise.resolve({ id: 'new-opp', ...p }));
        const service = makeService({
            create: jest.fn((p) => p),
            save,
            findOne: jest.fn(),
            find: jest.fn().mockResolvedValue(existing),
        });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'ngo-1', role: 'ngo', email: 'c@ngo.org' }),
        };
        (service as any).organizationsService = { getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }) };
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).mailService = { sendAdminOpportunityReviewNeeded: jest.fn() };
        return { service, save };
    };

    it('rejects a second live/pending listing with the same (normalised) title', async () => {
        const { service, save } = build([
            { id: 'old-1', title: 'beach  CLEANUP drive!', status: 'pending_approval', workflowStage: 'pending_admin' },
        ]);
        await expect(service.create('ngo-1', dto())).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'DUPLICATE_OPPORTUNITY_TITLE', existingOpportunityId: 'old-1' }),
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('ignores drafts, rejected and closed listings, and different titles', async () => {
        const { service } = build([
            { id: 'a', title: 'Beach cleanup drive', status: 'draft' },
            { id: 'b', title: 'Beach cleanup drive', status: 'rejected' },
            { id: 'c', title: 'Beach cleanup drive', status: 'closed' },
            { id: 'd', title: 'Beach cleanup drive', status: 'pending_approval', workflowStage: 'rejected' },
            { id: 'e', title: 'Tree plantation', status: 'active' },
        ]);
        await expect(service.create('ngo-1', dto())).resolves.toBeTruthy();
    });
});

describe('OpportunitiesService.decideOpportunityViaPartnerToken — a stale link cannot reopen a live opportunity', () => {
    const run = async (opp: Record<string, unknown>, action: 'reject' | 'revision') => {
        const save = jest.fn(async (row) => row);
        const service = makeService({ findOne: jest.fn().mockResolvedValue(opp), save });
        (service as any).opportunityWorkflow = new OpportunityWorkflowService();
        (service as any).notifyStudentOpportunityUpdate = jest.fn();
        return { promise: service.decideOpportunityViaPartnerToken('tok', action, 'reason'), save };
    };

    it.each([
        ['live + admin approved', { workflowStage: 'live', admin_approved: true, status: 'active', partnerVerified: false }],
        ['admin approved only', { admin_approved: true, partnerVerified: false }],
        ['partner line already approved', { partnerApprovalStatus: 'approved', partnerVerified: false }],
    ])('refuses reject/revision on %s', async (_label, opp) => {
        for (const action of ['reject', 'revision'] as const) {
            const { promise, save } = await run({ id: 'o1', title: 'T', ...opp }, action);
            await expect(promise).rejects.toThrow(/already approved/);
            expect(save).not.toHaveBeenCalled();
        }
    });

    it('still lets the partner reject while their line is open', async () => {
        const { promise, save } = await run(
            { id: 'o1', title: 'T', workflowStage: 'pending_partner', status: 'pending_partner', partnerApprovalStatus: 'pending', partnerVerified: false, admin_approved: false },
            'reject',
        );
        await expect(promise).resolves.toMatchObject({ success: true });
        expect(save).toHaveBeenCalled();
    });
});

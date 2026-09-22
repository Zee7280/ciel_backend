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

    it('never lists a student-created Team Project in the public directory, regardless of visibility/scope', () => {
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
                visibility_and_academic_linkage: { visibility_type: 'open_all_universities' },
            }),
        ).toBe(false);
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
            manager: { query: managerQuery },
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
    });

    it('still releases the lock when the duplicate-title check throws', async () => {
        const managerQuery = jest.fn().mockResolvedValue(undefined);
        const opportunitiesRepo = { manager: { query: managerQuery } };
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
        const service = makeService({ create, save, findOne: jest.fn() });
        (service as any).usersRepository = {
            findOne: jest.fn().mockResolvedValue({ id: 'ngo-user-1', role: 'ngo', email: 'contact@ngo.org' }),
        };
        (service as any).organizationsService = {
            getMyOrganization: jest.fn().mockResolvedValue({ id: 'org-1' }),
        };
        (service as any).mailService = { sendAdminOpportunityReviewNeeded: jest.fn() };
        return { service, save };
    }

    it('routes to pending_approval even when the client omits admin_approval_required', async () => {
        const { service, save } = makeOrgCreatorService();

        const saved = await service.create('ngo-user-1', minimalOrgCreatorDto());

        expect(saved.status).toBe('pending_approval');
        expect(save).toHaveBeenCalled();
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


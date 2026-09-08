import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { Opportunity } from './entities/opportunity.entity';

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

        it('still requires a matching login for a faculty-token link when VERIFICATION_REQUIRE_AUTH is on', async () => {
            process.env.VERIFICATION_REQUIRE_AUTH = 'true';
            const opp = {
                id: 'opp-1',
                faculty_verification_token: 'faculty-tok',
                title: 'Community clean-up',
            } as unknown as Opportunity;
            const service = makeService({ findOne: jest.fn().mockResolvedValue(opp) });

            await expect(service.verifyOpportunityToken('faculty-tok', undefined)).rejects.toThrow(UnauthorizedException);
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
});

describe('OpportunitiesService — student create-opportunity is locked to their own university', () => {
    const baseDto = () => ({
        title: 'Beach clean-up',
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

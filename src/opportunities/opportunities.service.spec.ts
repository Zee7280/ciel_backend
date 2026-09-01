import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { Opportunity } from './entities/opportunity.entity';

function makeService(opportunitiesRepo: Partial<Record<string, jest.Mock>>) {
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

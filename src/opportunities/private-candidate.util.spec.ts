import { isPrivateCandidateDto, isPrivateCandidateOpportunity, reviewRouteForOpportunity } from './private-candidate.util';

describe('isPrivateCandidateDto', () => {
    it('detects student_pathway private', () => {
        expect(isPrivateCandidateDto({ executing_context: { student_pathway: 'private' } })).toBe(true);
    });

    it('detects nested private_candidate object', () => {
        expect(
            isPrivateCandidateDto({
                executing_context: { private_candidate: { programme: 'BBA' } },
            }),
        ).toBe(true);
    });

    it('detects supervision flag', () => {
        expect(isPrivateCandidateDto({ supervision: { private_candidate: true } })).toBe(true);
    });

    it('is false for university-linked student payloads', () => {
        expect(
            isPrivateCandidateDto({
                executing_context: { type: 'independent' },
                supervision: { contact: 'faculty@uni.edu' },
            }),
        ).toBe(false);
    });
});

describe('isPrivateCandidateOpportunity', () => {
    it('matches stored not_required faculty line', () => {
        expect(
            isPrivateCandidateOpportunity({ faculty_verification_status: 'not_required' }),
        ).toBe(true);
    });

    it('is false for a normal faculty-gated listing', () => {
        expect(
            isPrivateCandidateOpportunity({
                faculty_verification_status: 'pending_faculty',
                facultyApprovalStatus: 'pending',
            }),
        ).toBe(false);
    });

    it('is false for a partner listing that has no faculty line', () => {
        expect(
            isPrivateCandidateOpportunity({
                facultyApprovalStatus: 'not_applicable',
                faculty_verification_status: 'faculty_verified',
            }),
        ).toBe(false);
    });
});

describe('reviewRouteForOpportunity', () => {
    it('routes private listings to CIEL PK', () => {
        expect(
            reviewRouteForOpportunity({ executing_context: { student_pathway: 'private' } }),
        ).toBe('ciel_pk');
    });

    it('routes university-supervised listings to faculty', () => {
        expect(
            reviewRouteForOpportunity({
                faculty_verification_status: 'pending_faculty',
            }),
        ).toBe('faculty');
    });
});

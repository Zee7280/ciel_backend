import { isPrivateCandidateDto, isPrivateCandidateOpportunity, reviewRouteForOpportunity, applyCanonicalPrivateCandidatePhone } from './private-candidate.util';

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

describe('applyCanonicalPrivateCandidatePhone', () => {
    it('writes the same E.164 onto student_contact and nested private phone', () => {
        const dto = {
            student_contact: '03001234567',
            executing_context: {
                student_pathway: 'private',
                private_candidate: { phone: '300 1234567' },
                independent_community_activity: { contact_number: '' },
            },
        };
        applyCanonicalPrivateCandidatePhone(dto, { required: true });
        expect(dto.student_contact).toBe('+923001234567');
        expect((dto.executing_context.private_candidate as { phone: string }).phone).toBe(
            '+923001234567',
        );
        expect(
            (dto.executing_context.independent_community_activity as { contact_number: string })
                .contact_number,
        ).toBe('+923001234567');
    });

    it('rejects a missing private-candidate phone on full submit', () => {
        expect(() =>
            applyCanonicalPrivateCandidatePhone(
                { executing_context: { student_pathway: 'private' } },
                { required: true },
            ),
        ).toThrow(/must provide a mobile/);
    });

    it('does not require a phone on draft save', () => {
        const dto = { executing_context: { student_pathway: 'private' } };
        expect(() => applyCanonicalPrivateCandidatePhone(dto, { required: false })).not.toThrow();
    });
});

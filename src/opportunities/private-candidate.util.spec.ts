import { isPrivateCandidateDto } from './private-candidate.util';

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

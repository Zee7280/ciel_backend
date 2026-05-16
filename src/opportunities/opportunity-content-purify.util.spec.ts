import {
    purifyActivityDetailsPayload,
    purifyObjectivesPayload,
    purifyOpportunityMultilineText,
    purifyStudentOpportunityContent,
} from './opportunity-content-purify.util';

describe('opportunity-content-purify.util', () => {
    it('normalizes line endings and excessive blank lines', () => {
        const raw = 'Line one\r\n\r\n\r\n\r\nLine two\t\ttab';
        expect(purifyOpportunityMultilineText(raw)).toBe('Line one\n\n\nLine two tab');
    });

    it('purifies objectives and activity_details on dto', () => {
        const dto = {
            title: '  UpliftED  ',
            objectives: { description: '1-Goal\r\n\r\n\r\n\r\n2-Next' },
            activity_details: { student_responsibilities: 'Plan\r\n\r\n\r\n\r\nEnd', skills_gained: [' Teaching '] },
        };
        purifyStudentOpportunityContent(dto);
        expect(dto.title).toBe('UpliftED');
        expect((dto.objectives as { description: string }).description).toContain('1-Goal');
        expect((dto.activity_details as { student_responsibilities: string }).student_responsibilities).toBe(
            'Plan\n\n\nEnd',
        );
        expect((dto.activity_details as { skills_gained: string[] }).skills_gained).toEqual(['Teaching']);
    });

    it('returns undefined for invalid payloads', () => {
        expect(purifyObjectivesPayload(null)).toBeUndefined();
        expect(purifyActivityDetailsPayload([])).toBeUndefined();
    });
});

/**
 * Normalize free-text fields before persisting student opportunity submissions.
 * Does not change workflow fields or shorten content beyond existing max-length validation.
 */

export function purifyOpportunityMultilineText(input: unknown): string {
    if (typeof input !== 'string') return '';
    let text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Strip control characters except newline/tab.
    text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    text = text.replace(/\t/g, ' ');
    text = text.replace(/[ \t]+\n/g, '\n');
    text = text.replace(/\n{4,}/g, '\n\n\n');
    text = text.replace(/ {2,}/g, ' ');
    return text.trim();
}

export function purifyObjectivesPayload(
    objectives: unknown,
): Record<string, unknown> | undefined {
    if (!objectives || typeof objectives !== 'object' || Array.isArray(objectives)) {
        return undefined;
    }
    const src = objectives as Record<string, unknown>;
    const next: Record<string, unknown> = { ...src };
    if (typeof src.description === 'string') {
        next.description = purifyOpportunityMultilineText(src.description);
    }
    if (Array.isArray(src.beneficiaries_type)) {
        next.beneficiaries_type = src.beneficiaries_type
            .map((x) => (typeof x === 'string' ? x.trim() : x))
            .filter((x) => typeof x === 'string' && x.length > 0);
    }
    return next;
}

export function purifyActivityDetailsPayload(
    activity: unknown,
): Record<string, unknown> | undefined {
    if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
        return undefined;
    }
    const src = activity as Record<string, unknown>;
    const next: Record<string, unknown> = { ...src };
    if (typeof src.student_responsibilities === 'string') {
        next.student_responsibilities = purifyOpportunityMultilineText(src.student_responsibilities);
    }
    if (Array.isArray(src.skills_gained)) {
        next.skills_gained = src.skills_gained
            .map((x) => (typeof x === 'string' ? x.trim() : ''))
            .filter((x) => x.length > 0);
    }
    return next;
}

type PurifiableOpportunityPayload = {
    title?: string;
    objectives?: unknown;
    activity_details?: unknown;
};

/** Apply text purification to student create/update DTO payloads (mutates in place). */
export function purifyStudentOpportunityContent(dto: PurifiableOpportunityPayload): void {
    if (dto.objectives !== undefined) {
        const purified = purifyObjectivesPayload(dto.objectives);
        if (purified) dto.objectives = purified;
    }
    if (dto.activity_details !== undefined) {
        const purified = purifyActivityDetailsPayload(dto.activity_details);
        if (purified) dto.activity_details = purified;
    }
    if (typeof dto.title === 'string') {
        dto.title = dto.title.replace(/\s+/g, ' ').trim();
    }
}

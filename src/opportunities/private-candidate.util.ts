/** Student-created opportunity using the Private / Independent Candidate pathway (no faculty gate). */
export function isPrivateCandidateDto(dto: {
    executing_context?: unknown;
    supervision?: unknown;
}): boolean {
    const ex = dto.executing_context;
    if (ex && typeof ex === 'object') {
        const o = ex as Record<string, unknown>;
        if (o.student_pathway === 'private') return true;
        if (o.private_candidate && typeof o.private_candidate === 'object') return true;
    }
    const sup = dto.supervision;
    if (sup && typeof sup === 'object' && (sup as Record<string, unknown>).private_candidate === true) {
        return true;
    }
    return false;
}

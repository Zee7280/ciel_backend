/** Deterministic community-service award model — same 5 criteria for every stakeholder. */

export const COMMUNITY_AWARD_CRITERIA = [
    { key: 'cii', max: 40, title: 'Composite Impact Index (CII v8.2)' },
    { key: 'quality', max: 20, title: 'Quality & depth of execution' },
    { key: 'evidence', max: 15, title: 'Evidence integrity' },
    { key: 'outcome', max: 15, title: 'Measured community outcome' },
    { key: 'sustain', max: 10, title: 'Sustainability & partnership' },
] as const;

export type CommunityAwardKind = 'fac' | 'par' | 'uni' | 'ciel';

export type CommunityAwardInputs = {
    cii: number | null;
    hours: number;
    sessions: number;
    evidenceCount: number;
    hasBaseline: boolean;
    hasEndline: boolean;
    hasMeasuredChange: boolean;
    continuation: 'yes' | 'partially' | 'no' | '';
    partnerCount: number;
};

export function clampScore(n: number, max: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(max, Math.round(n)));
}

export function readCii(section11: Record<string, unknown> | null | undefined): number | null {
    if (!section11) return null;
    const read = (value: unknown): number | null => {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.min(100, Math.max(0, Math.round(value)));
        if (typeof value === 'string') {
            const match = value.trim().match(/\d+(?:\.\d+)?/);
            if (!match) return null;
            const parsed = Number(match[0]);
            return Number.isFinite(parsed) ? Math.min(100, Math.max(0, Math.round(parsed))) : null;
        }
        return null;
    };
    const cii = section11.cii_index as Record<string, unknown> | undefined;
    return (
        read(cii?.totalScore) ??
        read(cii?.total_score) ??
        read(cii?.score) ??
        read(section11.ai_generated_impact_score) ??
        read(section11.cii_score)
    );
}

export function countMedia(sections: Array<{ media_urls?: unknown } | null | undefined>): number {
    let n = 0;
    for (const s of sections) {
        if (Array.isArray(s?.media_urls)) n += s!.media_urls.filter(Boolean).length;
    }
    return n;
}

export function scoreCommunityAward(input: CommunityAwardInputs): { pts: number[]; total: number } {
    const cii = input.cii ?? 0;
    const pts = [
        clampScore((cii / 100) * 40, 40),
        clampScore(
            (input.hours >= 40 ? 12 : input.hours >= 20 ? 9 : input.hours >= 8 ? 6 : 3) +
                (input.sessions >= 8 ? 8 : input.sessions >= 4 ? 5 : 2),
            20,
        ),
        clampScore(input.evidenceCount >= 6 ? 15 : input.evidenceCount >= 4 ? 12 : input.evidenceCount >= 2 ? 9 : input.evidenceCount >= 1 ? 6 : 2, 15),
        clampScore(
            (input.hasBaseline ? 5 : 0) + (input.hasEndline ? 5 : 0) + (input.hasMeasuredChange ? 5 : 0),
            15,
        ),
        clampScore(
            (input.continuation === 'yes' ? 6 : input.continuation === 'partially' ? 4 : 1) +
                (input.partnerCount >= 1 ? 4 : 0),
            10,
        ),
    ];
    return { pts, total: pts.reduce((a, b) => a + b, 0) };
}

export type CommunityServiceLevel = 'Transformative' | 'Distinguished' | 'Strong' | 'Developing';

/** A standing score-band grade shown on every approved report regardless of ranking — distinct
 * from awardBadgeLabel above, which only fires when a report is explicitly picked as a top-N
 * award winner. "Developing & Below" is a display-only wrapper for the 'Developing' value. */
export function communityServiceLevel(total: number): CommunityServiceLevel {
    if (total >= 85) return 'Transformative';
    if (total >= 70) return 'Distinguished';
    if (total >= 50) return 'Strong';
    return 'Developing';
}

export function awardBadgeLabel(kind: CommunityAwardKind, scope: string) {
    if (kind === 'fac') return `Faculty Choice — ${scope}`;
    if (kind === 'par') return `Partner’s Best Project — ${scope}`;
    if (kind === 'uni') return `${scope} Community Honour`;
    return 'CIEL PK National Community Medal';
}

export function awardTopN(kind: CommunityAwardKind) {
    return kind === 'par' || kind === 'fac' ? 1 : 3;
}

const LIVE_STATUS = new Set(['approved', 'verified']);
const BLOCKED_STATUS = new Set(['draft', 'rejected', 'declined']);

/**
 * Live deck = faculty or admin actually signed off.
 * Hours and “paid” (reporting fee) must not skip the waiting inbox —
 * a submitted report with attendance still needs approval.
 */
export function isCommunityAwardLiveReport(input: {
    status?: string | null;
    faculty_status?: string | null;
    hours?: number | null;
}): boolean {
    const overall = String(input.status || '').trim().toLowerCase();
    const faculty = String(input.faculty_status || '').trim().toLowerCase();
    if (BLOCKED_STATUS.has(overall) || BLOCKED_STATUS.has(faculty)) return false;
    return LIVE_STATUS.has(faculty) || LIVE_STATUS.has(overall);
}

/** Medal / approved-opportunities vault — both faculty and admin must have signed off. */
export function isCommunityAwardMedalReport(input: {
    status?: string | null;
    faculty_status?: string | null;
    admin_status?: string | null;
}): boolean {
    const overall = String(input.status || '').trim().toLowerCase();
    const faculty = String(input.faculty_status || '').trim().toLowerCase();
    const admin = String(input.admin_status || '').trim().toLowerCase();
    if (BLOCKED_STATUS.has(overall) || BLOCKED_STATUS.has(faculty) || BLOCKED_STATUS.has(admin)) return false;
    return LIVE_STATUS.has(faculty) && (LIVE_STATUS.has(admin) || LIVE_STATUS.has(overall));
}

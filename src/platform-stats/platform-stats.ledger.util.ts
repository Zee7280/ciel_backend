/** PKR value of one verified volunteer hour in the public community-dividend formula. */
export const DIVIDEND_HOURLY_RATE_PKR = 192;

/** Credit a (project, student) pair once so duplicate verified reports cannot inflate the ledger. */
export function creditPairOnce(pairKey: string, seen: Set<string>): boolean {
    if (!pairKey || seen.has(pairKey)) return false;
    seen.add(pairKey);
    return true;
}

/** Identity for a person on a submitted-report roster (participation row or reporting student). */
export function servingMemberKey(member: {
    studentId?: string | null;
    email?: string | null;
    id?: string | null;
}): string {
    const studentId = typeof member.studentId === 'string' ? member.studentId.trim() : '';
    if (studentId) return `sid:${studentId}`;
    const email = typeof member.email === 'string' ? member.email.trim().toLowerCase() : '';
    if (email) return `email:${email}`;
    const id = typeof member.id === 'string' ? member.id.trim() : '';
    if (id) return `id:${id}`;
    return '';
}

/** People serving = sum of unique members on each unique project that has a credited report. */
export function sumPeopleServing(projectRosterSizes: Iterable<number>): number {
    let n = 0;
    for (const size of projectRosterSizes) n += Math.max(size, 1);
    return n;
}

/** Project-level totals (beneficiaries, PKR) must not be summed once per teammate. Keep the larger figure. */
export type ProjectLevelImpact = {
    beneficiaries: number;
    deployed: number;
    outOfPocket: number;
};

export function mergeProjectLevelImpact(
    current: ProjectLevelImpact | undefined,
    next: ProjectLevelImpact,
): ProjectLevelImpact {
    if (!current) return { ...next };
    return {
        beneficiaries: Math.max(current.beneficiaries, next.beneficiaries),
        deployed: Math.max(current.deployed, next.deployed),
        outOfPocket: Math.max(current.outOfPocket, next.outOfPocket),
    };
}

export function sumProjectLevelImpact(
    items: Iterable<ProjectLevelImpact>,
): ProjectLevelImpact {
    let beneficiaries = 0;
    let deployed = 0;
    let outOfPocket = 0;
    for (const i of items) {
        beneficiaries += i.beneficiaries;
        deployed += i.deployed;
        outOfPocket += i.outOfPocket;
    }
    return { beneficiaries, deployed, outOfPocket };
}

/** Hours stored on the student report (Section 1) — not attendance-log rollups. */
export function hoursFromReportSection1(section1: unknown): number {
    const s = section1 as
        | {
              metrics?: { total_verified_hours?: unknown };
              attendance_logs?: { hours?: unknown }[];
              team_lead?: { hours?: unknown };
          }
        | undefined;
    const fromMetrics = Number(s?.metrics?.total_verified_hours);
    if (Number.isFinite(fromMetrics) && fromMetrics > 0) return fromMetrics;
    let fromLogs = 0;
    if (Array.isArray(s?.attendance_logs)) {
        for (const log of s.attendance_logs) {
            const h = Number(log?.hours);
            if (Number.isFinite(h) && h > 0) fromLogs += h;
        }
    }
    if (fromLogs > 0) return fromLogs;
    const leadHours = Number(s?.team_lead?.hours);
    return Number.isFinite(leadHours) && leadHours > 0 ? leadHours : 0;
}

/** Team size written on the report: lead + listed members. Always at least the submitting student. */
export function membersFromReportSection1(section1: unknown, studentId?: string | null): number {
    const s = section1 as
        | {
              team_member_count?: unknown;
              participation_type?: unknown;
              team_lead?: { email?: unknown; name?: unknown; cnic?: unknown };
              team_members?: Array<{ email?: unknown; name?: unknown; cnic?: unknown }>;
          }
        | undefined;
    const storedCount = Number(s?.team_member_count);
    if (Number.isFinite(storedCount) && storedCount > 0) return Math.floor(storedCount);

    const keys = new Set<string>();
    const add = (member: { studentId?: string | null; email?: unknown; name?: unknown; cnic?: unknown; id?: string | null }) => {
        const key = servingMemberKey({
            studentId: member.studentId,
            email: typeof member.email === 'string' ? member.email : null,
            id:
                (typeof member.cnic === 'string' && member.cnic.trim()) ||
                (typeof member.name === 'string' && member.name.trim()) ||
                member.id ||
                null,
        });
        if (key) keys.add(key);
    };
    if (s?.team_lead) add(s.team_lead);
    if (Array.isArray(s?.team_members)) {
        for (const m of s.team_members) {
            if (m) add(m);
        }
    }
    if (keys.size === 0 && studentId) add({ studentId });
    return Math.max(keys.size, 1);
}

export function communityDividendPkr(
    hours: number,
    outOfPocketPkr: number,
    rate = DIVIDEND_HOURLY_RATE_PKR,
): number {
    return Math.round(hours) * rate + Math.round(outOfPocketPkr);
}

export function beneficiariesFromSection4(section4: unknown): number {
    const s = section4 as
        | {
              project_summary?: { distinct_total_beneficiaries?: unknown };
              distinct_total_beneficiaries?: unknown;
              total_beneficiaries?: unknown;
              my_beneficiaries?: unknown;
          }
        | undefined;
    return (
        toBeneficiaryCount(s?.project_summary?.distinct_total_beneficiaries) ||
        toBeneficiaryCount(s?.distinct_total_beneficiaries) ||
        toBeneficiaryCount(s?.total_beneficiaries) ||
        toBeneficiaryCount(s?.my_beneficiaries)
    );
}

export function pkrFromResources(
    resources: { unit?: unknown; amount?: unknown; source?: unknown }[] | undefined,
): { deployed: number; outOfPocket: number } {
    let deployed = 0;
    let outOfPocket = 0;
    if (!Array.isArray(resources)) return { deployed, outOfPocket };
    for (const r of resources) {
        if (!isPkrResourceUnit(r?.unit)) continue;
        const amt = Number(r?.amount);
        if (!Number.isFinite(amt) || amt <= 0) continue;
        if (isSelfFundedSource(r?.source)) outOfPocket += amt;
        else deployed += amt;
    }
    return { deployed, outOfPocket };
}

function toBeneficiaryCount(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isPkrResourceUnit(unit: unknown): boolean {
    if (typeof unit !== 'string') return false;
    const u = unit.trim();
    if (!u || /\bhours?\b|\bhrs\b/i.test(u)) return false;
    return /\bpkr\b|\brs\.?\b|rupees?|\bcash\b|financial/i.test(u);
}

function isSelfFundedSource(source: unknown): boolean {
    return (
        typeof source === 'string' &&
        /self|own|personal|out.?of.?pocket|student/i.test(source)
    );
}

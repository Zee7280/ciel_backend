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
    resources: { type?: unknown; unit?: unknown; amount?: unknown; source?: unknown }[] | undefined,
): { deployed: number; outOfPocket: number } {
    let deployed = 0;
    let outOfPocket = 0;
    if (!Array.isArray(resources)) return { deployed, outOfPocket };
    for (const r of resources) {
        if (!isCashResource(r)) continue;
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

/** Homepage "Resources deployed" is cash only — in-kind / materials / hours / kits are excluded. */
function isCashResource(r: { type?: unknown; unit?: unknown }): boolean {
    const type = typeof r.type === 'string' ? r.type.trim() : '';
    const unit = typeof r.unit === 'string' ? r.unit.trim() : '';
    if (isInKindOrNonCashType(type)) return false;
    if (
        unit &&
        /\bhours?\b|\bhrs\b|kits?|devices?|sessions?|licenses?|\bkg\b|liters?/i.test(unit) &&
        !isPkrResourceUnit(unit)
    ) {
        return false;
    }
    if (/financial|cash funding|\bcash\b/i.test(type)) return true;
    return isPkrResourceUnit(unit);
}

function isInKindOrNonCashType(type: string): boolean {
    if (!type) return false;
    return /in.?kind|materials|food \/ books|supplies|equipment|tools|infrastructure|venue|human resources|trainers|transport support|energy \/ utility|communication \/ media|policy \/ legal|research \/ data|community mobilization/i.test(
        type,
    );
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

/** Placeholder orgs on student-created listings are not partner organisations. */
export function isPlaceholderPartnerOrg(
    org:
        | {
              verificationStatus?: string | null;
              orgType?: string | null;
              name?: string | null;
          }
        | null
        | undefined,
): boolean {
    if (!org) return true;
    if (org.verificationStatus === 'unclaimed_student_initiated') return true;
    const name = String(org.name || '').trim();
    if (/^student opportunity\b/i.test(name)) return true;
    const t = String(org.orgType || '')
        .trim()
        .toLowerCase();
    return t === 'university' || t === 'other';
}

export function partnerNamesFromSection7(section7: unknown): string[] {
    const s = section7 as { partners?: { name?: unknown }[] } | undefined;
    if (!Array.isArray(s?.partners)) return [];
    const out: string[] = [];
    for (const p of s.partners) {
        const name = typeof p?.name === 'string' ? p.name.trim() : '';
        if (name && !/^student opportunity\b/i.test(name)) out.push(name);
    }
    return out;
}

export function normalizePartnerKey(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

const SDG_GOAL_KEYS = [
    'goal_number',
    'goalNumber',
    'sdg_id',
    'sdgId',
    'sdg_number',
    'sdgNumber',
    'sdg',
    'number',
] as const;

/** Parse a UN SDG goal (1–17). Accepts 4, "04", "SDG 6", and report/opportunity objects. */
export function parseSdgGoalNumber(raw: unknown): number | null {
    if (raw == null) return null;
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return null;
        const n = Math.trunc(raw);
        return n >= 1 && n <= 17 ? n : null;
    }
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t || /^sdg$/i.test(t)) return null;
        const m = t.match(/(?:sdg\s*)?(\d{1,2})/i);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        return n >= 1 && n <= 17 ? n : null;
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        const rec = raw as Record<string, unknown>;
        for (const key of SDG_GOAL_KEYS) {
            const n = parseSdgGoalNumber(rec[key]);
            if (n) return n;
        }
    }
    return null;
}

function isRejectedSdgStatus(status: unknown): boolean {
    return String(status ?? '')
        .trim()
        .toLowerCase() === 'rejected';
}

function secondarySdgHasEvidence(row: Record<string, unknown>): boolean {
    const status = String(row.status ?? '')
        .trim()
        .toLowerCase();
    if (status === 'validated') return true;
    const justification = String(
        row.justification_text ?? row.justification ?? '',
    ).trim();
    return justification.length >= 30;
}

function secondaryRowsFromSection3(section3: Record<string, unknown> | undefined): unknown[] {
    if (!section3) return [];
    if (Array.isArray(section3.secondary_sdgs)) return section3.secondary_sdgs;
    if (Array.isArray(section3.sdgs)) return section3.sdgs;
    return [];
}

export type VerifiedReportSdgInput = {
    primary_sdg_goal?: unknown;
    section3?: unknown;
    opportunity?: {
        sdg?: unknown;
        sdg_info?: unknown;
    } | null;
};

/**
 * SDGs a verified Community Service report may claim on the public ledger.
 * Primary always counts. Secondaries count only when they are not rejected and
 * have real evidence (`validated` or a ≥30-char justification). Listing tags on
 * the opportunity are a last-resort primary fallback when the report stored none.
 */
export function sdgsFromVerifiedReport(report: VerifiedReportSdgInput): number[] {
    const out = new Set<number>();
    const section3 =
        report.section3 && typeof report.section3 === 'object' && !Array.isArray(report.section3)
            ? (report.section3 as Record<string, unknown>)
            : undefined;

    const primary =
        parseSdgGoalNumber(report.primary_sdg_goal) ??
        parseSdgGoalNumber(section3?.primary_sdg);
    if (primary) out.add(primary);

    let secondaryCount = 0;
    for (const raw of secondaryRowsFromSection3(section3)) {
        if (secondaryCount >= 2) break;
        const row =
            raw && typeof raw === 'object' && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : null;
        if (row && isRejectedSdgStatus(row.status)) continue;
        const n = parseSdgGoalNumber(raw);
        if (!n || n === primary) continue;
        if (row && !secondarySdgHasEvidence(row)) continue;
        if (!row) continue;
        out.add(n);
        secondaryCount += 1;
    }

    if (out.size === 0 && report.opportunity) {
        const fromListing =
            parseSdgGoalNumber(report.opportunity.sdg_info) ??
            parseSdgGoalNumber(report.opportunity.sdg);
        if (fromListing) out.add(fromListing);
    }

    return [...out].sort((a, b) => a - b);
}

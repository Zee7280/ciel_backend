import type { ReportCIIauditMeta } from './parse-cii-audit-summary.util';

export type Section11RedFlag = {
    code?: string;
    description?: string;
    deduction?: number;
};

export type Section11ScoreBreakdown = {
    section_wise?: Record<
        string,
        { raw_score?: number; max?: number; weighted_contribution?: number }
    >;
    subtotal_before_bonuses_penalties?: number;
    bonuses_applied?: {
        donor_tier?: number;
        partnership?: number;
        scale?: number;
        total?: number;
    };
    subtotal_after_bonuses?: number;
    red_flag_deductions_itemised?: Section11RedFlag[];
    red_flag_total?: number;
    red_flag_cap_applied?: boolean;
    subtotal_after_red_flags?: number;
    ias_cap_applied?: number;
    final_cii?: number;
    level?: number;
    level_label?: string;
    certificate_line?: string;
};

export type Section11V61Evaluation = {
    evaluation_version?: string;
    cii?: number;
    level?: number;
    level_label?: string;
    certificate_line?: string;
    hec_compliant?: boolean;
    score_breakdown?: Section11ScoreBreakdown;
    narrative?: {
        executive_verdict?: string;
        section_summaries?: Record<string, string>;
        lift_criteria?: string[];
        concerns?: unknown[];
        final_decision?: string;
    };
    section_scores?: Record<
        string,
        {
            raw?: number;
            max?: number;
            notes?: string;
            donor_tier?: string;
            red_flags?: Section11RedFlag[];
        }
    >;
    penalties?: {
        red_flag_total?: number;
        red_flag_cap_applied?: boolean;
        red_flag_count?: number;
        red_flag_by_section?: Record<string, number>;
        cross_section_audit_total?: number;
        checks?: unknown[];
    };
    ias?: {
        score?: number;
        cii_cap_applied?: number;
        flags?: Array<{ flag?: string; deduction?: number }>;
    };
    eis?: { score?: number; category?: string };
};

const SECTION_TITLES: Record<number, string> = {
    1: "Identity, Team Setup, Attendance Integrity",
    2: "Project Context & Academic Discipline",
    3: "SDG Contribution Mapping",
    4: "Activities, Outputs & Scale",
    5: "Outcomes & Results",
    6: "Resources & Implementation Support",
    7: "Partnerships & Collaboration",
    8: "Evidence & Verification",
    9: "Reflection & Competencies",
    10: "Sustainability & Continuation",
};

const LEVEL_RANGES: Record<number, string> = {
    7: "92–100",
    6: "84–91",
    5: "75–83",
    4: "67–74",
    3: "58–66",
    2: "48–57",
    1: "0–47",
};

export function extractSection11JsonObject(raw: string): unknown | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            try {
                return JSON.parse(fenced[1].trim()) as unknown;
            } catch {
                /* fall through */
            }
        }

        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
            } catch {
                return null;
            }
        }
    }

    return null;
}

export function isSection11V61Evaluation(value: unknown): value is Section11V61Evaluation {
    if (!value || typeof value !== "object") return false;
    const v = value as Section11V61Evaluation;
    const version = String(v.evaluation_version || "").toLowerCase();
    return (
        version === "v6.1" ||
        version === "v6.2" ||
        version === "v6.3" ||
        version === "v6.4" ||
        version.startsWith("v6.") ||
        (typeof v.cii === "number" &&
            typeof v.level === "number" &&
            Boolean(v.narrative?.executive_verdict))
    );
}

function evaluationVersionLabel(evalData: Section11V61Evaluation): string {
    return String(evalData.evaluation_version || "v6.1").trim() || "v6.1";
}

function usesSoftIasCapTable(version: string): boolean {
    return (
        version === "v6.2" ||
        version === "v6.3" ||
        version === "v6.4" ||
        version.startsWith("v6.2") ||
        version.startsWith("v6.3") ||
        version.startsWith("v6.4")
    );
}

function redFlagCapForVersion(version: string): number {
    if (version === "v6.4" || version.startsWith("v6.4")) return 5;
    return 10;
}

function redFlagMagnitudeThresholds(version: string): { critical: number; moderate: number } {
    if (version === "v6.4" || version.startsWith("v6.4")) {
        return { critical: 0.75, moderate: 0.25 };
    }
    return { critical: 1.5, moderate: 0.5 };
}

function collectSectionRedFlags(evalData: Section11V61Evaluation): Section11RedFlag[] {
    const flags: Section11RedFlag[] = [];
    const itemised = evalData.score_breakdown?.red_flag_deductions_itemised;
    if (Array.isArray(itemised) && itemised.length) {
        for (const flag of itemised) {
            if (!flag || typeof flag !== "object") continue;
            const description = String(flag.description || "").trim();
            const code = String(flag.code || "").trim();
            if (!description && !code) continue;
            flags.push(flag);
        }
        if (flags.length) return flags;
    }

    const scores = evalData.section_scores || {};
    for (const row of Object.values(scores)) {
        if (!row || !Array.isArray(row.red_flags)) continue;
        for (const flag of row.red_flags) {
            if (!flag || typeof flag !== "object") continue;
            const description = String(flag.description || "").trim();
            const code = String(flag.code || "").trim();
            if (!description && !code) continue;
            flags.push(flag);
        }
    }
    return flags;
}

function formatSectionRedFlags(flags: Section11RedFlag[]): string | null {
    if (!flags.length) return null;
    return flags
        .map((flag) => {
            const code = flag.code ? `${flag.code}: ` : "";
            const deduction =
                typeof flag.deduction === "number" ? ` (${flag.deduction})` : "";
            return `${code}${flag.description || "Red flag"}${deduction}`.trim();
        })
        .join("\n");
}

function formatScoreBreakdownBlock(breakdown: Section11ScoreBreakdown): string | null {
    const lines: string[] = ["Component — Score Breakdown"];
    const sectionWise = breakdown.section_wise || {};

    for (let n = 1; n <= 10; n++) {
        const key = `section_${n}`;
        const row = sectionWise[key];
        if (!row || typeof row.weighted_contribution !== "number") continue;
        const raw = typeof row.raw_score === "number" ? row.raw_score : "—";
        const max = typeof row.max === "number" ? row.max : "—";
        lines.push(`Section ${n}: ${raw}/${max} → weighted ${row.weighted_contribution}`);
    }

    if (typeof breakdown.subtotal_before_bonuses_penalties === "number") {
        lines.push(`Subtotal (sections): ${breakdown.subtotal_before_bonuses_penalties}`);
    }

    const bonusTotal = breakdown.bonuses_applied?.total;
    if (typeof bonusTotal === "number" && bonusTotal !== 0) {
        lines.push(`Bonuses applied: +${bonusTotal}`);
    }

    if (typeof breakdown.subtotal_after_bonuses === "number") {
        lines.push(`After bonuses: ${breakdown.subtotal_after_bonuses}`);
    }

    const itemised = breakdown.red_flag_deductions_itemised || [];
    if (itemised.length) {
        lines.push("Red flag deductions:");
        for (const flag of itemised) {
            const code = flag.code ? `${flag.code} ` : "";
            const deduction = typeof flag.deduction === "number" ? ` (${flag.deduction})` : "";
            lines.push(`  ${code}${flag.description || "Red flag"}${deduction}`.trim());
        }
    }

    if (typeof breakdown.red_flag_total === "number" && breakdown.red_flag_total !== 0) {
        lines.push(
            `Red flag total: ${breakdown.red_flag_total}${
                breakdown.red_flag_cap_applied ? " (cap applied)" : ""
            }`,
        );
    }

    if (typeof breakdown.subtotal_after_red_flags === "number") {
        lines.push(`After red flags: ${breakdown.subtotal_after_red_flags}`);
    }

    if (typeof breakdown.final_cii === "number") {
        lines.push(`Final CII: ${breakdown.final_cii}`);
    }

    return lines.length > 1 ? lines.join("\n") : null;
}

function resolveRedFlagTotal(evalData: Section11V61Evaluation): number | undefined {
    const fromPenalties = evalData.penalties?.red_flag_total;
    const fromBreakdown = evalData.score_breakdown?.red_flag_total;
    if (typeof fromPenalties === "number") return fromPenalties;
    if (typeof fromBreakdown === "number") return fromBreakdown;
    return undefined;
}

function redFlagCapWasApplied(evalData: Section11V61Evaluation): boolean {
    return Boolean(
        evalData.penalties?.red_flag_cap_applied || evalData.score_breakdown?.red_flag_cap_applied,
    );
}

function bucketRedFlags(flags: Section11RedFlag[], version: string): {
    critical: string | null;
    moderate: string | null;
    minor: string | null;
} {
    if (!flags.length) {
        return { critical: null, moderate: null, minor: null };
    }

    const { critical: criticalAt, moderate: moderateAt } = redFlagMagnitudeThresholds(version);
    const critical: string[] = [];
    const moderate: string[] = [];
    const minor: string[] = [];

    for (const flag of flags) {
        const line = formatSectionRedFlags([flag]);
        if (!line) continue;
        const magnitude = Math.abs(typeof flag.deduction === "number" ? flag.deduction : 0);
        if (magnitude >= criticalAt || /^R1\.2\b/.test(String(flag.code || ""))) {
            critical.push(line);
        } else if (magnitude >= moderateAt) {
            moderate.push(line);
        } else {
            minor.push(line);
        }
    }

    return {
        critical: critical.length ? critical.join("\n") : null,
        moderate: moderate.length ? moderate.join("\n") : null,
        minor: minor.length ? minor.join("\n") : null,
    };
}

function levelRange(level: number | undefined): string {
    if (!level || !LEVEL_RANGES[level]) return "";
    return LEVEL_RANGES[level];
}

function deriveRecommendedAction(evalData: Section11V61Evaluation): string {
    const level = evalData.level ?? 0;
    const concerns = evalData.narrative?.concerns?.length ?? 0;
    const iasCap = evalData.ias?.cii_cap_applied;
    const version = evaluationVersionLabel(evalData);
    const softCaps = usesSoftIasCapTable(version);

    if (level <= 1 || evalData.hec_compliant === false) return "Revision Requested";

    if (typeof iasCap === "number" && iasCap < 100) {
        if (softCaps) {
            if (iasCap <= 59) return "Escalate for Manual Review";
            if (iasCap <= 69) return "Major Deduction Recommended";
            if (iasCap <= 79) return "Partial Deduction Recommended";
        } else {
            if (iasCap <= 39) return "Escalate for Manual Review";
            if (iasCap <= 49) return "Major Deduction Recommended";
            if (iasCap <= 69) return "Partial Deduction Recommended";
        }
    }

    const redFlagTotal = evalData.penalties?.red_flag_total ?? evalData.score_breakdown?.red_flag_total;
    const cap = redFlagCapForVersion(version);
    if (typeof redFlagTotal === "number" && redFlagTotal <= -(cap * 0.8)) return "Partial Deduction Recommended";
    if (typeof redFlagTotal === "number" && redFlagTotal <= -(cap * 0.4)) return "Accepted with Observation";
    if (concerns > 0) return "Accepted with Observation";
    return "Fully Accepted";
}

function formatConcerns(concerns: unknown[] | undefined): {
    critical: string | null;
    moderate: string | null;
    minor: string | null;
} {
    if (!concerns?.length) {
        return { critical: null, moderate: null, minor: null };
    }

    const critical: string[] = [];
    const moderate: string[] = [];
    const minor: string[] = [];
    const other: string[] = [];

    for (const item of concerns) {
        if (typeof item === "string") {
            const text = item.trim();
            if (!text) continue;
            if (/^critical\b/i.test(text)) critical.push(text);
            else if (/^moderate\b/i.test(text)) moderate.push(text);
            else if (/^minor\b/i.test(text)) minor.push(text);
            else other.push(text);
            continue;
        }

        if (item && typeof item === "object") {
            const row = item as { severity?: string; message?: string; concern?: string; rationale?: string };
            const text = String(row.message || row.concern || row.rationale || "").trim();
            if (!text) continue;
            const sev = String(row.severity || "").toLowerCase();
            if (sev.includes("critical") || sev.includes("severe")) critical.push(text);
            else if (sev.includes("moderate") || sev.includes("material") || sev.includes("significant")) {
                moderate.push(text);
            } else if (sev.includes("minor")) minor.push(text);
            else other.push(text);
        }
    }

    if (other.length && !critical.length && !moderate.length && !minor.length) {
        moderate.push(...other);
    }

    return {
        critical: critical.length ? critical.join("\n") : null,
        moderate: moderate.length ? moderate.join("\n") : null,
        minor: minor.length ? minor.join("\n") : null,
    };
}

/**
 * Converts v6.1 JSON into the legacy plain-text audit shape used across the app
 * (summary page, print dossier, red-flags modal, audit_meta parsers).
 */
export function formatSection11V61AsSummaryText(evalData: Section11V61Evaluation): string {
    const cii = typeof evalData.cii === "number" ? Math.round(evalData.cii) : 0;
    const level = evalData.level ?? 0;
    const levelLabel = evalData.level_label || "Participation Acknowledgement";
    const range = levelRange(level);
    const donorTier = evalData.section_scores?.section_6?.donor_tier;
    const version = evaluationVersionLabel(evalData);
    const redFlagTotal = resolveRedFlagTotal(evalData);

    const coverLines = [
        `CII EVALUATION (${version})`,
        `FINAL CII SCORE   ${cii} / 100`,
        `BAND ACHIEVED     ${levelLabel}${range ? ` (${range})` : ""}`,
        donorTier ? `DONOR TIER        ${donorTier}` : null,
        typeof redFlagTotal === "number" && redFlagTotal !== 0
            ? `RED FLAG TOTAL    ${redFlagTotal}`
            : null,
        `RECOMMENDED       ${deriveRecommendedAction(evalData)}`,
    ].filter(Boolean);

    const parts: string[] = [coverLines.join("\n")];

    const executive = evalData.narrative?.executive_verdict?.trim();
    if (executive) {
        parts.push(`Component 2 — Executive Verdict\n${executive}`);
    }

    const scoreBreakdownText = evalData.score_breakdown
        ? formatScoreBreakdownBlock(evalData.score_breakdown)
        : null;
    if (scoreBreakdownText) {
        parts.push(scoreBreakdownText);
    }

    const summaries = evalData.narrative?.section_summaries || {};
    for (let n = 1; n <= 10; n++) {
        const key = `section_${n}`;
        const body = String(summaries[key] || "").trim();
        const scoreRow = evalData.section_scores?.[key];
        const sectionFlags = scoreRow?.red_flags || [];
        const redFlagsText = formatSectionRedFlags(sectionFlags);

        if (!body && !redFlagsText) continue;

        const scoreLine =
            scoreRow && typeof scoreRow.raw === "number" && typeof scoreRow.max === "number"
                ? `Score: ${scoreRow.raw} / ${scoreRow.max}`
                : "";

        parts.push(
            [
                `SECTION ${n} — ${SECTION_TITLES[n]}`,
                scoreLine,
                redFlagsText ? `Red Flags: ${redFlagsText.replace(/\n/g, "; ")}` : null,
                body ? `Feedback: ${body}` : null,
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    const lift = (evalData.narrative?.lift_criteria || []).map((c) => String(c || "").trim()).filter(Boolean);
    if (lift.length) {
        parts.push(
            `Component 8 — Top 5 Lift Criteria\n${lift.map((item, i) => `${i + 1}. ${item}`).join("\n")}`,
        );
    }

    const recommended = deriveRecommendedAction(evalData);
    const pathForward = lift.map((item, i) => `• ${i + 1}) ${item}`).join("\n");
    parts.push(
        [
            "Component 9 — Final Decision",
            `Recommended Action: ${recommended}`,
            `Current Band: ${levelLabel}${range ? ` (${range})` : ""} — score: ${cii} / 100`,
            pathForward ? `Path Forward:\n${pathForward}` : null,
        ]
            .filter(Boolean)
            .join("\n"),
    );

    const finalDecision = evalData.narrative?.final_decision?.trim();
    if (finalDecision) {
        parts.push(finalDecision);
    }

    if (evalData.certificate_line?.trim()) {
        parts.push(`Certificate line: ${evalData.certificate_line.trim()}`);
    }

    return parts.join("\n\n").trim();
}

export function section11V61ToAuditMeta(evalData: Section11V61Evaluation): ReportCIIauditMeta {
    const version = evaluationVersionLabel(evalData);
    const concernBuckets = formatConcerns(evalData.narrative?.concerns);
    const redFlagBuckets = bucketRedFlags(collectSectionRedFlags(evalData), version);
    const lift = (evalData.narrative?.lift_criteria || []).map((c) => String(c || "").trim()).filter(Boolean);
    const level = evalData.level ?? 0;
    const cii = typeof evalData.cii === "number" ? Math.round(evalData.cii) : null;
    const recommended = deriveRecommendedAction(evalData);
    const redFlagTotal = resolveRedFlagTotal(evalData);

    const iasNote =
        typeof evalData.ias?.score === "number"
            ? `Integrity audit score: ${evalData.ias.score}/100${
                  typeof evalData.ias.cii_cap_applied === "number"
                      ? ` (CII cap ${evalData.ias.cii_cap_applied})`
                      : ""
              }`
            : null;

    const eisNote =
        typeof evalData.eis?.score === "number"
            ? `Engagement intensity: ${evalData.eis.score}/100 (${evalData.eis.category || "—"})`
            : null;

    const redFlagNote =
        typeof redFlagTotal === "number" && redFlagTotal !== 0
            ? `Red flag deductions: ${redFlagTotal}${
                  redFlagCapWasApplied(evalData) ? " (cap applied)" : ""
              }`
            : null;

    const credibility = [iasNote, eisNote, redFlagNote].filter(Boolean).join(" · ") || null;

    const mergeText = (primary: string | null, secondary: string | null) => {
        if (primary && secondary) return `${primary}\n\n${secondary}`;
        return primary || secondary;
    };

    return {
        critical_red_flags: mergeText(redFlagBuckets.critical, concernBuckets.critical),
        moderate_issues: mergeText(redFlagBuckets.moderate, concernBuckets.moderate),
        minor_issues: mergeText(redFlagBuckets.minor, concernBuckets.minor),
        credibility,
        risk_level: recommended,
        top_fixes: lift.slice(0, 5),
        final_remark: [
            cii !== null ? `CII: ${cii}/100` : null,
            evalData.level_label ? `Level ${level} — ${evalData.level_label}` : null,
            redFlagNote,
            evalData.certificate_line?.trim() || null,
        ]
            .filter(Boolean)
            .join(" · "),
        student_feedback:
            level <= 1 || evalData.hec_compliant === false
                ? evalData.narrative?.final_decision?.trim() || null
                : null,
        needs_revision: level <= 1 || evalData.hec_compliant === false || recommended === "Revision Requested",
    };
}

export function parseSection11V61Response(raw: string): {
    evaluation: Section11V61Evaluation;
    summaryText: string;
    auditMeta: ReportCIIauditMeta;
} | null {
    const parsed = extractSection11JsonObject(raw);
    if (!isSection11V61Evaluation(parsed)) return null;

    return {
        evaluation: parsed,
        summaryText: formatSection11V61AsSummaryText(parsed),
        auditMeta: section11V61ToAuditMeta(parsed),
    };
}

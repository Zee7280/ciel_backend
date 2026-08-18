import type { ReportCIIauditMeta } from './parse-cii-audit-summary.util';
import { extractSection11JsonObject } from './parse-section11-v61.util';

export type Section11V81RedFlag = {
    code?: string;
    flag?: string;
    severity?: string;
    affected_section?: string;
    score_effect?: string;
    effect_on_score_or_readiness?: string;
    admin_note?: string;
};

export type Section11V81SectionScore = {
    section_number?: number;
    section_name?: string;
    weight?: number;
    anchor?: number;
    anchor_descriptor?: string;
    score?: number;
    final_section_score?: number;
    what_was_done?: string;
    appreciation?: string;
    strengths?: string;
    limitations?: string;
    evidence_commentary?: string;
    improvement_guidance?: string;
    student_facing_comment?: string;
};

export type Section11V81Evaluation = {
    framework_version?: string;
    student?: Record<string, unknown>;
    final_result?: {
        cii_score?: number;
        level?: number;
        badge_title?: string;
        certificate_line?: string;
        badge_readiness?: string;
        admin_review_required?: boolean;
        resubmission_required?: boolean;
        one_line_verdict?: string;
    };
    indices?: Record<string, unknown>;
    section_scores?: Section11V81SectionScore[];
    overall_strengths?: string[];
    overall_limitations?: string[];
    evidence_review?: Record<string, unknown>;
    resource_mobilization_review?: Record<string, unknown>;
    partnership_review?: Record<string, unknown>;
    cross_section_calibration?: Record<string, unknown>;
    comparative_benchmarking?: Record<string, unknown>;
    red_flags?: Section11V81RedFlag[];
    bonuses?: Array<Record<string, unknown>>;
    cii_calculation_trace?: Record<string, unknown>;
    student_facing_feedback?: {
        opening_praise?: string;
        summary?: string;
        encouragement?: string;
        five_actions?: string[];
    };
    student_feedback?: {
        opening_praise?: string;
        why_score_is_high_or_low?: string;
        encouragement?: string;
        five_specific_actions?: string[];
    };
    admin_facing_diagnostics?: {
        approval_recommendation?: string;
        manual_checks_needed?: string[];
        risk_summary?: string;
        notes?: string;
    };
    admin_diagnostics?: {
        approval_recommendation?: string;
        manual_checks_needed?: string[];
        risk_summary?: string;
        notes?: string;
    };
};

const SECTION_TITLES: Record<number, string> = {
    1: "Identity & Participation",
    2: "Project Context & Discipline",
    3: "SDG Strategy & Intent",
    4: "Activities & Output Scale",
    5: "Outcomes & Measurable Change",
    6: "Resource Mobilization",
    7: "Partnerships & Collaboration",
    8: "Evidence & Verification",
    9: "Personal & Academic Reflection",
    10: "Sustainability & Continuation",
};

function pickString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function pickNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

export function isSection11V81Evaluation(value: unknown): value is Section11V81Evaluation {
    if (!value || typeof value !== "object") return false;
    const v = value as Section11V81Evaluation;
    const version = pickString(v.framework_version).toLowerCase();
    if (version === "v1.2") return true;
    if (version === "v8.2" || version === "v8.1" || version.startsWith("v8.")) return true;
    if (v.final_result && typeof v.final_result.cii_score === "number") return true;
    if (Array.isArray(v.section_scores) && v.section_scores.length > 0 && v.student_feedback) return true;
    return false;
}

export const CII_PLATFORM_MAX = 100;
export const CII_MASTER_BONUS_MAX = 5;

export function clampPlatformCiiScore(score: number): number {
    return Math.min(CII_PLATFORM_MAX, Math.max(0, Math.round(score * 10) / 10));
}

function resolveFrameworkVersion(evalData: Section11V81Evaluation): string {
    const version = pickString(evalData.framework_version);
    if (version) return version;
    if (evalData.student_feedback) return "v8.2";
    return "v8.1";
}

function resolveStudentFeedback(evalData: Section11V81Evaluation) {
    return evalData.student_feedback ?? evalData.student_facing_feedback;
}

function resolveAdminDiagnostics(evalData: Section11V81Evaluation) {
    return evalData.admin_diagnostics ?? evalData.admin_facing_diagnostics;
}

function resolveSectionScore(row: Section11V81SectionScore): number | null {
    return pickNumber(row.score) ?? pickNumber(row.final_section_score);
}

function resolveCiiScoreMax(_evalData: Section11V81Evaluation): number {
    return CII_PLATFORM_MAX;
}

function sumSectionScores(evalData: Section11V81Evaluation): number {
    let sum = 0;
    for (const row of evalData.section_scores ?? []) {
        const sectionScore = resolveSectionScore(row);
        if (sectionScore !== null) sum += sectionScore;
    }
    return sum;
}

function sumIndividualMasterBonuses(evalData: Section11V81Evaluation): number {
    let sum = 0;
    for (const entry of evalData.bonuses ?? []) {
        const row = asRecord(entry);
        const amount =
            pickNumber(row.amount) ??
            pickNumber(row.bonus_amount) ??
            pickNumber(row.points) ??
            pickNumber(row.value) ??
            0;
        sum += amount;
    }
    return Math.min(CII_MASTER_BONUS_MAX, Math.round(sum * 10) / 10);
}

function resolvePenaltyTotal(evalData: Section11V81Evaluation): number {
    const trace = asRecord(evalData.cii_calculation_trace);
    return (
        pickNumber(trace.penalty_total) ??
        pickNumber(trace.penalties_applied) ??
        pickNumber(trace.penalty_applied) ??
        0
    );
}

function resolveObtainedScore(evalData: Section11V81Evaluation): number {
    const trace = asRecord(evalData.cii_calculation_trace);
    const fromTrace =
        pickNumber(trace.sections_obtained) ??
        pickNumber(trace.obtained_score) ??
        pickNumber(trace.section_scores_total);
    if (fromTrace !== null) {
        return Math.min(CII_PLATFORM_MAX, Math.round(fromTrace * 10) / 10);
    }
    return Math.min(CII_PLATFORM_MAX, Math.round(sumSectionScores(evalData) * 10) / 10);
}

function resolveCiiScore(evalData: Section11V81Evaluation): number | null {
    const fromFinal = pickNumber(evalData.final_result?.cii_score);
    if (fromFinal !== null) return clampPlatformCiiScore(fromFinal);

    const trace = asRecord(evalData.cii_calculation_trace);
    const fromTraceFinal = pickNumber(trace.cii_final) ?? pickNumber(trace.cii_clamped);
    if (fromTraceFinal !== null) return clampPlatformCiiScore(fromTraceFinal);

    const hasSections = (evalData.section_scores?.length ?? 0) > 0;
    const bonusTotal = sumIndividualMasterBonuses(evalData);
    if (hasSections || bonusTotal > 0) {
        const obtained = resolveObtainedScore(evalData);
        const penalties = resolvePenaltyTotal(evalData);
        return clampPlatformCiiScore(obtained + bonusTotal - penalties);
    }

    const fromRaw = pickNumber(trace.cii_raw);
    return fromRaw !== null ? clampPlatformCiiScore(fromRaw) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bucketRedFlags(flags: Section11V81RedFlag[]): {
    critical: string | null;
    moderate: string | null;
    minor: string | null;
} {
    const critical: string[] = [];
    const moderate: string[] = [];
    const minor: string[] = [];

    for (const flag of flags) {
        const line = [
            flag.code ? `${flag.code}: ` : "",
            flag.flag || flag.admin_note || "Red flag",
            flag.effect_on_score_or_readiness || flag.score_effect
                ? ` (${flag.effect_on_score_or_readiness || flag.score_effect})`
                : "",
        ]
            .join("")
            .trim();
        if (!line) continue;

        const severity = pickString(flag.severity).toLowerCase();
        if (severity === "critical" || severity === "high") critical.push(line);
        else if (severity === "medium") moderate.push(line);
        else minor.push(line);
    }

    return {
        critical: critical.length ? critical.join("\n") : null,
        moderate: moderate.length ? moderate.join("\n") : null,
        minor: minor.length ? minor.join("\n") : null,
    };
}

function deriveRecommendedAction(evalData: Section11V81Evaluation): string {
    const readiness = pickString(evalData.final_result?.badge_readiness);
    const admin = pickString(resolveAdminDiagnostics(evalData)?.approval_recommendation);
    if (evalData.final_result?.resubmission_required) return "Resubmission Required";
    if (evalData.final_result?.admin_review_required) return "Admin Review Required";
    if (/reject/i.test(admin)) return "Revision Requested";
    if (/hold/i.test(admin)) return "Admin Review Required";
    if (/conditional/i.test(readiness)) return "Conditional Approval";
    if (/admin review/i.test(readiness)) return "Admin Review Required";
    if (/resubmission/i.test(readiness)) return "Resubmission Required";
    return "Approved";
}

export function formatSection11V81AsSummaryText(evalData: Section11V81Evaluation): string {
    const cii = resolveCiiScore(evalData);
    const level = evalData.final_result?.level;
    const badgeTitle = pickString(evalData.final_result?.badge_title);
    const certificateLine = pickString(evalData.final_result?.certificate_line);
    const feedback = resolveStudentFeedback(evalData);
    const frameworkVersion = resolveFrameworkVersion(evalData);
    const ciiMax = resolveCiiScoreMax(evalData);
    const parts: string[] = [];

    parts.push(`CIEL PK EVALUATION (${frameworkVersion})`);
    if (pickString(evalData.final_result?.one_line_verdict)) {
        parts.push(`One-line verdict: ${evalData.final_result?.one_line_verdict}`);
    }
    if (cii !== null) {
        parts.push(`Final CII Score: ${cii} / ${ciiMax}`);
        parts.push(`CII Index Score: ${Math.round(cii)} / ${ciiMax}`);
    }
    if (level !== undefined) {
        parts.push(`Level: ${level}${badgeTitle ? ` — ${badgeTitle}` : ""}`);
    }
    if (pickString(evalData.final_result?.badge_readiness)) {
        parts.push(`Badge Readiness: ${evalData.final_result?.badge_readiness}`);
    }
    if (certificateLine) parts.push(`Certificate line: ${certificateLine}`);

    if (feedback?.opening_praise) {
        parts.push(`Component 1 — Executive Verdict\n${feedback.opening_praise}`);
    }
    const summaryText =
        "summary" in (feedback || {})
            ? pickString((feedback as { summary?: string }).summary)
            : pickString((feedback as { why_score_is_high_or_low?: string })?.why_score_is_high_or_low);
    if (summaryText) {
        parts.push(`Component 2 — Summary\n${summaryText}`);
    }

    if (Array.isArray(evalData.overall_strengths) && evalData.overall_strengths.length) {
        parts.push(`Overall Strengths\n${evalData.overall_strengths.map((s) => `• ${s}`).join("\n")}`);
    }
    if (Array.isArray(evalData.overall_limitations) && evalData.overall_limitations.length) {
        parts.push(`Overall Limitations\n${evalData.overall_limitations.map((s) => `• ${s}`).join("\n")}`);
    }

    const indices = evalData.indices || {};
    const indexLines = [
        pickNumber(indices.quality_index_out_of_10) !== null
            ? `Quality Index: ${indices.quality_index_out_of_10}/10 (${pickString(indices.quality_band) || "—"})`
            : null,
        pickNumber(indices.quantity_index_out_of_10) !== null
            ? `Quantity Index: ${indices.quantity_index_out_of_10}/10 (${pickString(indices.quantity_band) || "—"})`
            : null,
        pickNumber(indices.evidence_confidence_index_out_of_10) !== null
            ? `Evidence Confidence: ${indices.evidence_confidence_index_out_of_10}/10 (${pickString(indices.evidence_band) || "—"})`
            : null,
        pickNumber(indices.integrity_audit_score_out_of_10) !== null
            ? `Integrity Audit Score: ${indices.integrity_audit_score_out_of_10}/10 (${pickString(indices.integrity_band) || "—"})`
            : null,
    ].filter(Boolean);
    if (indexLines.length) {
        parts.push(`Component 3 — Four Indices\n${indexLines.join("\n")}`);
    }

    const sections = Array.isArray(evalData.section_scores) ? evalData.section_scores : [];
    for (const row of sections) {
        const n = row.section_number;
        if (!n || n < 1 || n > 10) continue;
        const title = pickString(row.section_name) || SECTION_TITLES[n] || `Section ${n}`;
        const sectionScore = resolveSectionScore(row);
        const score = sectionScore !== null ? `${sectionScore}/${row.weight ?? "—"}` : "—";
        const body = [
            row.what_was_done,
            row.appreciation,
            row.strengths,
            row.limitations,
            row.evidence_commentary,
            row.improvement_guidance,
            row.student_facing_comment,
        ]
            .map((part) => pickString(part))
            .filter(Boolean)
            .join("\n");
        parts.push(
            [
                `SECTION ${n} — ${title}`,
                `Score: ${score}`,
                body ? `Feedback: ${body}` : null,
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    const actions = (
        (feedback as { five_specific_actions?: string[] })?.five_specific_actions ||
        (feedback as { five_actions?: string[] })?.five_actions ||
        []
    )
        .map((a) => pickString(a))
        .filter(Boolean);
    if (actions.length) {
        parts.push(`Component 8 — Top 5 Improvement Actions\n${actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
    }

    const recommended = deriveRecommendedAction(evalData);
    parts.push(
        [
            "Component 9 — Final Decision",
            `Recommended Action: ${recommended}`,
            cii !== null ? `Current Band: ${badgeTitle || "—"} — score: ${Math.round(cii)} / ${resolveCiiScoreMax(evalData)}` : null,
            feedback?.encouragement ? `Path Forward:\n${feedback.encouragement}` : null,
        ]
            .filter(Boolean)
            .join("\n"),
    );

    const admin = resolveAdminDiagnostics(evalData);
    if (admin?.risk_summary || admin?.notes) {
        parts.push(
            [
                admin.risk_summary ? `Admin risk summary: ${admin.risk_summary}` : null,
                admin.notes ? `Admin notes: ${admin.notes}` : null,
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    return parts.join("\n\n").trim();
}

export function section11V81ToAuditMeta(evalData: Section11V81Evaluation): ReportCIIauditMeta {
    const redFlagBuckets = bucketRedFlags(Array.isArray(evalData.red_flags) ? evalData.red_flags : []);
    const feedback = resolveStudentFeedback(evalData);
    const actions = (
        (feedback as { five_specific_actions?: string[] })?.five_specific_actions ||
        (feedback as { five_actions?: string[] })?.five_actions ||
        []
    )
        .map((a) => pickString(a))
        .filter(Boolean)
        .slice(0, 5);
    const cii = resolveCiiScore(evalData);
    const recommended = deriveRecommendedAction(evalData);
    const resubmission = Boolean(evalData.final_result?.resubmission_required);
    const adminReview = Boolean(evalData.final_result?.admin_review_required);

    const indices = evalData.indices || {};
    const credibility = [
        pickNumber(indices.integrity_audit_score_out_of_10) !== null
            ? `Integrity audit score: ${indices.integrity_audit_score_out_of_10}/10`
            : null,
        pickNumber(indices.evidence_confidence_index_out_of_10) !== null
            ? `Evidence confidence: ${indices.evidence_confidence_index_out_of_10}/10`
            : null,
        pickString(evalData.final_result?.badge_readiness)
            ? `Badge readiness: ${evalData.final_result?.badge_readiness}`
            : null,
    ]
        .filter(Boolean)
        .join(" · ");

    return {
        critical_red_flags: redFlagBuckets.critical,
        moderate_issues: redFlagBuckets.moderate,
        minor_issues: redFlagBuckets.minor,
        credibility: credibility || null,
        risk_level: recommended,
        top_fixes: actions,
        final_remark: [
            cii !== null ? `CII: ${Math.round(cii)}/${resolveCiiScoreMax(evalData)}` : null,
            evalData.final_result?.badge_title ? `${evalData.final_result.badge_title}` : null,
            pickString(evalData.final_result?.certificate_line) || null,
        ]
            .filter(Boolean)
            .join(" · "),
        student_feedback:
            resubmission || adminReview
                ? pickString(feedback?.encouragement) ||
                  pickString(resolveAdminDiagnostics(evalData)?.risk_summary) ||
                  null
                : null,
        needs_revision: resubmission || recommended === "Revision Requested" || recommended === "Resubmission Required",
    };
}

export function parseSection11V81Response(raw: string): {
    evaluation: Section11V81Evaluation;
    summaryText: string;
    auditMeta: ReportCIIauditMeta;
} | null {
    const parsed = extractSection11JsonObject(raw);
    if (!isSection11V81Evaluation(parsed)) return null;

    return {
        evaluation: parsed,
        summaryText: formatSection11V81AsSummaryText(parsed),
        auditMeta: section11V81ToAuditMeta(parsed),
    };
}

export function buildCiiSnapshotFromV81(evalData: Section11V81Evaluation) {
    const cii = resolveCiiScore(evalData);
    if (cii === null) return null;
    const ciiMax = resolveCiiScoreMax(evalData);
    const rounded = Math.min(ciiMax, Math.max(0, Math.round(cii)));
    const breakdown: Record<string, number> = {};
    for (const row of evalData.section_scores || []) {
        const n = row.section_number;
        if (!n) continue;
        const keyMap: Record<number, string> = {
            1: "participation",
            2: "context",
            3: "sdg",
            4: "outputs",
            5: "outcomes",
            6: "resources",
            7: "partnerships",
            8: "evidence",
            9: "learning",
            10: "sustainability",
        };
        const key = keyMap[n];
        const sectionScore = resolveSectionScore(row);
        if (key && sectionScore !== null) {
            breakdown[key] = sectionScore;
        }
    }
    return {
        totalScore: rounded,
        level: pickString(evalData.final_result?.badge_title) || `Level ${evalData.final_result?.level ?? ""}`,
        breakdown: Object.keys(breakdown).length ? breakdown : undefined,
        suggestions: (
            (evalData.student_feedback?.five_specific_actions ||
                evalData.student_facing_feedback?.five_actions ||
                []) as string[]
        )
            .map((a) => pickString(a))
            .filter(Boolean),
        evaluation_framework_version: resolveFrameworkVersion(evalData),
        cii_score_max: ciiMax,
    };
}

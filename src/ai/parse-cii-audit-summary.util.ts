/**
 * Extracts structured fields from the Section 11 AI audit response (plain text, 11 blocks).
 * Tolerant to minor formatting drift from the model.
 */

export type ReportCIIauditMeta = {
    critical_red_flags: string | null;
    moderate_issues: string | null;
    minor_issues: string | null;
    credibility: string | null;
    risk_level: string | null;
    top_fixes: string[];
    final_remark: string | null;
    student_feedback: string | null;
    needs_revision: boolean;
};

function findFinalAuditParagraph(full: string): string | null {
    const normalized = full.replace(/\r\n/g, "\n").trim();
    if (!normalized) return null;

    const chunks = normalized
        .split(/\n\n+/)
        .map((c) => c.trim())
        .filter(Boolean);

    for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (/SECTION\s*11/i.test(c) && /CRITICAL\s+RED\s+FLAGS/i.test(c)) {
            return c;
        }
    }

    // v2 format: the "Final Decision" block is the best summary anchor.
    for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (/Component\s*9\s*[—-]\s*Final\s+Decision/i.test(c) || /\bRecommended\s+Action\s*:/i.test(c)) {
            return c;
        }
    }

    const idx = normalized.search(/SECTION\s*11[\s—-]*FINAL\s+AUDIT/i);
    if (idx >= 0 && /CRITICAL\s+RED\s+FLAGS/i.test(normalized)) {
        return normalized.slice(idx).trim();
    }

    if (/FINAL\s+AUDIT\s+SUMMARY/i.test(normalized) && /CRITICAL\s+RED\s+FLAGS/i.test(normalized)) {
        const j = normalized.search(/FINAL\s+AUDIT\s+SUMMARY/i);
        return normalized.slice(j).trim();
    }

    return null;
}

function sliceBetween(
    haystack: string,
    start: RegExp,
    endPatterns: RegExp[],
): string | null {
    const sm = haystack.match(start);
    if (!sm || sm.index === undefined) return null;
    const from = sm.index + sm[0].length;
    const rest = haystack.slice(from);

    let endIdx = rest.length;
    for (const ep of endPatterns) {
        const m = rest.match(ep);
        if (m && m.index !== undefined && m.index < endIdx) {
            endIdx = m.index;
        }
    }

    const chunk = rest.slice(0, endIdx).trim();
    return chunk.length ? chunk : null;
}

function parseTopFixes(raw: string | null): string[] {
    if (!raw) return [];
    const normalized = raw.replace(/\r\n/g, " ").replace(/\s+/g, " ").trim();
    const parts = normalized.split(/\d+\)\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts;
    const alt = normalized.split(/;\s*|\.\s+(?=[A-Z])/).map((p) => p.trim()).filter(Boolean);
    return alt.length > 1 ? alt : raw.trim() ? [raw.trim()] : [];
}

export function parseSection11AuditSummary(fullText: string): ReportCIIauditMeta | null {
    const para = findFinalAuditParagraph(fullText);
    if (!para) return null;

    // v2 format: read Top 5 lift criteria (Component 8) and recommended action (Component 9).
    if (/Component\s*9\s*[—-]\s*Final\s+Decision/i.test(para) || /\bRecommended\s+Action\s*:/i.test(para)) {
        const normalized = fullText.replace(/\r\n/g, "\n").trim();

        const topBlock = sliceBetween(normalized, /Component\s*8\s*[—-]\s*Top\s*5\s+Lift\s+Criteria\s*/i, [
            /Component\s*9\s*[—-]\s*Final\s+Decision/i,
        ]);

        const recommended = sliceBetween(para, /\bRecommended\s+Action\s*:\s*/i, [
            /\bCurrent\s+Band\s*:/i,
            /\bPath\s+Forward\s*:/i,
        ]);

        const currentBand = sliceBetween(para, /\bCurrent\s+Band\s*:\s*/i, [
            /\bPath\s+Forward\s*:/i,
        ]);

        const top_fixes = topBlock
            ? topBlock
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => /^\d+\./.test(l))
                  .map((l) => l.replace(/^\d+\.\s*/, "").trim())
                  .filter(Boolean)
            : [];

        const risk_level = recommended ? recommended.trim() : null;
        const final_remark = currentBand ? `Current Band: ${currentBand.trim()}` : null;

        const needs_revision =
            /\bRevision\s+Requested\b/i.test(risk_level || "") ||
            /\bPartial\s+Deduction\b/i.test(risk_level || "") ||
            /\bMajor\s+Deduction\b/i.test(risk_level || "") ||
            /\bEscalate\b/i.test(risk_level || "");

        const hasAny = Boolean(risk_level || top_fixes.length || final_remark);
        if (!hasAny) return null;

        return {
            critical_red_flags: null,
            moderate_issues: null,
            minor_issues: null,
            credibility: null,
            risk_level,
            top_fixes,
            final_remark,
            student_feedback: null,
            needs_revision,
        };
    }

    const critical = sliceBetween(para, /CRITICAL\s+RED\s+FLAGS\s*:\s*/i, [
        /\bMODERATE\s+ISSUES\s*:/i,
    ]);

    const moderate = sliceBetween(para, /MODERATE\s+ISSUES\s*:\s*/i, [/\bMINOR\s+ISSUES\s*:/i]);

    const minor = sliceBetween(para, /MINOR\s+ISSUES\s*:\s*/i, [
        /\bOverall\s+Credibility\s+Score\s*:/i,
        /\bCredibility\s+Score\s*:/i,
    ]);

    const credibility = sliceBetween(para, /Overall\s+Credibility\s+Score\s*:\s*/i, [/\bRisk\s+Level\s*:/i]);

    const risk_level = sliceBetween(para, /Risk\s+Level\s*:\s*/i, [
        /\bCII\s+Index\s+Score\s*:/i,
        /\bTop\s*5\s+Required\s+Fixes\s*:/i,
        /\bTop\s+Five\s+Required\s+Fixes\s*:/i,
        /\bRequired\s+Fixes\s*:/i,
    ]);

    const topRaw = sliceBetween(para, /Top\s*5\s+Required\s+Fixes\s*:\s*/i, [
        /\bFinal\s+Auditor\s+Remark\s*:/i,
        /\bRETURN\s+TO\s+STUDENT/i,
        /\bStudent\s+Feedback\s*:/i,
    ]);

    const topRawAlt =
        topRaw ||
        sliceBetween(para, /Top\s+Five\s+Required\s+Fixes\s*:\s*/i, [
            /\bFinal\s+Auditor\s+Remark\s*:/i,
            /\bRETURN\s+TO\s+STUDENT/i,
            /\bStudent\s+Feedback\s*:/i,
        ]);

    const final_remark = sliceBetween(para, /Final\s+Auditor\s+Remark\s*:\s*/i, [
        /\bRETURN\s+TO\s+STUDENT/i,
        /\bStudent\s+Feedback\s*:/i,
        /\bSTUDENT\s+FEEDBACK\s*:/i,
    ]);

    const student_feedback =
        sliceBetween(para, /Student\s+Feedback\s*:\s*/i, []) ||
        sliceBetween(para, /STUDENT\s+FEEDBACK\s*:\s*/i, []);

    const top_fixes = parseTopFixes(topRawAlt);

    const needs_revision =
        /\bRETURN\s+TO\s+STUDENT\s+FOR\s+REVISION\b/i.test(para) ||
        /\bNeeds\s+Revision\b/i.test(risk_level || "") ||
        /\bReject\b/i.test(risk_level || "");

    const hasAny =
        critical ||
        moderate ||
        minor ||
        credibility ||
        risk_level ||
        top_fixes.length ||
        final_remark ||
        student_feedback;

    if (!hasAny) return null;

    return {
        critical_red_flags: critical,
        moderate_issues: moderate,
        minor_issues: minor,
        credibility: credibility ? credibility.replace(/\.\s*Risk\s+Level.*$/i, "").trim() : null,
        risk_level,
        top_fixes,
        final_remark,
        student_feedback,
        needs_revision,
    };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function pickString(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
}

function pickNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function isBackendEvaluationPayload(data: UnknownRecord): boolean {
    return (
        data.schema_version === "ciel_pk_ai_evaluation_v1.0" ||
        Boolean(data.section1_participation_identity_attendance) ||
        Boolean(data.submission_metadata)
    );
}

function resolveSubmissionId(data: UnknownRecord): string {
    const meta = asRecord(data.submission_metadata);
    return (
        pickString(meta.submission_id) ||
        pickString(meta.report_id) ||
        pickString(data.report_id) ||
        pickString(data.project_id) ||
        pickString(data.id) ||
        "unknown"
    );
}

function resolveRequiredHours(data: UnknownRecord): number {
    const meta = asRecord(data.submission_metadata);
    const project = asRecord(meta.project);
    const section1Summary = asRecord(
        asRecord(data.section1_participation_identity_attendance).attendance_summary,
    );
    return (
        pickNumber(data.required_hours) ??
        pickNumber(data.requiredHoursPerStudent) ??
        pickNumber(project.required_hours_per_student) ??
        pickNumber(section1Summary.minimum_required_hours_per_student) ??
        16
    );
}

function resolveProjectDuration(data: UnknownRecord): string {
    const meta = asRecord(data.submission_metadata);
    const project = asRecord(meta.project);
    const opportunity = asRecord(data.opportunity);
    const timeline = asRecord(opportunity.timeline);
    const start =
        pickString(project.start_date) ||
        pickString(timeline.start_date) ||
        pickString(data.start_date);
    const end =
        pickString(project.end_date) ||
        pickString(timeline.end_date) ||
        pickString(data.end_date);
    if (start && end) return `${start} to ${end}`;
    return start || end || "not declared";
}

function backendSectionBlocks(data: UnknownRecord): Array<{ label: string; payload: unknown }> {
    return [
        {
            label: "Section 1 — Identity & Attendance",
            payload: data.section1_participation_identity_attendance ?? null,
        },
        {
            label: "Section 2 — Project Context",
            payload: data.section2_project_context_discipline ?? null,
        },
        {
            label: "Section 3 — SDG Strategy",
            payload: data.section3_sdg_strategy_intent ?? null,
        },
        {
            label: "Section 4 — Activities & Output Scale",
            payload: data.section4_activities_outputs_scale ?? null,
        },
        {
            label: "Section 5 — Outcomes & Measurable Change",
            payload: data.section5_outcomes_systemic_change ?? null,
        },
        {
            label: "Section 6 — Resource Mobilization",
            payload: data.section6_resources_mobilization ?? null,
        },
        {
            label: "Section 7 — Partnerships & Collaboration",
            payload: data.section7_partnerships ?? null,
        },
        {
            label: "Section 8 — Evidence & Verification",
            payload: data.section8_evidence_verification ?? null,
        },
        {
            label: "Section 9 — Personal & Academic Reflection",
            payload: data.section9_reflection_learning ?? null,
        },
        {
            label: "Section 10 — Sustainability & Continuation",
            payload: data.section10_sustainability_continuation ?? null,
        },
    ];
}

function frontendSectionBlocks(data: UnknownRecord): Array<{ label: string; payload: unknown }> {
    return [
        { label: "Section 1 — Identity & Attendance", payload: data.section1 ?? null },
        { label: "Section 2 — Project Context", payload: data.section2 ?? null },
        { label: "Section 3 — SDG Strategy", payload: data.section3 ?? null },
        { label: "Section 4 — Activities & Output Scale", payload: data.section4 ?? null },
        { label: "Section 5 — Outcomes & Measurable Change", payload: data.section5 ?? null },
        { label: "Section 6 — Resource Mobilization", payload: data.section6 ?? null },
        { label: "Section 7 — Partnerships & Collaboration", payload: data.section7 ?? null },
        { label: "Section 8 — Evidence & Verification", payload: data.section8 ?? null },
        { label: "Section 9 — Personal & Academic Reflection", payload: data.section9 ?? null },
        { label: "Section 10 — Sustainability & Continuation", payload: data.section10 ?? null },
    ];
}

function formatEvidenceInventory(data: UnknownRecord): string {
    const files = Array.isArray(data.uploaded_evidence_files) ? data.uploaded_evidence_files : [];
    if (!files.length) {
        const section8 = asRecord(data.section8 ?? data.section8_evidence_verification);
        const legacyFiles = Array.isArray(section8.evidence_files) ? section8.evidence_files : [];
        if (!legacyFiles.length) return "No uploaded evidence files were included in this payload.";
        return legacyFiles
            .map((file, index) => {
                const row = asRecord(file);
                const name = pickString(row.file_name) || pickString(row.name) || `file_${index + 1}`;
                const url = pickString(row.url);
                return `file_${index + 1}: ${name}${url ? ` (${url})` : ""}`;
            })
            .join("\n");
    }

    return files
        .map((file, index) => {
            const row = asRecord(file);
            const name = pickString(row.file_name) || pickString(row.file_id) || `file_${index + 1}`;
            const mime = pickString(row.file_type) || "unknown";
            const category = pickString(row.file_category) || "evidence";
            const size = pickNumber(row.file_integrity && asRecord(row.file_integrity).size_bytes);
            const sizeLabel = size !== null ? `${size} bytes` : "size unknown";
            return `file_${index + 1}: ${name}, ${mime}, ${sizeLabel}, category=${category}, source=student-uploaded`;
        })
        .join("\n");
}

export type Section11EvaluationFrameworkVersion = "v8.2" | "v1.2";

/**
 * Formats submission data for the CIEL PK Section 11 user message wrapper.
 * Accepts either the backend `buildCielPkAiEvaluationPayload` shape or the student report object.
 */
export function buildSection11EvaluationUserMessage(
    data: unknown,
    frameworkVersion: Section11EvaluationFrameworkVersion = "v8.2",
): string {
    const root = asRecord(data);
    const backendPayload = isBackendEvaluationPayload(root);
    const submissionId = resolveSubmissionId(root);
    const requiredHours = resolveRequiredHours(root);
    const projectDuration = resolveProjectDuration(root);
    const sectionBlocks = backendPayload ? backendSectionBlocks(root) : frontendSectionBlocks(root);
    const scoringRubric = asRecord(asRecord(root.system_validation).scoring_rubric);

    const lines: string[] = [
        "SUBMISSION FOR EVALUATION",
        "",
        `submission_id: ${submissionId}`,
        `required_hours_of_service: ${requiredHours}`,
        `project_duration: ${projectDuration}`,
        `cohort_context: single submission`,
        "",
        "==========================================",
        "REPORT DATA (Input Schema fields, in order)",
        "==========================================",
        "",
    ];

    for (const block of sectionBlocks) {
        lines.push(`[${block.label} JSON]`);
        lines.push(JSON.stringify(block.payload ?? {}, null, 2));
        lines.push("");
    }

    if (backendPayload && root.submission_metadata) {
        lines.push("[Submission Metadata JSON]");
        lines.push(JSON.stringify(root.submission_metadata, null, 2));
        lines.push("");
    }

    if (Object.keys(scoringRubric).length > 0) {
        lines.push("[Platform Scoring Rubric JSON]");
        lines.push(JSON.stringify(scoringRubric, null, 2));
        lines.push("");
    }

    lines.push("==========================================");
    lines.push("UPLOADED EVIDENCE (file inventory)");
    lines.push("==========================================");
    lines.push("");
    lines.push(formatEvidenceInventory(root));
    lines.push("");
    lines.push("==========================================");
    lines.push("COHORT CONTEXT (if applicable)");
    lines.push("==========================================");
    lines.push("");
    lines.push("Not applicable — single submission");
    lines.push("");
    lines.push("==========================================");
    lines.push("INSTRUCTIONS");
    lines.push("==========================================");
    lines.push("");
    const frameworkLabel =
        frameworkVersion === "v1.2"
            ? "Master Evaluation Rubric v1.2"
            : "CIEL PK v8.2 framework";
    lines.push(
        `Evaluate this submission against the ${frameworkLabel} embedded in your system prompt. ` +
            `When operating in JSON-only deployment mode, emit exactly one JSON object matching the ${frameworkVersion} schema ` +
            `with framework_version set to "${frameworkVersion}".`,
    );

    return lines.join("\n");
}

/** Master Rubric v1.2 admin evaluation — same payload shape, different framework instructions. */
export function buildSection11MasterRubricUserMessage(data: unknown): string {
    return buildSection11EvaluationUserMessage(data, "v1.2");
}

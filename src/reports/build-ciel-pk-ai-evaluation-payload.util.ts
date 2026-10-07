import * as crypto from 'crypto';
import { MAX_DAILY_ATTENDANCE_HOURS } from '../engagement/attendance-description.constants';
import { collectReportEvidenceFiles } from './collect-report-evidence.util';
import { getCiiV45ScoringConfig, CiiV45InputCompleteness } from './cii-v4-5.constants';
import { StudentReport } from './entities/student-report.entity';
import {
    hasPublicSharePermission,
    resolveMediaVisibility,
} from './media-visibility.util';

export const CIEL_PK_AI_EVALUATION_SCHEMA_VERSION = 'ciel_pk_ai_evaluation_v1.0';
export const CIEL_PK_AI_EVALUATION_SCHEMA_VERSION_V45 = 'ciel_pk_ai_evaluation_v4.5';

type UnknownRecord = Record<string, unknown>;

export type CielPkUploadedEvidenceFile = {
    file_id: string;
    file_name: string;
    file_type: string;
    file_category: string;
    url: string;
    storage_path: string;
    uploaded_by_student_id: string | null;
    uploaded_at: string | null;
    linked_sections: number[];
    linked_claims: string[];
    visibility: 'internal';
    ai_accessible: boolean;
    file_integrity: {
        sha256: string | null;
        size_bytes: number | null;
    };
};

export type CielPkAiEvaluationPayload = {
    schema_version: typeof CIEL_PK_AI_EVALUATION_SCHEMA_VERSION;
    evaluation_mode: 'master_ai_prompt';
    generated_at: string;
    submission_metadata: UnknownRecord;
    section1_participation_identity_attendance: UnknownRecord;
    section2_project_context_discipline: UnknownRecord;
    section3_sdg_strategy_intent: UnknownRecord;
    section4_activities_outputs_scale: UnknownRecord;
    section5_outcomes_systemic_change: UnknownRecord;
    section6_resources_mobilization: UnknownRecord;
    section7_partnerships: UnknownRecord;
    section8_evidence_verification: UnknownRecord;
    section9_reflection_learning: UnknownRecord;
    section10_sustainability_continuation: UnknownRecord;
    uploaded_evidence_files: CielPkUploadedEvidenceFile[];
    system_validation: UnknownRecord;
};

function asRecord(value: unknown): UnknownRecord {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function pickString(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

function pickNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function pickIsoDate(value: unknown): string | null {
    const raw = pickString(value);
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function inferSectionNumbers(source: string): number[] {
    const match = source.match(/section(\d+)/i);
    if (!match?.[1]) return [];
    const section = Number(match[1]);
    return Number.isFinite(section) ? [section] : [];
}

function inferFileCategory(source: string, fileName: string): string {
    const haystack = `${source} ${fileName}`.toLowerCase();
    if (haystack.includes('attendance')) return 'attendance_sheet';
    if (haystack.includes('partner')) return 'partner_verification';
    if (haystack.includes('formalization') || haystack.includes('mou')) return 'formalization';
    if (/\.(mp4|mov|webm|avi)$/.test(fileName.toLowerCase())) return 'activity_video';
    if (/\.(jpg|jpeg|png|gif|webp)$/.test(fileName.toLowerCase())) return 'activity_photo';
    if (/\.pdf$/.test(fileName.toLowerCase())) return 'document';
    return 'evidence';
}

function inferMimeType(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    return 'application/octet-stream';
}

function studentIdFromRow(row: UnknownRecord, fallback: string): string {
    return (
        pickString(row.studentRollNumber) ||
        pickString(row.student_roll_number) ||
        pickString(row.universityId) ||
        pickString(row.university_id) ||
        pickString(row.registrationNumber) ||
        pickString(row.registration_number) ||
        pickString(row.studentId) ||
        pickString(row.student_id) ||
        pickString(row.participantId) ||
        pickString(row.id) ||
        fallback
    );
}

function normalizePersonKey(value: string): string {
    return value.trim().toLowerCase();
}

function rowPersonKeys(row: UnknownRecord): string[] {
    return [
        pickString(row.studentId),
        pickString(row.student_id),
        pickString(row.participantId),
        pickString(row.id),
        pickString(row.email),
        pickString(row.student_email),
        pickString(row.fullName),
        pickString(row.name),
        pickString(row.student_name),
        pickString(row.studentName),
    ]
        .map(normalizePersonKey)
        .filter(Boolean);
}

function rowsMatchPerson(a: UnknownRecord, b: UnknownRecord): boolean {
    const aKeys = new Set(rowPersonKeys(a));
    return rowPersonKeys(b).some((key) => aKeys.has(key));
}

function isRejectedAttendance(row: UnknownRecord): boolean {
    const status = (
        pickString(row.approval_status) ||
        pickString(row.approvalStatus) ||
        pickString(row.entryStatus) ||
        ''
    ).toLowerCase();
    return status === 'rejected';
}

function attendanceLogHours(row: UnknownRecord): number {
    return (
        pickNumber(row.hours) ??
        pickNumber(row.sessionHours) ??
        pickNumber(row.session_hours) ??
        0
    );
}

function isPresentRosterPerson(row: UnknownRecord): boolean {
    return Boolean(
        pickString(row.name) ||
            pickString(row.fullName) ||
            pickString(row.email) ||
            pickString(row.id) ||
            pickString(row.studentId) ||
            (pickNumber(row.hours) ?? 0) > 0,
    );
}

function hoursFromAttendanceLogs(logs: unknown[], person: UnknownRecord): number {
    return logs.reduce<number>((sum, raw) => {
        const log = asRecord(raw);
        if (isRejectedAttendance(log)) return sum;
        if (!rowsMatchPerson(person, log)) return sum;
        return sum + attendanceLogHours(log);
    }, 0);
}

function hoursFromIndividualMetrics(metrics: UnknownRecord, person: UnknownRecord): number {
    return asArray(metrics.individual_metrics).reduce<number>((sum, raw) => {
        const row = asRecord(raw);
        if (!rowsMatchPerson(person, row)) return sum;
        return (
            sum +
            (pickNumber(row.individual_hours) ??
                pickNumber(row.hours) ??
                pickNumber(row.verified_hours) ??
                0)
        );
    }, 0);
}

function effectivePersonHours(
    person: UnknownRecord,
    logs: unknown[],
    metrics: UnknownRecord,
): number {
    return Math.max(
        pickNumber(person.hours) ?? 0,
        hoursFromAttendanceLogs(logs, person),
        hoursFromIndividualMetrics(metrics, person),
    );
}

function mapTeamLead(
    lead: UnknownRecord,
    fallbackStudentId: string,
    verifiedHours?: number | null,
): UnknownRecord {
    const hours = verifiedHours ?? pickNumber(lead.hours);
    return {
        student_id: studentIdFromRow(lead, fallbackStudentId),
        full_name: pickString(lead.fullName) || pickString(lead.name),
        email: pickString(lead.email),
        role: pickString(lead.role) || 'Team Lead',
        declared_hours: pickNumber(lead.hours),
        verified_hours: hours,
    };
}

function mapTeamMember(
    member: UnknownRecord,
    fallbackStudentId: string,
    verifiedHours?: number | null,
): UnknownRecord {
    const hours = verifiedHours ?? pickNumber(member.hours);
    return {
        student_id: studentIdFromRow(member, fallbackStudentId),
        full_name: pickString(member.fullName) || pickString(member.name),
        email: pickString(member.email),
        role: pickString(member.role) || 'Team Member',
        declared_hours: pickNumber(member.hours),
        verified_hours: hours,
    };
}

function mapAttendanceLog(
    log: UnknownRecord,
    urlToFileId: Map<string, string>,
): UnknownRecord {
    const evidenceUrls = [
        pickString(log.evidence_url),
        pickString(log.evidenceUrl),
    ].filter(Boolean);
    const evidenceFileIds = evidenceUrls
        .map((url) => urlToFileId.get(url))
        .filter((id): id is string => Boolean(id));

    return {
        log_id: pickString(log.id) || null,
        student_id: pickString(log.participantId) || null,
        student_name: pickString(log.student_name) || null,
        activity_date: pickString(log.date),
        start_time: pickString(log.start_time),
        end_time: pickString(log.end_time),
        duration_hours: pickNumber(log.hours),
        activity_type: pickString(log.activity_type),
        activity_title: pickString(log.activity_title) || pickString(log.description),
        activity_description: pickString(log.description),
        location: pickString(log.location),
        // Logged vs rejected only. Faculty/partner pending verification is confirmed
        // when Admin locks CII — it is not an analyser input.
        verification_status: isRejectedAttendance(log) ? 'rejected' : 'logged',
        evidence_file_ids: evidenceFileIds,
        evidence_urls: evidenceUrls,
    };
}

function buildEvidenceRegistry(report: StudentReport): {
    files: CielPkUploadedEvidenceFile[];
    urlToFileId: Map<string, string>;
} {
    const refs = collectReportEvidenceFiles(report);
    const studentId = report.studentId;
    const submittedAt = pickIsoDate(report.reportSubmittedAt ?? report.submission_date ?? report.createdAt);
    const urlToFileId = new Map<string, string>();
    const files: CielPkUploadedEvidenceFile[] = refs.map((ref, index) => {
        const fileId = `EV-${String(index + 1).padStart(3, '0')}`;
        urlToFileId.set(ref.url, fileId);
        const linkedSections = inferSectionNumbers(ref.source);
        return {
            file_id: fileId,
            file_name: ref.name,
            file_type: inferMimeType(ref.name),
            file_category: inferFileCategory(ref.source, ref.name),
            url: ref.url,
            storage_path: ref.url.split('?')[0],
            uploaded_by_student_id: studentId,
            uploaded_at: submittedAt,
            linked_sections: linkedSections.length > 0 ? linkedSections : [8],
            linked_claims: [],
            visibility: 'internal',
            ai_accessible: true,
            file_integrity: {
                sha256: null,
                size_bytes: null,
            },
        };
    });
    return { files, urlToFileId };
}

function resolveRequiredHours(report: StudentReport): number {
    const fromTimeline = pickNumber(report.opportunity?.timeline?.expected_hours);
    if (fromTimeline && fromTimeline > 0) return fromTimeline;
    const section1 = asRecord(report.section1);
    const metrics = asRecord(section1.metrics);
    const fromMetrics = pickNumber(metrics.minimum_required_hours_per_student);
    return fromMetrics && fromMetrics > 0 ? fromMetrics : 16;
}

function buildAttendanceSummary(section1: UnknownRecord, requiredHours: number): UnknownRecord {
    const lead = asRecord(section1.team_lead);
    const members = asArray(section1.team_members).map(asRecord).filter(isPresentRosterPerson);
    const logs = asArray(section1.attendance_logs);
    const metrics = asRecord(section1.metrics);
    const solo = members.length === 0;
    const allNonRejectedLogHours = logs.reduce<number>((sum, raw) => {
        const log = asRecord(raw);
        if (isRejectedAttendance(log)) return sum;
        return sum + attendanceLogHours(log);
    }, 0);

    const hoursFor = (person: UnknownRecord, fallbackId: string): { id: string; hours: number } => {
        let hours = effectivePersonHours(person, logs, metrics);
        // Solo / individual reports often store hours only on attendance logs, not team_lead.hours.
        if (solo) {
            hours = Math.max(
                hours,
                allNonRejectedLogHours,
                pickNumber(metrics.total_verified_hours) ?? 0,
            );
        }
        return { id: studentIdFromRow(person, fallbackId), hours };
    };

    const leadResult = hoursFor(lead, 'team_lead');
    const memberResults = members.map((row, index) =>
        hoursFor(row, pickString(row.id) || `member_${index + 1}`),
    );
    const totalDeclaredTeamHours =
        (pickNumber(lead.hours) ?? 0) +
        members.reduce((sum, row) => sum + (pickNumber(row.hours) ?? 0), 0);
    const totalVerifiedTeamHours = Math.max(
        pickNumber(metrics.total_verified_hours) ?? 0,
        leadResult.hours + memberResults.reduce((sum, row) => sum + row.hours, 0),
        allNonRejectedLogHours,
        totalDeclaredTeamHours,
    );
    const studentsBelowRequiredHours = [leadResult, ...memberResults]
        .filter((row) => row.hours + 1e-9 < requiredHours)
        .map((row) => row.id);

    return {
        total_declared_team_hours: totalDeclaredTeamHours,
        total_verified_team_hours: totalVerifiedTeamHours,
        required_hours_met: studentsBelowRequiredHours.length === 0,
        minimum_required_hours_per_student: requiredHours,
        max_daily_attendance_hours_per_student: MAX_DAILY_ATTENDANCE_HOURS,
        students_below_required_hours: studentsBelowRequiredHours,
        verified_session_count: pickNumber(metrics.verified_session_count) ?? logs.length,
    };
}

function mapSection2(section2: UnknownRecord, urlToFileId: Map<string, string>): UnknownRecord {
    const baselineEvidence = asArray(section2.baseline_evidence).map((entry, index) => {
        if (typeof entry === 'string') {
            return {
                type: 'observation',
                description: entry,
                date: null,
                evidence_file_ids: [],
            };
        }
        const row = asRecord(entry);
        const url = pickString(row.url);
        return {
            type: pickString(row.type) || 'observation',
            description: pickString(row.description) || pickString(entry),
            date: pickString(row.date) || null,
            evidence_file_ids: url ? [urlToFileId.get(url)].filter(Boolean) : [],
            ...(index === 0 ? {} : {}),
        };
    });

    return {
        discipline: pickString(section2.discipline),
        problem_category: pickString(section2.problem_category),
        primary_beneficiaries: pickString(section2.primary_beneficiary),
        problem_statement: pickString(section2.problem_statement),
        baseline_evidence: baselineEvidence,
        discipline_contribution: pickString(section2.discipline_contribution),
        local_context: pickString(section2.summary_text) || pickString(section2.problem_statement),
    };
}

function mapSection3(section3: UnknownRecord): UnknownRecord {
    const primary = asRecord(section3.primary_sdg);
    return {
        primary_sdg: {
            sdg_number: pickNumber(primary.goal_number),
            sdg_name: pickString(primary.goal_title),
            target_code: pickString(primary.target_id) || pickString(primary.target_code),
            target_description: pickString(primary.target_description),
            indicator_code: pickString(primary.indicator_id) || pickString(primary.indicator_code),
            indicator_description: pickString(primary.indicator_description),
            sub_indicator: pickString(primary.sub_indicator),
        },
        secondary_sdgs: asArray(section3.secondary_sdgs).map((entry) => {
            const row = asRecord(entry);
            return {
                sdg_number: pickNumber(row.goal_number),
                target_code: pickString(row.target_id) || pickString(row.target_code),
                indicator_code: pickString(row.indicator_id) || pickString(row.indicator_code),
                sub_indicator: pickString(row.sub_indicator),
                justification: pickString(row.justification_text),
                status: pickString(row.status),
            };
        }),
        contribution_intent_statement:
            pickString(section3.contribution_intent_statement) ||
            pickString(section3.student_contribution_intent_statement),
        sdg_alignment_rationale: pickString(section3.summary_text),
        validation_status: pickString(section3.validation_status) || 'student_declared',
    };
}

function mapSection4(section4: UnknownRecord): UnknownRecord {
    const blocks = asArray(section4.activity_blocks).map((entry, index) => {
        const row = asRecord(entry);
        const outputs = asArray(row.outputs).map((output) => {
            const out = asRecord(output);
            return {
                output_type: pickString(out.type) || pickString(out.title),
                output_type_other: pickString(out.type_other),
                quantity: pickNumber(out.quantity),
                unit: pickString(out.unit_other) || pickString(out.unit),
                verification_method: pickString(out.verification_note),
                evidence_file_ids: [],
            };
        });
        return {
            activity_id: pickString(row.id) || `ACT-${String(index + 1).padStart(3, '0')}`,
            activity_title: pickString(row.title),
            status: pickString(row.status),
            activity_date: pickString(row.activity_period) || pickString(row.activity_date) || null,
            activity_type:
                (/other/i.test(pickString(row.primary_category))
                    ? pickString(row.other_category_text)
                    : '') ||
                pickString(row.primary_category) ||
                pickString(row.sub_category),
            sub_category: pickString(row.sub_category),
            sub_category_other: pickString(row.other_sub_category_text),
            partner_host: pickString(row.partner_host),
            description: pickString(row.description),
            outputs,
            beneficiaries: {
                count: pickNumber(row.beneficiaries_reached),
                unique_count: pickNumber(row.unique_beneficiaries),
                beneficiary_type: asArray(row.beneficiary_categories).join(', ') || null,
                beneficiary_other: pickString(row.other_beneficiary_text),
                age_group: pickString(row.beneficiary_description) || null,
                overlap_status: pickString(row.overlap_status),
                overlap_note: pickString(row.overlap_note),
                counting_method: pickString(row.reach_counting_method_other) || pickString(row.reach_counting_method),
            },
            team_members_involved: [],
            sessions_count: pickNumber(row.sessions_count),
            delivery_mode: pickString(row.delivery_mode),
            geographic_reach: pickString(row.geographic_reach),
            site_note: pickString(row.site_note),
            serves_beneficiaries: row.serves_beneficiaries === false ? false : true,
            sdgs: asArray(row.sdgs)
                .map((n) => pickNumber(n))
                .filter((n): n is number => n != null && n >= 1 && n <= 17),
        };
    });
    const summary = asRecord(section4.project_summary);
    // The activity ladder never writes sessions_count; fall back to delivered outputs counted in Sessions.
    const sessionsFromOutputs = blocks.reduce(
        (sum, block) =>
            sum +
            asArray(asRecord(block).outputs).reduce<number>((n, output) => {
                const out = asRecord(output);
                return /session/i.test(pickString(out.unit)) ? n + (pickNumber(out.quantity) ?? 0) : n;
            }, 0),
        0,
    );
    const totalSessions =
        blocks.reduce((sum, block) => sum + (pickNumber(asRecord(block).sessions_count) ?? 0), 0) ||
        sessionsFromOutputs;
    const fromActivities = blocks.reduce((sum, block) => {
        const people = asRecord(asRecord(block).beneficiaries);
        return sum + (pickNumber(people.unique_count) ?? pickNumber(people.count) ?? 0);
    }, 0);
    const distinctBeneficiaries = pickNumber(summary.distinct_total_beneficiaries) ?? (fromActivities > 0 ? fromActivities : null);
    return {
        project_summary: {
            total_sessions: totalSessions,
            total_beneficiaries_reached: distinctBeneficiaries,
            direct_beneficiaries: distinctBeneficiaries,
            indirect_beneficiaries: 0,
            geographic_reach:
                pickString(summary.overall_geographic_reach) ||
                (blocks.map((block) => pickString(asRecord(block).geographic_reach)).find(Boolean) ?? ''),
            implementation_model: asArray(summary.overall_implementation_model).join(', ') || pickString(summary.overall_delivery_mode),
        },
        activity_blocks: blocks,
    };
}

function mapSection5(section5: UnknownRecord, urlToFileId: Map<string, string>): UnknownRecord {
    return {
        observed_change: pickString(section5.observed_change),
        measurable_outcomes: asArray(section5.measurable_outcomes).map((entry, index) => {
            const row = asRecord(entry);
            return {
                outcome_id: pickString(row.id) || `OUT-${String(index + 1).padStart(3, '0')}`,
                outcome_statement:
                    pickString(row.metric_other) ||
                    pickString(row.metric) ||
                    pickString(row.outcome_area),
                baseline_value: pickNumber(row.baseline),
                endline_value: pickNumber(row.endline),
                unit: pickString(row.unit_other) || pickString(row.unit),
                measurement_tool: pickString(row.measurement_explanation) || asArray(row.confidence_level).join(', '),
                baseline_date: null,
                endline_date: null,
                beneficiary_group: pickString(row.outcome_area),
                evidence_file_ids: [],
                activity_id: pickString(row.activity_id) || null,
                sure: pickNumber(row.sure),
                confidence_level: asArray(row.confidence_level).map((v) => pickString(v)).filter(Boolean),
            };
        }),
        outcome_evidence_summary: pickString(section5.summary_text),
        limitations: pickString(section5.limitations),
        challenges: pickString(section5.challenges),
        challenge_tags: asArray(section5.challenge_tags).map((v) => pickString(v)).filter(Boolean),
    };
}

function mapSection6(section6: UnknownRecord, urlToFileId: Map<string, string>): UnknownRecord {
    const resources = asArray(section6.resources).map((entry, index) => {
        const row = asRecord(entry);
        return {
            resource_id: `RES-${String(index + 1).padStart(3, '0')}`,
            resource_type: pickString(row.type),
            source: asArray(row.sources).join(', ') || pickString(row.source_other),
            amount: pickNumber(row.amount),
            currency: pickString(row.unit) || 'PKR',
            description: pickString(row.purpose),
            evidence_file_ids: asArray(section6.evidence_files)
                .map((file) => urlToFileId.get(pickString(asRecord(file).url)))
                .filter(Boolean),
        };
    });
    const totalAmount = resources.reduce((sum, resource) => sum + (pickNumber(asRecord(resource).amount) ?? 0), 0);
    return {
        used_resources: pickString(section6.use_resources) === 'yes',
        resources,
        total_financial_value: totalAmount > 0 ? { amount: totalAmount, currency: 'PKR' } : null,
        in_kind_resources: [],
        resource_evidence_summary: pickString(section6.summary_text),
    };
}

function mapSection7(section7: UnknownRecord, section8: UnknownRecord, urlToFileId: Map<string, string>): UnknownRecord {
    const partners = asArray(section7.partners).map((entry, index) => {
        const row = asRecord(entry);
        return {
            partner_id: `PAR-${String(index + 1).padStart(3, '0')}`,
            partner_name: pickString(row.name),
            partner_type: pickString(row.type) || pickString(row.type_other),
            contact_person: {
                name: pickString(row.pakistan_contact_name),
                designation: asArray(row.role)[0] ? pickString(asArray(row.role)[0]) : null,
                email: pickString(row.pakistan_contact_email),
                phone: pickString(row.pakistan_contact_number) || null,
            },
            partner_role: asArray(row.role).join(', '),
            contribution_type: asArray(row.contribution),
            formalization_status: asArray(section7.formalization_status).join(', ') || pickString(row.verification),
            formalization_evidence_file_ids: asArray(section7.formalization_files)
                .map((file) => urlToFileId.get(pickString(asRecord(file).url)))
                .filter(Boolean),
        };
    });
    return {
        has_partners: pickString(section7.has_partners) === 'yes',
        partners,
        partner_verification: {
            status: section8.partner_verification === true ? 'verified' : partners.length > 0 ? 'declared' : 'none',
            verification_type: pickString(section8.partner_verification_type) || null,
            verified_by: section8.partner_verification === true ? 'partner_representative' : null,
            verified_at: null,
        },
    };
}

function collectSection8EvidenceIds(section8: UnknownRecord, urlToFileId: Map<string, string>): string[] {
    const ids = new Set<string>();
    for (const key of ['evidence_files', 'partner_verification_files']) {
        for (const file of asArray(section8[key])) {
            const url = pickString(asRecord(file).url);
            const fileId = url ? urlToFileId.get(url) : undefined;
            if (fileId) ids.add(fileId);
        }
    }
    return Array.from(ids);
}

function mapSection8(section8: UnknownRecord, urlToFileId: Map<string, string>): UnknownRecord {
    const evidenceFileIds = collectSection8EvidenceIds(section8, urlToFileId);
    const hasEvidenceClaim = pickString(section8.has_evidence).toLowerCase() === 'yes';
    const missingEvidenceNotes: string[] = [];
    if (hasEvidenceClaim && evidenceFileIds.length === 0) {
        missingEvidenceNotes.push('Section 8 claims evidence, but no accessible evidence files were linked.');
    }
    const ethical = asRecord(section8.ethical_compliance);
    const mediaVisibility = resolveMediaVisibility(
        section8.media_visible ?? section8.media_usage,
    );
    return {
        has_evidence: hasEvidenceClaim,
        evidence_description: pickString(section8.description),
        evidence_types_claimed: asArray(section8.evidence_types),
        media_visibility: mediaVisibility,
        public_share_permission: hasPublicSharePermission(section8),
        ethical_compliance: {
            consent_obtained: ethical.informed_consent === true,
            minor_protection_followed: ethical.no_harm === true,
            faces_blurred_where_required: false,
            permission_to_use_media: hasPublicSharePermission(section8),
        },
        evidence_file_ids: evidenceFileIds,
        partner_verification: section8.partner_verification === true,
        partner_verification_type: pickString(section8.partner_verification_type) || null,
        orphan_claims: [],
        missing_evidence_notes: missingEvidenceNotes,
    };
}

function mapSection9(section9: UnknownRecord): UnknownRecord {
    const scores = asRecord(section9.competency_scores);
    return {
        personal_learning: pickString(section9.personal_learning),
        academic_application: pickString(section9.academic_application),
        academic_integration: pickString(section9.academic_integration),
        competency_scores: scores,
        reflection_on_limitations: pickString(section9.sustainability_reflection),
    };
}

function mapSection10(section10: UnknownRecord): UnknownRecord {
    return {
        continuation_status: pickString(section10.continuation_status),
        continuation_mechanisms: asArray(section10.mechanisms),
        continuation_details: pickString(section10.continuation_details),
        scaling_potential: pickString(section10.scaling_potential),
        policy_influence: pickString(section10.policy_influence),
        future_roadmap: [],
        sustainability_risks: [],
    };
}

function buildSystemValidation(
    report: StudentReport,
    uploadedEvidenceFiles: CielPkUploadedEvidenceFile[],
    section8: UnknownRecord,
): UnknownRecord {
    const warnings: string[] = [];
    const sections = [
        report.section1,
        report.section2,
        report.section3,
        report.section4,
        report.section5,
        report.section6,
        report.section7,
        report.section8,
        report.section9,
        report.section10,
    ];
    const requiredSectionsPresent = sections.every((section) => section && typeof section === 'object');
    if (!requiredSectionsPresent) warnings.push('One or more required sections are missing.');
    const hasEvidenceClaim = pickString(asRecord(report.section8).has_evidence).toLowerCase() === 'yes';
    if (hasEvidenceClaim && uploadedEvidenceFiles.length === 0) {
        warnings.push('Section 8 claims evidence, but uploaded_evidence_files is empty.');
    }
    const missingNotes = asArray(section8.missing_evidence_notes);
    for (const note of missingNotes) {
        const text = pickString(note);
        if (text) warnings.push(text);
    }

    const s11 = asRecord(report.section11);
    const hasSignoff = Boolean(report.section11 && typeof report.section11 === 'object');
    const signatureName = pickString(s11.signature_name);

    return {
        required_sections_present: requiredSectionsPresent,
        evidence_urls_present: uploadedEvidenceFiles.length > 0,
        evidence_files_accessible: uploadedEvidenceFiles.every((file) => /^https?:\/\//i.test(file.url)),
        sensitive_fields_removed: true,
        legacy_score_removed: true,
        team_lead_signature_valid: hasSignoff ? Boolean(signatureName) : null,
        ready_for_ai_evaluation: requiredSectionsPresent && warnings.length === 0,
        validation_warnings: warnings,
        // The live evaluator is CII v4.5 (see cii-v4-5.constants.ts / cii-v4-5-prompt.constant.ts).
        scoring_rubric: getCiiV45ScoringConfig(),
    };
}

/**
 * Builds the canonical CIEL PK Master AI Prompt input payload.
 * Excludes CNIC, legacy CII scores, section11 audit output, and other sensitive/internal fields.
 */
export function buildCielPkAiEvaluationPayload(report: StudentReport): CielPkAiEvaluationPayload {
    const section1Raw = asRecord(report.section1);
    const section2Raw = asRecord(report.section2);
    const section3Raw = asRecord(report.section3);
    const section4Raw = asRecord(report.section4);
    const section5Raw = asRecord(report.section5);
    const section6Raw = asRecord(report.section6);
    const section7Raw = asRecord(report.section7);
    const section8Raw = asRecord(report.section8);
    const section9Raw = asRecord(report.section9);
    const section10Raw = asRecord(report.section10);
    const student = asRecord(report.student);
    const opportunity = asRecord(report.opportunity);
    const timeline = asRecord(opportunity.timeline);
    const location = asRecord(opportunity.location);
    const requiredHours = resolveRequiredHours(report);
    const fallbackStudentId = pickString(student.id) || report.studentId;
    const lead = asRecord(section1Raw.team_lead);
    const teamMembers = asArray(section1Raw.team_members);
    const { files: uploadedEvidenceFiles, urlToFileId } = buildEvidenceRegistry(report);
    const section8 = mapSection8(section8Raw, urlToFileId);

    return {
        schema_version: CIEL_PK_AI_EVALUATION_SCHEMA_VERSION,
        evaluation_mode: 'master_ai_prompt',
        generated_at: new Date().toISOString(),
        submission_metadata: {
            submission_id: report.id,
            report_id: report.id,
            institution: {
                name: pickString(lead.university) || pickString(student.university),
                campus: pickString(location.city) || null,
            },
            student: {
                student_id: studentIdFromRow(lead, fallbackStudentId),
                full_name: pickString(student.name) || pickString(lead.fullName) || pickString(lead.name),
                email: pickString(student.email) || pickString(lead.email),
                program: pickString(lead.degree) || pickString(lead.program),
                department: pickString(student.department) || null,
                year_of_study: pickString(lead.year),
            },
            project: {
                project_id: pickString(report.project_id) || pickString(report.opportunityId) || report.id,
                project_title: pickString(opportunity.title) || pickString(section2Raw.problem_statement),
                opportunity_id: pickString(report.opportunityId) || pickString(opportunity.id),
                opportunity_title: pickString(opportunity.title),
                project_type: pickString(section1Raw.participation_type) || 'individual',
                project_category: pickString(section2Raw.problem_category) || pickString(report.problem_category),
                location: {
                    city: pickString(location.city),
                    province: pickString(location.province) || pickString(location.state),
                    country: pickString(location.country) || 'Pakistan',
                    site_name: pickString(location.site_name) || pickString(location.address),
                },
                start_date: pickString(timeline.start_date),
                end_date: pickString(timeline.end_date),
                required_hours_per_student: requiredHours,
                declared_team_size: teamMembers.length + 1,
            },
            submission_status: {
                student_submitted_at: pickIsoDate(report.reportSubmittedAt ?? report.submission_date),
                faculty_status: pickString(report.faculty_status),
                partner_status: pickString(report.partner_status),
                admin_status: pickString(report.admin_status),
                is_editable: false,
            },
        },
        section1_participation_identity_attendance: {
            team_lead: mapTeamLead(lead, fallbackStudentId),
            team_members: teamMembers.map((member) => mapTeamMember(asRecord(member), fallbackStudentId)),
            attendance_logs: asArray(section1Raw.attendance_logs).map((log) => mapAttendanceLog(asRecord(log), urlToFileId)),
            attendance_summary: buildAttendanceSummary(section1Raw, requiredHours),
        },
        section2_project_context_discipline: mapSection2(section2Raw, urlToFileId),
        section3_sdg_strategy_intent: mapSection3(section3Raw),
        section4_activities_outputs_scale: mapSection4(section4Raw),
        section5_outcomes_systemic_change: mapSection5(section5Raw, urlToFileId),
        section6_resources_mobilization: mapSection6(section6Raw, urlToFileId),
        section7_partnerships: mapSection7(section7Raw, section8Raw, urlToFileId),
        section8_evidence_verification: section8,
        section9_reflection_learning: mapSection9(section9Raw),
        section10_sustainability_continuation: mapSection10(section10Raw),
        uploaded_evidence_files: uploadedEvidenceFiles,
        system_validation: buildSystemValidation(report, uploadedEvidenceFiles, section8),
    };
}

export type CielPkAiEvaluationPayloadV45 = Omit<CielPkAiEvaluationPayload, 'schema_version'> & {
    schema_version: typeof CIEL_PK_AI_EVALUATION_SCHEMA_VERSION_V45;
    report_id: string;
    input_fingerprint: string;
};

/** Minimal surface this module needs from `S3Service` — kept narrow so this stays a plain util, not a NestJS provider. */
export interface EvidenceByteSource {
    getObjectBufferByPublicUrl(url: string): Promise<{ buffer: Buffer; contentType?: string } | null>;
}

function sha256Hex(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Stable, deterministic JSON stringify (sorted keys) so the fingerprint never changes merely
 * from object-key reordering — only from an actual change in content. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
        .join(',')}}`;
}

/**
 * Fingerprint binding a v5.0 evaluation to report sections + evidence identity (id/url/path/size).
 * Callable twice independently — once when the payload is built, again at Confirm — so a changed
 * fingerprint reveals the source moved and the stale result must not be published. Metadata only:
 * downloading every evidence file from S3 just to SHA-256 it made Run Analyzer wait tens of seconds
 * before the model even started, and Admin never sends originals to the model.
 */
export function computeCiiV45InputFingerprint(
    report: StudentReport,
    evidenceFiles: Array<{
        file_id: string;
        url?: string;
        storage_path?: string;
        file_integrity?: { sha256?: string | null; size_bytes?: number | null };
    }>,
): string {
    const sections = [
        report.section1, report.section2, report.section3, report.section4, report.section5,
        report.section6, report.section7, report.section8, report.section9, report.section10,
    ].map((section) => section ?? null);
    const evidence = evidenceFiles
        .map((f) => ({
            file_id: f.file_id,
            url: f.url ?? '',
            storage_path: f.storage_path ?? '',
            size_bytes: f.file_integrity?.size_bytes ?? null,
        }))
        .sort((a, b) => a.file_id.localeCompare(b.file_id));
    return sha256Hex(Buffer.from(stableStringify({ sections, evidence }), 'utf8'));
}

const CII_EVIDENCE_INSPECT_KEY = '__ciiEvidenceInspect';

export type CiiEvidenceInspectCache = Map<string, { buffer: Buffer; contentType?: string }>;

export function ciiEvidenceInspectCache(data: unknown): CiiEvidenceInspectCache | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const cache = Object.getOwnPropertyDescriptor(data, CII_EVIDENCE_INSPECT_KEY)?.value;
    return cache instanceof Map ? (cache as CiiEvidenceInspectCache) : undefined;
}

/**
 * v5.0 variant of `buildCielPkAiEvaluationPayload`: reuses every section mapper, then adds
 * `report_id` / `input_fingerprint`. Evidence bytes are not fetched — Admin scores originals in
 * Dimension 7, and the model is report-quality only.
 */
export async function buildCielPkAiEvaluationPayloadV45(
    report: StudentReport,
    _s3?: EvidenceByteSource,
): Promise<CielPkAiEvaluationPayloadV45> {
    void _s3;
    const base = buildCielPkAiEvaluationPayload(report);
    return {
        ...base,
        schema_version: CIEL_PK_AI_EVALUATION_SCHEMA_VERSION_V45,
        report_id: report.id,
        input_fingerprint: computeCiiV45InputFingerprint(report, base.uploaded_evidence_files),
    };
}

export function buildCiiV45InputCompletenessFromEvalPayload(
    payload: CielPkAiEvaluationPayloadV45,
): CiiV45InputCompleteness {
    const s1 = asRecord(payload.section1_participation_identity_attendance);
    const summary = asRecord(s1.attendance_summary);
    const required =
        pickNumber(summary.minimum_required_hours_per_student) ||
        pickNumber(asRecord(payload.submission_metadata).required_hours_per_student) ||
        16;
    const people = [asRecord(s1.team_lead), ...asArray(s1.team_members).map(asRecord)];
    const individualHours = people
        .map((person, index) => {
            const studentId =
                pickString(person.student_id) ||
                pickString(person.id) ||
                (index === 0 ? 'team_lead' : `member_${index}`);
            const hours =
                pickNumber(person.verified_hours) ??
                pickNumber(person.declared_hours) ??
                pickNumber(person.hours);
            const hasHours = typeof hours === 'number' && Number.isFinite(hours);
            return {
                studentId,
                hours: hasHours ? hours : null,
                requiredHours: required,
                verified: true,
                recordComplete: hasHours,
            };
        })
        .filter((row, index, rows) => rows.findIndex((other) => other.studentId === row.studentId) === index);
    if (!individualHours.length) {
        individualHours.push({
            studentId: payload.report_id || 'unknown',
            hours: null,
            requiredHours: required,
            verified: false,
            recordComplete: false,
        });
    }
    const sys = asRecord(payload.system_validation);
    const gaps: CiiV45InputCompleteness['gaps'] = [];
    if (sys.required_sections_present === false) {
        gaps.push({ type: 'SYSTEM_DATA_GAP', material: true });
    }
    let mandatoryFieldsComplete = sys.required_sections_present !== false;
    if (sys.team_lead_signature_valid === false) {
        gaps.push({
            type: 'SIGNATURE_INVALID',
            material: true,
            mandatory: true,
            field: 'signature_name',
        });
        mandatoryFieldsComplete = false;
    }
    return {
        gaps,
        individualHours,
        mandatoryFieldsComplete,
    };
}

/** Ranking eligibility only — never used to rewrite CII. Team totals do not count. */
export function reportIndividualHoursMet(report: StudentReport): boolean {
    const required = resolveRequiredHours(report);
    const summary = buildAttendanceSummary(asRecord(report.section1) || {}, required);
    return summary.required_hours_met === true;
}

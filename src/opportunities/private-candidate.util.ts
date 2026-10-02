/** Student-created opportunity using the Private / Independent Candidate pathway (no faculty gate). */
import { BadRequestException } from '@nestjs/common';
import { normalizeE164Phone, validateVerificationPhone } from '../common/phone-e164.util';
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

/** Stored opportunity: private / independent candidate — no faculty report reviewer. */
export function isPrivateCandidateOpportunity(
    opp:
        | {
              faculty_verification_status?: string | null;
              facultyApprovalStatus?: string | null;
              executing_context?: unknown;
              supervision?: unknown;
          }
        | null
        | undefined,
): boolean {
    if (!opp) return false;
    if (isPrivateCandidateDto(opp)) return true;
    const facultyLine = String(opp.faculty_verification_status || '').toLowerCase();
    return facultyLine === 'not_required';
}

export type ReportReviewRoute = 'ciel_pk' | 'faculty';

export function reviewRouteForOpportunity(
    opp: Parameters<typeof isPrivateCandidateOpportunity>[0],
): ReportReviewRoute {
    return isPrivateCandidateOpportunity(opp) ? 'ciel_pk' : 'faculty';
}

type PhoneSyncDto = {
    student_contact?: string;
    executing_context?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function pickRawPrivatePhone(dto: PhoneSyncDto): string {
    const ex = asRecord(dto.executing_context);
    const pc = asRecord(ex?.private_candidate);
    const ind = asRecord(ex?.independent_community_activity);
    const nested =
        (typeof pc?.phone === 'string' && pc.phone) ||
        (typeof ind?.contact_number === 'string' && ind.contact_number) ||
        '';
    const top = typeof dto.student_contact === 'string' ? dto.student_contact : '';
    return (nested || top).trim();
}

function writeCanonicalPhone(dto: PhoneSyncDto, e164: string): void {
    dto.student_contact = e164;
    const ex = asRecord(dto.executing_context);
    if (!ex) return;
    const pc = asRecord(ex.private_candidate);
    if (pc) pc.phone = e164;
    const ind = asRecord(ex.independent_community_activity);
    if (ind) ind.contact_number = e164;
}

/**
 * Keep `student_contact` + nested private-candidate phone on the same E.164 value the
 * student form sends (`+923001234567`). Full submit requires a valid number; drafts only
 * canonicalize whatever is already present.
 */
export function applyCanonicalPrivateCandidatePhone(
    dto: PhoneSyncDto,
    opts: { required: boolean },
): void {
    if (!isPrivateCandidateDto(dto)) {
        if (typeof dto.student_contact === 'string' && dto.student_contact.trim()) {
            dto.student_contact = normalizeE164Phone(dto.student_contact) || dto.student_contact.trim();
        }
        return;
    }

    const raw = pickRawPrivatePhone(dto);
    if (opts.required) {
        const err = validateVerificationPhone(raw);
        if (err) throw new BadRequestException(err);
        writeCanonicalPhone(dto, normalizeE164Phone(raw));
        return;
    }
    if (!raw) return;
    const e164 = normalizeE164Phone(raw);
    if (e164) writeCanonicalPhone(dto, e164);
}

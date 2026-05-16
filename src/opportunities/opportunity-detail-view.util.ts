import { Opportunity } from './entities/opportunity.entity';

/** Max characters stored for student_responsibilities on new submissions. */
export const STUDENT_RESPONSIBILITIES_MAX_LENGTH = 12_000;

const RESPONSIBILITIES_PREVIEW_MAX = 1_500;

export type OpportunityDetailView = {
    overview: {
        title: string;
        types: string[];
        mode: string | null;
        visibility: string | null;
    };
    timeline: {
        type: string | null;
        start_date: string | null;
        end_date: string | null;
        from_time: string | null;
        to_time: string | null;
        expected_hours: number | null;
        volunteers_required: number | null;
    };
    location: {
        city: string | null;
        venue: string | null;
        pin: string | null;
    };
    objectives: {
        description: string;
        description_items: string[];
        beneficiaries_count: number | null;
        beneficiaries_type: string[];
    };
    sdg: {
        primary: Record<string, unknown> | null;
        secondary: unknown[];
    };
    activity: {
        student_responsibilities: string;
        student_responsibilities_preview: string;
        student_responsibilities_is_long: boolean;
        skills_gained: string[];
    };
    supervision: {
        faculty: {
            name: string | null;
            role: string | null;
            email: string | null;
            department: string | null;
            university: string | null;
        };
        partner: {
            organization: string | null;
            contact_person: string | null;
            email: string | null;
        };
        declarations: {
            safe_environment: boolean;
            supervised: boolean;
            information_accurate: boolean;
        };
    };
    participation_scope: Record<string, unknown> | null;
    executing_context: Record<string, unknown> | null;
    verification_method: string[];
};

function pickStr(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function pickNum(v: unknown): number | null {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.trim()) {
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
    }
    return null;
}

/** Split numbered objective lines (e.g. "1-Improve…", "2-Increase…") for cleaner UI lists. */
export function splitNumberedDescriptionItems(text: string): string[] {
    const t = String(text || '').trim();
    if (!t) return [];
    const byNewline = t.split(/\n(?=\s*\d+[-.)]\s*)/).map((s) => s.trim()).filter(Boolean);
    if (byNewline.length > 1) return byNewline;
    return [t];
}

export function previewLongText(
    text: string,
    max = RESPONSIBILITIES_PREVIEW_MAX,
): { full: string; preview: string; isLong: boolean } {
    const full = String(text || '').trim();
    if (full.length <= max) {
        return { full, preview: full, isLong: false };
    }
    const cut = full.slice(0, max);
    const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
    const previewBase = lastBreak > max * 0.4 ? cut.slice(0, lastBreak) : cut;
    return {
        full,
        preview: `${previewBase.trim()}\n\n…`,
        isLong: true,
    };
}

export function buildOpportunityDetailView(opp: Opportunity): OpportunityDetailView {
    const sup = (opp.supervision && typeof opp.supervision === 'object' ? opp.supervision : {}) as Record<
        string,
        unknown
    >;
    const act =
        opp.activity_details && typeof opp.activity_details === 'object'
            ? (opp.activity_details as Record<string, unknown>)
            : {};
    const obj =
        opp.objectives && typeof opp.objectives === 'object' ? (opp.objectives as Record<string, unknown>) : {};
    const loc = opp.location && typeof opp.location === 'object' ? (opp.location as Record<string, unknown>) : {};
    const timeline =
        opp.timeline && typeof opp.timeline === 'object' ? (opp.timeline as Record<string, unknown>) : {};

    const partnerOrg =
        pickStr(sup.partner_org_name) ||
        pickStr(sup.external_partner_org_name) ||
        pickStr(
            (opp.partner_organization as Record<string, unknown> | undefined)?.organization_name,
        ) ||
        pickStr(
            (opp.external_partner_collaboration as Record<string, unknown> | undefined)?.organization_name,
        ) ||
        pickStr(
            ((opp.executing_context as Record<string, unknown> | undefined)?.partner as Record<string, unknown>)
                ?.organization_name,
        );

    const partnerEmail =
        pickStr(sup.partner_email) ||
        pickStr(sup.external_partner_email) ||
        pickStr((opp.partner_organization as Record<string, unknown> | undefined)?.official_email) ||
        pickStr((opp.external_partner_collaboration as Record<string, unknown> | undefined)?.official_email);

    const partnerPerson =
        pickStr(sup.partner_contact_person) ||
        pickStr(sup.external_partner_contact_person) ||
        pickStr((opp.partner_organization as Record<string, unknown> | undefined)?.contact_person) ||
        pickStr((opp.external_partner_collaboration as Record<string, unknown> | undefined)?.contact_person);

    const objDescription = pickStr(obj.description);
    const responsibilities = pickStr(act.student_responsibilities);
    const respPreview = previewLongText(responsibilities);

    const beneficiariesType = Array.isArray(obj.beneficiaries_type)
        ? (obj.beneficiaries_type as unknown[]).map((x) => String(x)).filter(Boolean)
        : [];

    return {
        overview: {
            title: pickStr(opp.title) || 'Untitled opportunity',
            types: Array.isArray(opp.types) ? opp.types.filter((x): x is string => typeof x === 'string') : [],
            mode: pickStr(opp.mode) || null,
            visibility: pickStr(opp.visibility) || null,
        },
        timeline: {
            type: pickStr(timeline.type) || null,
            start_date: pickStr(timeline.start_date) || null,
            end_date: pickStr(timeline.end_date) || null,
            from_time: pickStr(timeline.from_time) || null,
            to_time: pickStr(timeline.to_time) || null,
            expected_hours: pickNum(timeline.expected_hours),
            volunteers_required: pickNum(timeline.volunteers_required),
        },
        location: {
            city: pickStr(loc.city) || null,
            venue: pickStr(loc.venue) || null,
            pin: pickStr(loc.pin) || null,
        },
        objectives: {
            description: objDescription,
            description_items: splitNumberedDescriptionItems(objDescription),
            beneficiaries_count: pickNum(obj.beneficiaries_count),
            beneficiaries_type: beneficiariesType,
        },
        sdg: {
            primary:
                opp.sdg_info && typeof opp.sdg_info === 'object'
                    ? (opp.sdg_info as Record<string, unknown>)
                    : null,
            secondary: Array.isArray(opp.secondary_sdgs) ? opp.secondary_sdgs : [],
        },
        activity: {
            student_responsibilities: respPreview.full,
            student_responsibilities_preview: respPreview.preview,
            student_responsibilities_is_long: respPreview.isLong,
            skills_gained: Array.isArray(act.skills_gained)
                ? (act.skills_gained as unknown[]).map((x) => String(x)).filter(Boolean)
                : [],
        },
        supervision: {
            faculty: {
                name: pickStr(sup.supervisor_name) || null,
                role: pickStr(sup.role) || null,
                email: pickStr(sup.contact) || null,
                department: pickStr(sup.faculty_department) || null,
                university: pickStr(sup.faculty_university_name) || null,
            },
            partner: {
                organization: partnerOrg || null,
                contact_person: partnerPerson || null,
                email: partnerEmail || null,
            },
            declarations: {
                safe_environment: sup.safe_environment === true,
                supervised: sup.supervised === true,
                information_accurate: sup.information_accurate === true,
            },
        },
        participation_scope:
            opp.participation_scope && typeof opp.participation_scope === 'object'
                ? (opp.participation_scope as Record<string, unknown>)
                : null,
        executing_context:
            opp.executing_context && typeof opp.executing_context === 'object'
                ? (opp.executing_context as Record<string, unknown>)
                : null,
        verification_method: Array.isArray(opp.verification_method)
            ? opp.verification_method.filter((x): x is string => typeof x === 'string')
            : [],
    };
}

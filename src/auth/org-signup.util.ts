/** Shared signup mapping for university / NGO / corporate — keep user.name and org contact in sync. */

const ORG_SIGNUP_ROLES = new Set(['university', 'ngo', 'corporate']);

/** Public /signup roles only — admin and organization_admin are created internally. */
export const PUBLIC_SIGNUP_ROLES = ['student', 'faculty', 'university', 'ngo', 'corporate'] as const;
export type PublicSignupRole = (typeof PUBLIC_SIGNUP_ROLES)[number];

export function isPublicSignupRole(role: string | undefined | null): boolean {
    return PUBLIC_SIGNUP_ROLES.includes(
        String(role || '').trim().toLowerCase() as PublicSignupRole,
    );
}

export function isOrgSignupRole(role: string | undefined | null): boolean {
    return ORG_SIGNUP_ROLES.has(String(role || '').trim().toLowerCase());
}

/** Copy institution → university and department → faculty_department so profile gates match signup fields. */
export function applyAcademicSignupFields(input: {
    role: string;
    institution?: string;
    university?: string;
    department?: string;
    faculty_department?: string;
}): { university?: string; faculty_department?: string } {
    const role = String(input.role || '')
        .trim()
        .toLowerCase();
    const next: { university?: string; faculty_department?: string } = {};
    if (role === 'student' || role === 'faculty') {
        const uni = (input.university || input.institution || '').trim();
        if (uni) next.university = uni;
    }
    if (role === 'faculty') {
        const dept = (input.faculty_department || input.department || '').trim();
        if (dept) next.faculty_department = dept;
    }
    return next;
}

export function composeSignupContactPhone(
    countryCode?: string | null,
    phone?: string | null,
): string | undefined {
    const rawPhone = (phone ?? '').trim();
    if (!rawPhone) return undefined;
    if (rawPhone.startsWith('+')) return rawPhone;
    const national = rawPhone.replace(/\D/g, '');
    if (!national) return undefined;
    const dial = (countryCode ?? '').trim().replace(/\D/g, '');
    if (!dial) return rawPhone;
    if (national.startsWith(dial)) return `+${national}`;
    return `+${dial}${national}`;
}

export function resolveOrgSignupAccount(input: {
    role: string;
    name?: string;
    contactPerson?: string;
    orgName?: string;
}): {
    name: string;
    contactPerson: string;
    orgName: string;
    institution?: string;
    university?: string;
} {
    const contact = (input.contactPerson || input.name || '').trim();
    const orgName = (input.orgName || '').trim();
    const next: {
        name: string;
        contactPerson: string;
        orgName: string;
        institution?: string;
        university?: string;
    } = { name: contact, contactPerson: contact, orgName };
    if (String(input.role).toLowerCase() === 'university' && orgName) {
        next.institution = orgName;
        next.university = orgName;
    }
    return next;
}

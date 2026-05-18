import { User } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';

/** Same as opportunity flow: `User.name` or linked `Organization.contactName`. */
export function resolveDisplayNameForProfile(user: User): string | undefined {
    const fromUser = typeof user.name === 'string' ? user.name.trim() : '';
    if (fromUser) return fromUser;
    const fromOrg =
        user.organization?.contactName != null ? String(user.organization.contactName).trim() : '';
    return fromOrg || undefined;
}

export function resolvePhoneForProfile(user: User): string {
    const org = user.organization;
    return (
        (typeof user.phone === 'string' && user.phone.trim()) ||
        (org?.contactPhone && String(org.contactPhone).trim()) ||
        ''
    );
}

/** `User.city`, or for university partners the linked organization's city. */
export function resolveCityForProfile(user: User): string {
    const fromUser = typeof user.city === 'string' ? user.city.trim() : '';
    if (fromUser) return fromUser;
    if (user.role !== UserRole.UNIVERSITY) return '';
    const fromOrg =
        user.organization?.city != null ? String(user.organization.city).trim() : '';
    return fromOrg || '';
}

/** Academic institution on the user, or organization name for university partner accounts. */
export function resolveUniversityForProfile(user: User): string {
    const fromUser =
        (typeof user.university === 'string' && user.university.trim()) ||
        (typeof user.institution === 'string' && user.institution.trim()) ||
        (typeof user.orgName === 'string' && user.orgName.trim()) ||
        '';
    if (fromUser) return fromUser;
    if (user.role !== UserRole.UNIVERSITY) return '';
    const fromOrg =
        user.organization?.name != null ? String(user.organization.name).trim() : '';
    return fromOrg || '';
}

/**
 * Mirrors `OpportunitiesService.ensureProfileComplete` so admins and submissions use the same rules.
 */
export function getProfileCompletionStatus(user: User): {
    profile_complete: boolean;
    profile_missing_fields: string[];
} {
    const missing: string[] = [];
    const requiresAcademicProfile = [UserRole.STUDENT, UserRole.FACULTY, UserRole.UNIVERSITY].includes(user.role);
    const resolvedName = resolveDisplayNameForProfile(user) || '';
    if (!resolvedName) missing.push('name');
    if (!resolvePhoneForProfile(user)) missing.push('phone');
    if (!user.email) missing.push('email');
    if (requiresAcademicProfile && !resolveCityForProfile(user)) missing.push('city');
    if (requiresAcademicProfile && !resolveUniversityForProfile(user)) missing.push('university');
    if (user.role === UserRole.STUDENT && !user.department) missing.push('department');
    if (user.role === UserRole.FACULTY && !user.faculty_department) missing.push('faculty_department');
    if (user.requires_cnic && !user.cnic) missing.push('cnic');
    if (user.requires_profile_verification && !user.profile_verified) {
        missing.push('profile_verified');
    }
    return { profile_complete: missing.length === 0, profile_missing_fields: missing };
}

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
    if (requiresAcademicProfile && !user.city) missing.push('city');
    if (requiresAcademicProfile && !user.university && !user.institution) missing.push('university');
    if (user.role === UserRole.STUDENT && !user.department) missing.push('department');
    if (user.role === UserRole.FACULTY && !user.faculty_department) missing.push('faculty_department');
    if (user.requires_cnic && !user.cnic) missing.push('cnic');
    if (user.requires_profile_verification && !user.profile_verified) {
        missing.push('profile_verified');
    }
    return { profile_complete: missing.length === 0, profile_missing_fields: missing };
}

import {
    applyAcademicSignupFields,
    composeSignupContactPhone,
    isOrgSignupRole,
    isPublicSignupRole,
    resolveOrgSignupAccount,
} from './org-signup.util';

describe('org signup mapping', () => {
    it('treats university, ngo, and corporate as org roles', () => {
        expect(isOrgSignupRole('university')).toBe(true);
        expect(isOrgSignupRole('ngo')).toBe(true);
        expect(isOrgSignupRole('corporate')).toBe(true);
        expect(isOrgSignupRole('student')).toBe(false);
        expect(isOrgSignupRole('faculty')).toBe(false);
    });

    it('allows only public signup roles', () => {
        expect(isPublicSignupRole('student')).toBe(true);
        expect(isPublicSignupRole('faculty')).toBe(true);
        expect(isPublicSignupRole('university')).toBe(true);
        expect(isPublicSignupRole('ngo')).toBe(true);
        expect(isPublicSignupRole('corporate')).toBe(true);
        expect(isPublicSignupRole('admin')).toBe(false);
        expect(isPublicSignupRole('organization_admin')).toBe(false);
    });

    it('uses lead official as the account name when name was left blank', () => {
        const mapped = resolveOrgSignupAccount({
            role: 'university',
            name: '',
            contactPerson: 'Dr. Sara Ahmed',
            orgName: 'Beaconhouse National University',
        });
        expect(mapped.name).toBe('Dr. Sara Ahmed');
        expect(mapped.contactPerson).toBe('Dr. Sara Ahmed');
        expect(mapped.orgName).toBe('Beaconhouse National University');
        expect(mapped.institution).toBe('Beaconhouse National University');
        expect(mapped.university).toBe('Beaconhouse National University');
    });

    it('does not copy institution onto NGO accounts', () => {
        const mapped = resolveOrgSignupAccount({
            role: 'ngo',
            contactPerson: 'Ali Raza',
            orgName: 'Akhuwat Foundation',
        });
        expect(mapped.name).toBe('Ali Raza');
        expect(mapped.institution).toBeUndefined();
    });

    it('copies institution onto university and department onto faculty_department', () => {
        expect(
            applyAcademicSignupFields({
                role: 'student',
                institution: 'LUMS',
            }),
        ).toEqual({ university: 'LUMS' });
        expect(
            applyAcademicSignupFields({
                role: 'faculty',
                institution: 'NUST',
                department: 'Computer Science',
            }),
        ).toEqual({ university: 'NUST', faculty_department: 'Computer Science' });
        expect(applyAcademicSignupFields({ role: 'ngo', institution: 'X', department: 'Y' })).toEqual({});
    });

    it('composes E.164 from dial code + national digits', () => {
        expect(composeSignupContactPhone('+92', '3001234567')).toBe('+923001234567');
        expect(composeSignupContactPhone('+92', '+923001234567')).toBe('+923001234567');
    });
});

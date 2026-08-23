import { User } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';
import { Organization } from '../organizations/entities/organization.entity';
import { getProfileCompletionStatus } from './profile-completion.util';

function baseUniversityUser(overrides: Partial<User> = {}): User {
    return {
        id: 'u1',
        name: 'Ops Lead',
        email: 'ops@uni.edu.pk',
        password: 'hash',
        role: UserRole.UNIVERSITY,
        organization: {
            id: 'org1',
            name: 'Beaconhouse National University',
            orgType: 'UNIVERSITY',
            city: 'Lahore',
            contactPhone: '+923001234567',
        } as Organization,
        ...overrides,
    } as User;
}

describe('getProfileCompletionStatus (university partners)', () => {
    it('accepts city and university from linked organization when user fields are empty', () => {
        const user = baseUniversityUser({ city: undefined, university: undefined, institution: undefined });
        const status = getProfileCompletionStatus(user);
        expect(status.profile_complete).toBe(true);
        expect(status.profile_missing_fields).toEqual([]);
    });

    it('still requires city when neither user nor organization has it', () => {
        const user = baseUniversityUser({
            organization: {
                ...baseUniversityUser().organization!,
                city: undefined,
            } as unknown as Organization,
        });
        const status = getProfileCompletionStatus(user);
        expect(status.profile_missing_fields).toContain('city');
    });

    it('still requires university when neither user nor organization has a name', () => {
        const user = baseUniversityUser({
            organization: {
                ...baseUniversityUser().organization!,
                name: '',
            } as Organization,
        });
        const status = getProfileCompletionStatus(user);
        expect(status.profile_missing_fields).toContain('university');
    });
});

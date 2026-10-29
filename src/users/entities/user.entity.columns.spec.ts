import { getMetadataArgsStorage } from 'typeorm';
import { User } from './user.entity';

/**
 * `users` is read on every authenticated request (JwtStrategy loads the whole row). On production,
 * TypeORM synchronize could not add a column to it under live traffic, and the deployed code then
 * failed every sign-in. Store new per-user data in its own table instead (e.g.
 * faculty_university_confirmations). Change this list only together with a plan that adds the column
 * to production before the code that reads it is deployed.
 */
const DEPLOYED_USER_COLUMNS = [
  'id',
  'name',
  'email',
  'password',
  'passwordRecord',
  'institution',
  'department',
  'enrollmentYear',
  'faculty_department',
  'orgName',
  'orgType',
  'contactPerson',
  'role',
  'status',
  'cnic',
  'countryCode',
  'phone',
  'avatar',
  'university',
  'registrationNumber',
  'major',
  'city',
  'bio',
  'interests',
  'sdgPreferences',
  'createdAt',
  'updatedAt',
  'settings',
  'passwordResetToken',
  'passwordResetExpiry',
  'tokenVersion',
  'termsAcceptedAt',
  'requires_cnic',
  'requires_profile_verification',
  'profile_verified',
  'identity_verified',
  'ssoIssuer',
  'ssoSubject',
];

describe('User entity columns', () => {
  it('match the columns deployed on production (users is on every sign-in)', () => {
    const columns = getMetadataArgsStorage()
      .columns.filter((c) => c.target === User)
      .map((c) => c.propertyName);
    expect([...columns].sort()).toEqual([...DEPLOYED_USER_COLUMNS].sort());
  });
});

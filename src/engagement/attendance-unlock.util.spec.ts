import {
    computeAcademicCompletionPercent,
    isTeamConfigurationComplete,
    resolveAttendanceUnlockStatus,
    resolveIdentityVerificationStatus,
} from './attendance-unlock.util';
import { Participation } from './entities/participant.entity';
import { User } from '../users/entities/user.entity';

const baseParticipation = {
    participationMode: 'team',
    attendanceLocked: false,
    adminAttendanceEditable: false,
    emailVerified: true,
    mobileVerified: true,
    cnicHash: 'hash',
    universityName: 'Test University',
    academicProgram: 'CS',
    yearOfStudy: '3rd Year',
    academicIntegrationType: 'Course-Linked',
    department: 'CS',
} as Participation;

const baseUser = {
    profile_verified: true,
    identity_verified: true,
    cnic: '12345',
} as User;

describe('attendance-unlock.util', () => {
    it('returns unlocked when admin override is enabled', () => {
        const result = resolveAttendanceUnlockStatus(
            null,
            { ...baseParticipation, adminAttendanceEditable: true, attendanceLocked: true } as Participation,
            false,
        );

        expect(result).toEqual({
            unlocked: true,
            status: 'Unlocked',
            missing: [],
            admin_override: true,
        });
    });

    it('locks when identity verification is incomplete', () => {
        const result = resolveAttendanceUnlockStatus(
            { ...baseUser, identity_verified: false } as User,
            baseParticipation,
            true,
        );

        expect(result.unlocked).toBe(false);
        expect(result.missing).toContain('identity_verification');
    });

    it('locks when attendance verification has been requested', () => {
        const result = resolveAttendanceUnlockStatus(
            baseUser,
            { ...baseParticipation, attendanceLocked: true } as Participation,
            true,
        );

        expect(result.unlocked).toBe(false);
        expect(result.missing).toContain('attendance_locked');
    });

    it('requires at least two team members for team configuration', () => {
        expect(isTeamConfigurationComplete([baseParticipation])).toBe(false);
        expect(
            isTeamConfigurationComplete([
                baseParticipation,
                { ...baseParticipation, id: 'member-2' } as Participation,
            ]),
        ).toBe(true);
    });

    it('computes academic completion percent from participation fields', () => {
        expect(computeAcademicCompletionPercent(baseParticipation, baseUser)).toBe(100);
        expect(
            computeAcademicCompletionPercent(
                { ...baseParticipation, academicProgram: null } as Participation,
                baseUser,
            ),
        ).toBe(80);
    });

    it('marks identity as verified only when all checks pass', () => {
        expect(resolveIdentityVerificationStatus(baseUser, baseParticipation)).toBe('verified');
        expect(
            resolveIdentityVerificationStatus(
                { ...baseUser, profile_verified: false } as User,
                baseParticipation,
            ),
        ).toBe('pending');
    });
});

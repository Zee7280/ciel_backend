import { canUserActOnAttendanceQueue } from './attendance-approver.util';
import { UserRole } from '../users/enums/user-role.enum';

describe('canUserActOnAttendanceQueue', () => {
    const pendingLog = {
        approvalStatus: 'pending' as const,
        assignedApproverUserId: null as string | null,
        assignedApproverType: null as string | null,
    };

    it('allows opportunity creator to act on legacy partner-queue rows', () => {
        const creatorId = 'ngo-user-uuid';
        expect(
            canUserActOnAttendanceQueue(
                creatorId,
                UserRole.NGO,
                'ngo@example.com',
                {
                    ...pendingLog,
                    assignedApproverType: 'partner',
                    assignedApproverUserId: null,
                },
                [],
                creatorId,
            ),
        ).toBe(true);

        expect(
            canUserActOnAttendanceQueue(
                'other-user',
                UserRole.NGO,
                'other@example.com',
                {
                    ...pendingLog,
                    assignedApproverType: 'partner',
                    assignedApproverUserId: null,
                },
                [],
                creatorId,
            ),
        ).toBe(false);
    });

    it('allows super admin on legacy admin-queue rows', () => {
        expect(
            canUserActOnAttendanceQueue(
                'admin-1',
                UserRole.SUPER_ADMIN,
                'admin@example.com',
                {
                    ...pendingLog,
                    assignedApproverType: 'admin',
                    assignedApproverUserId: null,
                },
                [],
                null,
            ),
        ).toBe(true);

        expect(
            canUserActOnAttendanceQueue(
                'faculty-1',
                UserRole.FACULTY,
                'faculty@example.com',
                {
                    ...pendingLog,
                    assignedApproverType: 'admin',
                    assignedApproverUserId: null,
                },
                [],
                null,
            ),
        ).toBe(false);
    });

    it('requires faculty role for faculty-queue rows', () => {
        expect(
            canUserActOnAttendanceQueue(
                'faculty-1',
                UserRole.FACULTY,
                'faculty@example.com',
                {
                    ...pendingLog,
                    assignedApproverType: 'faculty',
                    assignedApproverUserId: 'faculty-1',
                },
                ['faculty@example.com'],
                null,
            ),
        ).toBe(true);
    });
});

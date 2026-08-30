import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PathsService } from './paths.service';

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>) {
    return Object.entries(where).every(([k, v]) => row[k] === v);
}

function makeInviteRepo() {
    const rows: Array<Record<string, unknown>> = [];
    let nextId = 1;
    return {
        rows,
        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
        save: jest.fn(async (row: Record<string, unknown>) => {
            if (!row.id) {
                row.id = `invite-${nextId++}`;
                rows.push(row);
                return row;
            }
            const idx = rows.findIndex((r) => r.id === row.id);
            if (idx === -1) rows.push(row);
            else rows[idx] = row;
            return row;
        }),
        find: jest.fn(async (opts: { where?: Record<string, unknown> } = {}) =>
            rows.filter((r) => matchesWhere(r, opts.where ?? {})),
        ),
        findOne: jest.fn(async (opts: { where?: Record<string, unknown> } = {}) =>
            rows.find((r) => matchesWhere(r, opts.where ?? {})) ?? null,
        ),
    };
}

describe('PathsService — team member invites', () => {
    const makeService = (overrides: { inviteRepo?: ReturnType<typeof makeInviteRepo> } = {}) => {
        const inviteRepo = overrides.inviteRepo ?? makeInviteRepo();
        const mailService = { sendPathTeamInvite: jest.fn().mockResolvedValue(undefined) };
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const courseProjectRepo = {
            findOne: jest.fn().mockResolvedValue({ id: 'entry-1', projectTitle: 'My Report', course: null }),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const fypRepo = { findOne: jest.fn().mockResolvedValue(null) };
        const ventureRepo = { findOne: jest.fn().mockResolvedValue(null) };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ name: 'Ada Lovelace' }) };
        const organizationsRepo = {};

        const service = new PathsService(
            courseProjectRepo as any,
            fypRepo as any,
            ventureRepo as any,
            inviteRepo as any,
            usersRepo as any,
            organizationsRepo as any,
            mailService as any,
            notificationsService as any,
            {} as any,
        );
        return { service, inviteRepo, mailService, courseProjectRepo, notificationsService };
    };

    it('creates exactly one invite for a set of member emails, deduped case/whitespace-insensitively, and skips members with no email', async () => {
        const { service, inviteRepo, mailService } = makeService();

        await (service as any).syncTeamInvites(
            'course_project',
            'entry-1',
            'user-1',
            'Ada',
            'Course Project',
            'My Report',
            [
                { name: 'Bob', email: 'Bob@Test.com ' },
                { name: 'Bob duplicate', email: ' bob@test.com' },
                { name: 'No email yet' },
            ],
        );

        expect(inviteRepo.rows).toHaveLength(1);
        expect(inviteRepo.rows[0].email).toBe('bob@test.com');
        expect(inviteRepo.rows[0].status).toBe('pending');
        expect(inviteRepo.rows[0].invitedByUserId).toBe('user-1');
        expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
        expect(mailService.sendPathTeamInvite).toHaveBeenCalledWith(
            'bob@test.com',
            expect.objectContaining({ inviterName: 'Ada', kindLabel: 'Course Project', title: 'My Report' }),
        );
    });

    it('does not re-invite (or re-send mail for) an email already invited for the same entry', async () => {
        const { service, inviteRepo, mailService } = makeService();
        const args: [string, string, string, string, string, string, unknown[]] = [
            'course_project',
            'entry-1',
            'user-1',
            'Ada',
            'Course Project',
            'My Report',
            [{ name: 'Bob', email: 'bob@test.com' }],
        ];

        await (service as any).syncTeamInvites(...args);
        await (service as any).syncTeamInvites(...args);

        expect(inviteRepo.rows).toHaveLength(1);
        expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
    });

    it('invites separately-keyed entries independently, even with the same email', async () => {
        const { service, inviteRepo } = makeService();
        await (service as any).syncTeamInvites('course_project', 'entry-1', 'user-1', 'Ada', 'Course Project', 'Report A', [{ email: 'bob@test.com' }]);
        await (service as any).syncTeamInvites('course_project', 'entry-2', 'user-1', 'Ada', 'Course Project', 'Report B', [{ email: 'bob@test.com' }]);

        expect(inviteRepo.rows).toHaveLength(2);
        expect(new Set(inviteRepo.rows.map((r) => r.entryId))).toEqual(new Set(['entry-1', 'entry-2']));
    });

    it('acceptTeamInvite rejects when the signed-in email does not match the invite email', async () => {
        const inviteRepo = makeInviteRepo();
        inviteRepo.rows.push({
            id: 'invite-1',
            kind: 'course_project',
            entryId: 'entry-1',
            email: 'bob@test.com',
            token: 'tok-1',
            status: 'pending',
            invitedByUserId: 'user-1',
            expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        });
        const { service } = makeService({ inviteRepo });

        await expect(service.acceptTeamInvite('tok-1', 'user-2', 'someone-else@test.com')).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('acceptTeamInvite rejects an expired pending invite', async () => {
        const inviteRepo = makeInviteRepo();
        inviteRepo.rows.push({
            id: 'invite-1',
            kind: 'course_project',
            entryId: 'entry-1',
            email: 'bob@test.com',
            token: 'tok-1',
            status: 'pending',
            invitedByUserId: 'user-1',
            expiresAt: new Date(Date.now() - 1000),
        });
        const { service } = makeService({ inviteRepo });

        await expect(service.acceptTeamInvite('tok-1', 'user-2', 'bob@test.com')).rejects.toThrow(
            BadRequestException,
        );
    });

    it('acceptTeamInvite throws NotFoundException for an unknown token', async () => {
        const { service } = makeService();
        await expect(service.acceptTeamInvite('nope', 'user-2', 'bob@test.com')).rejects.toThrow(NotFoundException);
    });

    it('acceptTeamInvite marks a valid invite accepted and records who/when', async () => {
        const inviteRepo = makeInviteRepo();
        inviteRepo.rows.push({
            id: 'invite-1',
            kind: 'course_project',
            entryId: 'entry-1',
            email: 'bob@test.com',
            token: 'tok-1',
            status: 'pending',
            invitedByUserId: 'user-1',
            expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        });
        const { service } = makeService({ inviteRepo });

        const result = await service.acceptTeamInvite('tok-1', 'user-2', ' Bob@Test.com ');

        expect(result).toEqual(expect.objectContaining({ kind: 'course_project', entryId: 'entry-1' }));
        expect(inviteRepo.rows[0].status).toBe('accepted');
        expect(inviteRepo.rows[0].acceptedByUserId).toBe('user-2');
        expect(inviteRepo.rows[0].acceptedAt).toBeInstanceOf(Date);
    });

    it('resendTeamInvite rejects a requester who did not send the original invite', async () => {
        const inviteRepo = makeInviteRepo();
        inviteRepo.rows.push({
            id: 'invite-1',
            kind: 'course_project',
            entryId: 'entry-1',
            email: 'bob@test.com',
            token: 'tok-1',
            status: 'pending',
            invitedByUserId: 'user-1',
            expiresAt: new Date(Date.now() + 1000),
        });
        const { service } = makeService({ inviteRepo });

        await expect(
            service.resendTeamInvite('some-other-user', 'course_project', 'entry-1', 'bob@test.com'),
        ).rejects.toThrow(ForbiddenException);
    });

    it('resendTeamInvite extends expiry and re-sends mail for the owner', async () => {
        const inviteRepo = makeInviteRepo();
        const originalExpiry = new Date(Date.now() + 1000);
        inviteRepo.rows.push({
            id: 'invite-1',
            kind: 'course_project',
            entryId: 'entry-1',
            email: 'bob@test.com',
            token: 'tok-1',
            status: 'pending',
            invitedByUserId: 'user-1',
            expiresAt: originalExpiry,
        });
        const { service, mailService } = makeService({ inviteRepo });

        const result = await service.resendTeamInvite('user-1', 'course_project', 'entry-1', 'bob@test.com');

        expect(result).toEqual({ success: true });
        expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
        expect((inviteRepo.rows[0].expiresAt as Date).getTime()).toBeGreaterThan(originalExpiry.getTime());
    });

    it('resendTeamInvite is a no-op success once already accepted', async () => {
        const inviteRepo = makeInviteRepo();
        inviteRepo.rows.push({
            id: 'invite-1',
            kind: 'course_project',
            entryId: 'entry-1',
            email: 'bob@test.com',
            token: 'tok-1',
            status: 'accepted',
            invitedByUserId: 'user-1',
            expiresAt: new Date(Date.now() + 1000),
        });
        const { service, mailService } = makeService({ inviteRepo });

        const result = await service.resendTeamInvite('user-1', 'course_project', 'entry-1', 'bob@test.com');

        expect(result).toEqual({ success: true, alreadyAccepted: true });
        expect(mailService.sendPathTeamInvite).not.toHaveBeenCalled();
    });

    it('getTeamInvitePreview flags an expired pending invite but not an accepted one', async () => {
        const inviteRepo = makeInviteRepo();
        inviteRepo.rows.push({
            id: 'invite-1',
            kind: 'course_project',
            entryId: 'entry-1',
            email: 'bob@test.com',
            token: 'tok-1',
            status: 'pending',
            invitedByUserId: 'user-1',
            expiresAt: new Date(Date.now() - 1000),
        });
        const { service } = makeService({ inviteRepo });

        const preview = await service.getTeamInvitePreview('tok-1');
        expect(preview.expired).toBe(true);

        inviteRepo.rows[0].status = 'accepted';
        inviteRepo.rows[0].expiresAt = new Date(Date.now() - 1000);
        const preview2 = await service.getTeamInvitePreview('tok-1');
        expect(preview2.expired).toBe(false);
    });
});

describe('PathsService — coursework merit notify', () => {
    const makeNotifyService = () => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const courseProjectRepo = {
            findOne: jest.fn(),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }) };
        const mailService = {
            sendPathTeamInvite: jest.fn(),
            sendCourseworkRankNotification: jest.fn().mockResolvedValue(undefined),
        };
        const graderRunRepo = makeGraderRunRepo();
        const service = new PathsService(
            courseProjectRepo as any,
            {} as any,
            {} as any,
            makeInviteRepo() as any,
            usersRepo as any,
            {} as any,
            mailService as any,
            notificationsService as any,
            graderRunRepo as any,
        );
        return { service, notificationsService, courseProjectRepo, usersRepo, mailService, graderRunRepo };
    };

    it('pins the UI rank on the card and notifies the owner; ignores ids outside the caller pool', async () => {
        const { service, notificationsService, courseProjectRepo } = makeNotifyService();
        jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
            scope: { label: 'Faculty supervision' },
            entries: [{ id: 'entry-1', rank: 9 }],
        } as any);
        courseProjectRepo.findOne.mockResolvedValue({
            id: 'entry-1',
            userId: 'student-1',
            projectTitle: 'Solar audit',
            facultyApprovalStatus: 'approved',
            studentInfo: { studentName: 'Ali Khan' },
        });

        const result = await service.notifyCourseProjectMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' },
            {
                picks: [
                    { entryId: 'entry-1', rank: 1, of: 8, total: 91 },
                    { entryId: 'other-cohort', rank: 2, of: 8, total: 80 },
                ],
                scopeLabel: 'Your cohort',
            },
        );

        expect(result.notified).toBe(1);
        expect(courseProjectRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            meritRibbon: expect.objectContaining({ rank: 1, of: 8, scope: 'Your cohort', total: 91 }),
        }));
        expect(notificationsService.createNotification).toHaveBeenCalledTimes(1);
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Your coursework ranked #1' }),
        );
    });

    it('does not spam a second notification when the same ribbon is already pinned', async () => {
        const { service, notificationsService, courseProjectRepo } = makeNotifyService();
        jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
            scope: { label: 'Your cohort' },
            entries: [{ id: 'entry-1', rank: 1 }],
        } as any);
        courseProjectRepo.findOne.mockResolvedValue({
            id: 'entry-1',
            userId: 'student-1',
            projectTitle: 'Solar audit',
            facultyApprovalStatus: 'approved',
            studentInfo: { studentName: 'Ali Khan' },
            meritRibbon: { rank: 1, of: 8, scope: 'Your cohort', total: 91, at: '2026-01-01' },
        });

        const result = await service.notifyCourseProjectMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' },
            { picks: [{ entryId: 'entry-1', rank: 1, of: 8, total: 91 }], scopeLabel: 'Your cohort' },
        );

        expect(result.notified).toBe(1);
        expect(notificationsService.createNotification).not.toHaveBeenCalled();
    });

    it('computes a badge tier, captures previousRank, and emails the student on a genuine pin', async () => {
        const { service, courseProjectRepo, mailService } = makeNotifyService();
        jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
            scope: { label: 'Your cohort' },
            entries: [{ id: 'entry-1', rank: 1 }],
        } as any);
        courseProjectRepo.findOne.mockResolvedValue({
            id: 'entry-1',
            userId: 'student-1',
            projectTitle: 'Solar audit',
            facultyApprovalStatus: 'approved',
            studentInfo: { studentName: 'Ali Khan' },
            meritRibbon: { rank: 3, of: 8, scope: 'Your cohort', total: 70, at: '2026-01-01' },
        });

        const result = await service.notifyCourseProjectMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' },
            { picks: [{ entryId: 'entry-1', rank: 1, of: 8, total: 91 }], scopeLabel: 'Your cohort' },
        );

        expect(result.notified).toBe(1);
        expect(courseProjectRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            meritRibbon: expect.objectContaining({ rank: 1, of: 8, badgeLevel: 'Silver', previousRank: 3 }),
        }));
        expect(mailService.sendCourseworkRankNotification).toHaveBeenCalledWith(
            'student@test.com', 'Ali', 'Solar audit', 1, 8, 'Your cohort', 'Silver', 3,
        );
    });

    it('does not email the student when the ribbon is unchanged (already-dedup)', async () => {
        const { service, mailService, courseProjectRepo } = makeNotifyService();
        jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
            scope: { label: 'Your cohort' },
            entries: [{ id: 'entry-1', rank: 1 }],
        } as any);
        courseProjectRepo.findOne.mockResolvedValue({
            id: 'entry-1',
            userId: 'student-1',
            projectTitle: 'Solar audit',
            facultyApprovalStatus: 'approved',
            studentInfo: { studentName: 'Ali Khan' },
            meritRibbon: { rank: 1, of: 8, scope: 'Your cohort', total: 91, at: '2026-01-01' },
        });

        await service.notifyCourseProjectMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' },
            { picks: [{ entryId: 'entry-1', rank: 1, of: 8, total: 91 }], scopeLabel: 'Your cohort' },
        );

        expect(mailService.sendCourseworkRankNotification).not.toHaveBeenCalled();
    });
});

describe('PathsService — coursework faculty review', () => {
    const makeReviewService = () => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const entry: Record<string, unknown> = {
            id: 'entry-1',
            userId: 'student-1',
            status: 'submitted',
            projectTitle: 'Solar audit',
            facultyApprovalStatus: 'pending',
            studentInfo: { studentName: 'Ali Khan', teacherEmail: 'teacher@test.com' },
            meritRibbon: { rank: 1, of: 8, scope: 'x', at: '2026-01-01' },
        };
        const courseProjectRepo = {
            findOne: jest.fn().mockResolvedValue(entry),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }) };
        const mailService = {
            sendCourseworkApproved: jest.fn().mockResolvedValue(undefined),
            sendCourseworkRevisionRequested: jest.fn().mockResolvedValue(undefined),
            sendCourseworkRejected: jest.fn().mockResolvedValue(undefined),
        };
        const service = new PathsService(
            courseProjectRepo as any,
            {} as any,
            {} as any,
            makeInviteRepo() as any,
            usersRepo as any,
            {} as any,
            mailService as any,
            notificationsService as any,
            {} as any,
        );
        return { service, notificationsService, courseProjectRepo, mailService };
    };

    it('approve sets facultyApprovalStatus=approved and emails the student', async () => {
        const { service, courseProjectRepo, mailService } = makeReviewService();
        const saved = await service.facultyReviewCourseProject('teacher@test.com', 'entry-1', 'approve');
        expect((saved as any).facultyApprovalStatus).toBe('approved');
        expect(courseProjectRepo.save).toHaveBeenCalled();
        expect(mailService.sendCourseworkApproved).toHaveBeenCalledWith('student@test.com', 'Ali', 'Solar audit');
    });

    it('revision sets facultyApprovalStatus=revision_requested, clears the ribbon, and emails the student', async () => {
        const { service, mailService } = makeReviewService();
        const saved = await service.facultyReviewCourseProject('teacher@test.com', 'entry-1', 'revision', 'Add more evidence');
        expect((saved as any).facultyApprovalStatus).toBe('revision_requested');
        expect((saved as any).meritRibbon).toBeNull();
        expect(mailService.sendCourseworkRevisionRequested).toHaveBeenCalledWith(
            'student@test.com', 'Ali', 'Solar audit', 'Add more evidence',
        );
    });

    it('reject sets facultyApprovalStatus=rejected and emails the student', async () => {
        const { service, mailService } = makeReviewService();
        const saved = await service.facultyReviewCourseProject('teacher@test.com', 'entry-1', 'reject', 'Not enough SDG linkage');
        expect((saved as any).facultyApprovalStatus).toBe('rejected');
        expect(mailService.sendCourseworkRejected).toHaveBeenCalledWith(
            'student@test.com', 'Ali', 'Solar audit', 'Not enough SDG linkage',
        );
    });
});

describe('PathsService — coursework submit/resubmit emails', () => {
    const makeSubmitService = (initialEntry: Record<string, unknown> | null) => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const rows: Record<string, unknown>[] = initialEntry ? [{ ...initialEntry }] : [];
        const manager = {
            getRepository: () => ({
                findOne: jest.fn(async () => rows[0] ?? null),
                create: jest.fn((data: Record<string, unknown>) => ({ status: 'draft', ...data })),
                save: jest.fn(async (row: Record<string, unknown>) => {
                    rows[0] = row;
                    return row;
                }),
            }),
        };
        const courseProjectRepo = {
            manager: { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) },
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }) };
        const mailService = {
            sendCourseworkSubmittedForReview: jest.fn().mockResolvedValue(undefined),
            sendCourseworkSubmissionConfirmation: jest.fn().mockResolvedValue(undefined),
            sendCourseworkResubmittedForReview: jest.fn().mockResolvedValue(undefined),
        };
        const service = new PathsService(
            courseProjectRepo as any,
            {} as any,
            {} as any,
            makeInviteRepo() as any,
            usersRepo as any,
            {} as any,
            mailService as any,
            notificationsService as any,
            {} as any,
        );
        jest.spyOn(service as any, 'syncCourseProjectInvites').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'courseProjectAnnotate').mockImplementation(async (entries: unknown) => entries as any);
        return { service, mailService };
    };

    it('first submission emails faculty and the student exactly once', async () => {
        const { service, mailService } = makeSubmitService({
            id: 'entry-1', userId: 'student-1', status: 'draft', projectTitle: 'Solar audit',
            facultyApprovalStatus: 'pending', studentInfo: { studentName: 'Ali Khan', teacherEmail: 'teacher@test.com' },
        });
        await service.updateCourseProjectByIdForUser('student-1', 'entry-1', { status: 'submitted' } as any);
        expect(mailService.sendCourseworkSubmittedForReview).toHaveBeenCalledTimes(1);
        expect(mailService.sendCourseworkSubmissionConfirmation).toHaveBeenCalledTimes(1);
        expect(mailService.sendCourseworkResubmittedForReview).not.toHaveBeenCalled();
    });

    it('a patch to a rejected, already-submitted entry emails faculty once (resubmission), not again on the next patch', async () => {
        const { service, mailService } = makeSubmitService({
            id: 'entry-1', userId: 'student-1', status: 'submitted', projectTitle: 'Solar audit',
            facultyApprovalStatus: 'rejected', facultyApprovalNote: 'fix this',
            studentInfo: { studentName: 'Ali Khan', teacherEmail: 'teacher@test.com' },
        });
        await service.updateCourseProjectByIdForUser('student-1', 'entry-1', { addedNote: 'fixed' } as any);
        expect(mailService.sendCourseworkResubmittedForReview).toHaveBeenCalledTimes(1);

        await service.updateCourseProjectByIdForUser('student-1', 'entry-1', { addedNote: 'fixed again' } as any);
        expect(mailService.sendCourseworkResubmittedForReview).toHaveBeenCalledTimes(1);
    });
});

function makeGraderRunRepo() {
    const rows: Array<Record<string, unknown>> = [];
    const findOne = jest.fn(async (opts: { where?: Record<string, unknown> } = {}) =>
        rows.find((r) => matchesWhere(r, opts.where ?? {})) ?? null,
    );
    const create = jest.fn((data: Record<string, unknown>) => ({ ...data }));
    const save = jest.fn(async (row: Record<string, unknown>) => {
        const idx = rows.findIndex(
            (r) => r.scope === row.scope && r.scopeKey === row.scopeKey && r.academicYear === row.academicYear,
        );
        if (idx === -1) rows.push(row);
        else rows[idx] = row;
        return row;
    });
    return {
        rows,
        findOne,
        create,
        save,
        manager: {
            transaction: jest.fn(async (fn: (m: unknown) => unknown) =>
                fn({ getRepository: () => ({ findOne, create, save }) }),
            ),
        },
    };
}

describe('PathsService — coursework grader run limit', () => {
    const makeGraderService = (graderRunRepo = makeGraderRunRepo()) => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const courseProjectRepo = {
            findOne: jest.fn().mockResolvedValue({
                id: 'entry-1',
                userId: 'student-1',
                projectTitle: 'Solar audit',
                facultyApprovalStatus: 'approved',
                studentInfo: { studentName: 'Ali Khan' },
            }),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }) };
        const mailService = { sendCourseworkRankNotification: jest.fn().mockResolvedValue(undefined) };
        const service = new PathsService(
            courseProjectRepo as any,
            {} as any,
            {} as any,
            makeInviteRepo() as any,
            usersRepo as any,
            {} as any,
            mailService as any,
            notificationsService as any,
            graderRunRepo as any,
        );
        jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
            scope: { label: 'Your cohort' },
            entries: [{ id: 'entry-1', rank: 1 }],
        } as any);
        return { service, graderRunRepo };
    };

    const notifyOnce = (service: PathsService, user: Record<string, unknown>) =>
        service.notifyCourseProjectMeritRanks(user as any, {
            picks: [{ entryId: 'entry-1', rank: 1, of: 5, total: 90 }],
        } as any);

    it('allows exactly 3 runs per academic year for a faculty scope, then blocks the 4th', async () => {
        const { service } = makeGraderService();
        const user = { role: 'faculty', email: 'teacher@test.com' };

        const r1 = await notifyOnce(service, user);
        expect((r1 as any).graderRuns).toEqual({ unlimited: false, used: 1, limit: 3 });
        const r2 = await notifyOnce(service, user);
        expect((r2 as any).graderRuns.used).toBe(2);
        const r3 = await notifyOnce(service, user);
        expect((r3 as any).graderRuns.used).toBe(3);

        await expect(notifyOnce(service, user)).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'GRADER_RUNS_EXHAUSTED', used: 3, limit: 3 }),
        });
    });

    it('scopes the cap independently per faculty email', async () => {
        const graderRunRepo = makeGraderRunRepo();
        const { service } = makeGraderService(graderRunRepo);
        await notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' });
        await notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' });
        await notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' });
        // teacher-a is now exhausted, but teacher-b has an independent counter.
        await expect(notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' })).rejects.toBeDefined();
        const rB = await notifyOnce(service, { role: 'faculty', email: 'teacher-b@test.com' });
        expect((rB as any).graderRuns).toEqual({ unlimited: false, used: 1, limit: 3 });
    });

    it('scopes the cap independently per university organizationId', async () => {
        const { service } = makeGraderService();
        const rUni = await notifyOnce(service, { role: 'university', organizationId: 'org-1' });
        expect((rUni as any).graderRuns).toEqual({ unlimited: false, used: 1, limit: 3 });
    });

    it('never blocks SUPER_ADMIN (unlimited runs)', async () => {
        const { service } = makeGraderService();
        const admin = { role: 'admin', email: 'admin@ciel.pk' };
        for (let i = 0; i < 5; i++) {
            const r = await notifyOnce(service, admin);
            expect((r as any).graderRuns).toEqual({ unlimited: true, used: 0, limit: 0 });
        }
    });
});

describe('PathsService — public coursework verification', () => {
    const makeVerifyService = (entry: Record<string, unknown> | null) => {
        const courseProjectRepo = { findOne: jest.fn().mockResolvedValue(entry) };
        const service = new PathsService(
            courseProjectRepo as any,
            {} as any,
            {} as any,
            makeInviteRepo() as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        return { service, courseProjectRepo };
    };

    it('returns a PII-minimal verified payload for an approved entry', async () => {
        const { service } = makeVerifyService({
            id: 'entry-1',
            projectTitle: 'Solar audit',
            facultyApprovalStatus: 'approved',
            facultyApprovalAt: new Date('2026-01-01'),
            verificationPublicSlug: 'abc-123',
            meritRibbon: { rank: 1, of: 8, scope: 'Your cohort', badgeLevel: 'Gold' },
        });
        const result = await service.getPublicCourseworkVerification('abc-123');
        expect(result).toMatchObject({
            success: true,
            verified: true,
            project_title: 'Solar audit',
            badge_level: 'Gold',
            rank: 1,
            of: 8,
        });
        expect(result).not.toHaveProperty('student_name');
        expect(result).not.toHaveProperty('studentInfo');
    });

    it('returns verified:false with only a status for a pending entry', async () => {
        const { service } = makeVerifyService({
            id: 'entry-1',
            projectTitle: 'Solar audit',
            facultyApprovalStatus: 'pending',
            verificationPublicSlug: 'abc-123',
        });
        const result = await service.getPublicCourseworkVerification('abc-123');
        expect(result).toEqual({ success: true, verified: false, status: 'pending' });
    });

    it('throws NotFoundException for an unknown key', async () => {
        const { service } = makeVerifyService(null);
        await expect(service.getPublicCourseworkVerification('nope')).rejects.toThrow(NotFoundException);
    });
});

describe('PathsService — FYP resubmission after rejection', () => {
    it('resets supervisorApprovalStatus to pending on the next edit, keeping the note but clearing the timestamp', async () => {
        const rows: Record<string, unknown>[] = [
            {
                id: 'fyp-1',
                userId: 'student-1',
                status: 'submitted',
                supervisorApprovalStatus: 'rejected',
                supervisorApprovalNote: 'needs more literature review',
                supervisorApprovalAt: new Date('2026-01-01'),
            },
        ];
        const manager = {
            getRepository: () => ({
                findOne: jest.fn(async () => rows[0] ?? null),
                create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
                save: jest.fn(async (row: Record<string, unknown>) => {
                    rows[0] = row;
                    return row;
                }),
            }),
        };
        const fypRepo = {
            manager: { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) },
        };
        const service = new PathsService(
            {} as any,
            fypRepo as any,
            {} as any,
            makeInviteRepo() as any,
            {} as any,
            {} as any,
            {} as any,
            { createNotification: jest.fn() } as any,
            {} as any,
        );
        jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'fypAnnotate').mockImplementation(async (entries: unknown) => entries as any);

        const saved = await service.upsertFyp('student-1', { addedNote: 'fixed' } as any);

        expect((saved as any).supervisorApprovalStatus).toBe('pending');
        expect((saved as any).supervisorApprovalAt).toBeNull();
        expect((saved as any).supervisorApprovalNote).toBe('needs more literature review');
    });

    it('also resets a revision_requested entry to pending on the next edit', async () => {
        const rows: Record<string, unknown>[] = [
            {
                id: 'fyp-2',
                userId: 'student-1',
                status: 'submitted',
                supervisorApprovalStatus: 'revision_requested',
                supervisorApprovalNote: 'tighten the methodology section',
                supervisorApprovalAt: new Date('2026-01-01'),
                meritRibbon: { rank: 2, of: 5, scope: 'x', at: '2026-01-01' },
            },
        ];
        const manager = {
            getRepository: () => ({
                findOne: jest.fn(async () => rows[0] ?? null),
                create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
                save: jest.fn(async (row: Record<string, unknown>) => {
                    rows[0] = row;
                    return row;
                }),
            }),
        };
        const fypRepo = { manager: { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) } };
        const service = new PathsService(
            {} as any, fypRepo as any, {} as any, makeInviteRepo() as any, {} as any, {} as any, {} as any,
            { createNotification: jest.fn() } as any, {} as any,
        );
        jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'fypAnnotate').mockImplementation(async (entries: unknown) => entries as any);

        const saved = await service.upsertFyp('student-1', { addedNote: 'fixed' } as any);

        expect((saved as any).supervisorApprovalStatus).toBe('pending');
        expect((saved as any).supervisorApprovalAt).toBeNull();
        expect((saved as any).meritRibbon).toBeNull();
        expect((saved as any).supervisorApprovalNote).toBe('tighten the methodology section');
    });
});

describe('PathsService — FYP supervisor review', () => {
    const makeReviewService = () => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const entry: Record<string, unknown> = {
            id: 'fyp-1',
            userId: 'student-1',
            status: 'submitted',
            projectTitle: 'Circular Economy Study',
            supervisorApprovalStatus: 'pending',
            projectInfo: { studentName: 'Ali Khan', supervisorEmail: 'supervisor@test.com' },
            meritRibbon: { rank: 1, of: 8, scope: 'x', at: '2026-01-01' },
        };
        const fypRepo = {
            findOne: jest.fn().mockResolvedValue(entry),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ name: 'Ali Khan' }) };
        const service = new PathsService(
            {} as any, fypRepo as any, {} as any, makeInviteRepo() as any, usersRepo as any, {} as any, {} as any,
            notificationsService as any, {} as any,
        );
        return { service, notificationsService, fypRepo };
    };

    it('approve sets supervisorApprovalStatus=approved and notifies the student', async () => {
        const { service, notificationsService } = makeReviewService();
        const saved = await service.supervisorReviewFyp('supervisor@test.com', 'fyp-1', 'approve');
        expect((saved as any).supervisorApprovalStatus).toBe('approved');
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Your FYP was approved' }),
        );
    });

    it('revision sets supervisorApprovalStatus=revision_requested, clears the ribbon, and notifies the student', async () => {
        const { service, notificationsService } = makeReviewService();
        const saved = await service.supervisorReviewFyp('supervisor@test.com', 'fyp-1', 'revision', 'Add more evidence');
        expect((saved as any).supervisorApprovalStatus).toBe('revision_requested');
        expect((saved as any).meritRibbon).toBeNull();
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Revision requested on your FYP' }),
        );
    });

    it('reject sets supervisorApprovalStatus=rejected and notifies the student', async () => {
        const { service, notificationsService } = makeReviewService();
        const saved = await service.supervisorReviewFyp('supervisor@test.com', 'fyp-1', 'reject', 'Not enough rigor');
        expect((saved as any).supervisorApprovalStatus).toBe('rejected');
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Your FYP was rejected' }),
        );
    });
});

describe('PathsService — FYP merit notify', () => {
    const makeNotifyService = () => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const fypRepo = {
            findOne: jest.fn(),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }) };
        const graderRunRepo = makeGraderRunRepo();
        const service = new PathsService(
            {} as any, fypRepo as any, {} as any, makeInviteRepo() as any, usersRepo as any, {} as any, {} as any,
            notificationsService as any, graderRunRepo as any,
        );
        return { service, notificationsService, fypRepo, graderRunRepo };
    };

    it('pins the UI rank on the FYP card and notifies the owner', async () => {
        const { service, notificationsService, fypRepo } = makeNotifyService();
        jest.spyOn(service, 'getFypMeritModel').mockResolvedValue({
            scope: { label: 'Faculty supervision' },
            entries: [{ id: 'fyp-1', rank: 1 }],
        } as any);
        fypRepo.findOne.mockResolvedValue({
            id: 'fyp-1',
            userId: 'student-1',
            projectTitle: 'Circular Economy Study',
            supervisorApprovalStatus: 'approved',
            projectInfo: { studentName: 'Ali Khan' },
        });

        const result = await service.notifyFypMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' } as any,
            { picks: [{ entryId: 'fyp-1', rank: 1, of: 5, total: 91 }], scopeLabel: 'Your cohort' } as any,
        );

        expect(result.notified).toBe(1);
        expect(fypRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            meritRibbon: expect.objectContaining({ rank: 1, of: 5, scope: 'Your cohort', badgeLevel: 'Silver' }),
        }));
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Your FYP ranked #1' }),
        );
    });

    it('does not spam a second notification when the same ribbon is already pinned', async () => {
        const { service, notificationsService, fypRepo } = makeNotifyService();
        jest.spyOn(service, 'getFypMeritModel').mockResolvedValue({
            scope: { label: 'Your cohort' },
            entries: [{ id: 'fyp-1', rank: 1 }],
        } as any);
        fypRepo.findOne.mockResolvedValue({
            id: 'fyp-1',
            userId: 'student-1',
            projectTitle: 'Circular Economy Study',
            supervisorApprovalStatus: 'approved',
            meritRibbon: { rank: 1, of: 5, scope: 'Your cohort', total: 91, at: '2026-01-01' },
        });

        const result = await service.notifyFypMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' } as any,
            { picks: [{ entryId: 'fyp-1', rank: 1, of: 5, total: 91 }], scopeLabel: 'Your cohort' } as any,
        );

        expect(result.notified).toBe(1);
        expect(notificationsService.createNotification).not.toHaveBeenCalled();
    });
});

describe('PathsService — venture supervisor review', () => {
    const makeReviewService = () => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const entry: Record<string, unknown> = {
            id: 'venture-1',
            userId: 'student-1',
            status: 'submitted',
            ventureName: 'EcoPack Pakistan',
            academicSetup: { supervisorEmail: 'supervisor@test.com' },
            reviewPipeline: { supervisorStatus: 'pending' },
            meritRibbon: { rank: 1, of: 8, scope: 'x', at: '2026-01-01' },
        };
        const ventureRepo = {
            findOne: jest.fn().mockResolvedValue(entry),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = {
            findOne: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
                where.email ? { name: 'Dr. Supervisor', email: 'supervisor@test.com' } : { name: 'Ali Khan' },
            ),
        };
        const service = new PathsService(
            {} as any, {} as any, ventureRepo as any, makeInviteRepo() as any, usersRepo as any, {} as any, {} as any,
            notificationsService as any, {} as any,
        );
        jest.spyOn(service as any, 'ventureAnnotate').mockImplementation(async (entries: unknown) => entries as any);
        jest.spyOn(service as any, 'attachStudents').mockImplementation(async (entries: unknown) => entries as any);
        jest.spyOn(service as any, 'withCompleteness').mockImplementation((entry: unknown) => entry);
        return { service, notificationsService, ventureRepo };
    };

    it('approve sets reviewPipeline.supervisorStatus=approved and notifies the student', async () => {
        const { service, notificationsService } = makeReviewService();
        const saved: any = await service.supervisorReviewVenture('supervisor@test.com', 'venture-1', 'approve');
        expect(saved.reviewPipeline.supervisorStatus).toBe('approved');
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Your venture was approved' }),
        );
    });

    it('revision keeps the existing revisions_requested meaning, clears the ribbon, and notifies the student', async () => {
        const { service, notificationsService } = makeReviewService();
        const saved: any = await service.supervisorReviewVenture('supervisor@test.com', 'venture-1', 'revision', 'Add traction evidence');
        expect(saved.reviewPipeline.supervisorStatus).toBe('revisions_requested');
        expect(saved.meritRibbon).toBeNull();
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Revision requested on your venture' }),
        );
    });

    it('reject sets a genuinely new terminal rejected state and notifies the student', async () => {
        const { service, notificationsService } = makeReviewService();
        const saved: any = await service.supervisorReviewVenture('supervisor@test.com', 'venture-1', 'reject', 'Not viable yet');
        expect(saved.reviewPipeline.supervisorStatus).toBe('rejected');
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Your venture was rejected' }),
        );
    });
});

describe('PathsService — venture merit notify', () => {
    const makeNotifyService = () => {
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const ventureRepo = {
            findOne: jest.fn(),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ name: 'Ali Khan' }) };
        const graderRunRepo = makeGraderRunRepo();
        const service = new PathsService(
            {} as any, {} as any, ventureRepo as any, makeInviteRepo() as any, usersRepo as any, {} as any, {} as any,
            notificationsService as any, graderRunRepo as any,
        );
        return { service, notificationsService, ventureRepo, graderRunRepo };
    };

    it('pins the UI rank on the venture card and notifies the owner', async () => {
        const { service, notificationsService, ventureRepo } = makeNotifyService();
        jest.spyOn(service, 'getVentureMeritModel').mockResolvedValue({
            scope: { label: 'Faculty supervision' },
            entries: [{ id: 'venture-1', rank: 1 }],
        } as any);
        ventureRepo.findOne.mockResolvedValue({
            id: 'venture-1',
            userId: 'student-1',
            ventureName: 'EcoPack Pakistan',
            reviewPipeline: { supervisorStatus: 'approved' },
        });

        const result = await service.notifyVentureMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' } as any,
            { picks: [{ entryId: 'venture-1', rank: 1, of: 5, total: 91 }], scopeLabel: 'Your cohort' } as any,
        );

        expect(result.notified).toBe(1);
        expect(ventureRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            meritRibbon: expect.objectContaining({ rank: 1, of: 5, scope: 'Your cohort', badgeLevel: 'Silver' }),
        }));
        expect(notificationsService.createNotification).toHaveBeenCalledWith(
            'student-1',
            expect.objectContaining({ title: 'Your venture ranked #1' }),
        );
    });

    it('does not rank an entry whose supervisor status is not approved', async () => {
        const { service, notificationsService, ventureRepo } = makeNotifyService();
        jest.spyOn(service, 'getVentureMeritModel').mockResolvedValue({
            scope: { label: 'Faculty supervision' },
            entries: [{ id: 'venture-1', rank: 1 }],
        } as any);
        ventureRepo.findOne.mockResolvedValue({
            id: 'venture-1',
            userId: 'student-1',
            ventureName: 'EcoPack Pakistan',
            reviewPipeline: { supervisorStatus: 'revisions_requested' },
        });

        const result = await service.notifyVentureMeritRanks(
            { role: 'faculty', email: 'teacher@test.com' } as any,
            { picks: [{ entryId: 'venture-1', rank: 1, of: 5, total: 91 }], scopeLabel: 'Your cohort' } as any,
        );

        expect(result.notified).toBe(0);
        expect(notificationsService.createNotification).not.toHaveBeenCalled();
    });
});

describe('PathsService — grader run limit is independent per path', () => {
    it('exhausting coursework runs for a faculty email does not block that same email\'s FYP runs', async () => {
        const graderRunRepo = makeGraderRunRepo();
        const notificationsService = { createNotification: jest.fn().mockResolvedValue(undefined) };
        const courseProjectRepo = {
            findOne: jest.fn().mockResolvedValue({
                id: 'entry-1', userId: 'student-1', projectTitle: 'x', facultyApprovalStatus: 'approved',
            }),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const fypRepo = {
            findOne: jest.fn().mockResolvedValue({
                id: 'fyp-1', userId: 'student-1', projectTitle: 'x', supervisorApprovalStatus: 'approved',
            }),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const usersRepo = { findOne: jest.fn().mockResolvedValue({ email: 'student@test.com', name: 'Student' }) };
        const mailService = { sendCourseworkRankNotification: jest.fn().mockResolvedValue(undefined) };
        const service = new PathsService(
            courseProjectRepo as any, fypRepo as any, {} as any, makeInviteRepo() as any, usersRepo as any, {} as any,
            mailService as any, notificationsService as any, graderRunRepo as any,
        );
        const user = { role: 'faculty', email: 'teacher@test.com' };
        jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
            scope: { label: 'x' }, entries: [{ id: 'entry-1', rank: 1 }],
        } as any);
        jest.spyOn(service, 'getFypMeritModel').mockResolvedValue({
            scope: { label: 'x' }, entries: [{ id: 'fyp-1', rank: 1 }],
        } as any);

        const coursePick = { picks: [{ entryId: 'entry-1', rank: 1, of: 5, total: 90 }] } as any;
        await service.notifyCourseProjectMeritRanks(user as any, coursePick);
        await service.notifyCourseProjectMeritRanks(user as any, coursePick);
        await service.notifyCourseProjectMeritRanks(user as any, coursePick);
        await expect(service.notifyCourseProjectMeritRanks(user as any, coursePick)).rejects.toBeDefined();

        const fypResult = await service.notifyFypMeritRanks(
            user as any,
            { picks: [{ entryId: 'fyp-1', rank: 1, of: 5, total: 90 }] } as any,
        );
        expect((fypResult as any).graderRuns).toEqual({ unlimited: false, used: 1, limit: 3 });
    });
});

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
        const courseProjectRepo = {
            findOne: jest.fn().mockResolvedValue({ id: 'entry-1', projectTitle: 'My Report', course: null }),
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
        );
        return { service, inviteRepo, mailService, courseProjectRepo };
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

import * as bcrypt from 'bcrypt';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { OtpService } from './otp.service';

describe('OtpService.verifyOtp', () => {
    const mailService = { sendOtpEmail: jest.fn() };
    const usersService = { findByEmail: jest.fn() };

    function makeService(repo: Record<string, jest.Mock>) {
        return new OtpService(repo as never, mailService as never, usersService as never);
    }

    it('accepts a matching code on an already-verified row so signup can retry', async () => {
        const row = {
            email: 'a@b.com',
            otp: '123456',
            otpHash: null,
            expiresAt: new Date(Date.now() + 60_000),
            verified: true,
        };
        const repo = {
            findOne: jest.fn().mockResolvedValue(row),
            save: jest.fn(),
        };
        const service = makeService(repo);

        const result = await service.verifyOtp('a@b.com', '123456');

        expect(result.success).toBe(true);
        expect(repo.save).not.toHaveBeenCalled();
    });

    it('marks an unverified matching row as verified', async () => {
        const row = {
            email: 'a@b.com',
            otp: '654321',
            otpHash: null,
            expiresAt: new Date(Date.now() + 60_000),
            verified: false,
        };
        const repo = {
            findOne: jest.fn().mockResolvedValue(row),
            save: jest.fn().mockResolvedValue({ ...row, verified: true }),
        };
        const service = makeService(repo);

        await service.verifyOtp('A@B.com', '654321');

        expect(row.verified).toBe(true);
        expect(repo.save).toHaveBeenCalledWith(row);
    });

    it('rejects a wrong code', async () => {
        const repo = {
            findOne: jest.fn().mockResolvedValue({
                email: 'a@b.com',
                otp: '123456',
                otpHash: null,
                expiresAt: new Date(Date.now() + 60_000),
                verified: false,
            }),
            save: jest.fn(),
        };
        const service = makeService(repo);

        await expect(service.verifyOtp('a@b.com', '000000')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('counts a wrong guess, and drops the code after too many so it cannot be brute-forced', async () => {
        const row: any = {
            email: 'a@b.com',
            otp: null,
            otpHash: await bcrypt.hash('123456', 4),
            expiresAt: new Date(Date.now() + 60_000),
            verified: false,
            attempts: 0,
        };
        const repo = {
            findOne: jest.fn().mockResolvedValue(row),
            save: jest.fn(),
            delete: jest.fn(),
        };
        const service = makeService(repo);

        for (let i = 0; i < 5; i++) {
            await expect(service.verifyOtp('a@b.com', '000000')).rejects.toThrow('Invalid OTP');
        }
        expect(row.attempts).toBe(5);
        // 6th try — even the CORRECT code is refused and the row is deleted.
        await expect(service.verifyOtp('a@b.com', '123456')).rejects.toThrow(/Too many incorrect attempts/);
        expect(repo.delete).toHaveBeenCalledWith({ email: 'a@b.com' });
    });

    it('verifies against the hash and extends the row to the signup window', async () => {
        const row: any = {
            email: 'a@b.com',
            otp: null,
            otpHash: await bcrypt.hash('123456', 4),
            expiresAt: new Date(Date.now() + 60_000),
            verified: false,
            attempts: 2,
        };
        const repo = { findOne: jest.fn().mockResolvedValue(row), save: jest.fn() };
        await makeService(repo).verifyOtp('a@b.com', '123456');
        expect(row.verified).toBe(true);
        expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
    });
});

describe('OtpService.sendOtp', () => {
    function make(opts: { latest?: any; user?: any; mail?: jest.Mock }) {
        const repo: any = {
            findOne: jest.fn().mockResolvedValue(opts.latest ?? null),
            delete: jest.fn(),
            create: jest.fn((x) => x),
            save: jest.fn(async (x) => x),
        };
        const mail = { sendOtpEmail: opts.mail ?? jest.fn() };
        const users = { findByEmail: jest.fn().mockResolvedValue(opts.user ?? null) };
        return { service: new OtpService(repo, mail as never, users as never), repo, mail };
    }

    it('stores only the hash (never the plain code) and emails the plain code', async () => {
        const { service, repo, mail } = make({});
        await service.sendOtp('New@X.com');
        const saved = repo.save.mock.calls[0][0];
        expect(saved.otp).toBeNull();
        expect(saved.otpHash).toMatch(/^\$2[aby]\$/);
        const sent = mail.sendOtpEmail.mock.calls[0][1];
        expect(sent).toMatch(/^\d{6}$/);
        expect(await bcrypt.compare(sent, saved.otpHash)).toBe(true);
    });

    it('throttles a second request inside the resend window (429) without sending mail', async () => {
        const { service, mail } = make({ latest: { createdAt: new Date() } });
        await expect(service.sendOtp('a@b.com')).rejects.toBeInstanceOf(HttpException);
        expect(mail.sendOtpEmail).not.toHaveBeenCalled();
    });

    it('allows a resend after the window', async () => {
        const { service, mail } = make({ latest: { createdAt: new Date(Date.now() - 60_000) } });
        await service.sendOtp('a@b.com');
        expect(mail.sendOtpEmail).toHaveBeenCalled();
    });

    it('rejects an already-registered email with 409', async () => {
        const { service } = make({ user: { id: 'u' } });
        await expect(service.sendOtp('a@b.com')).rejects.toBeInstanceOf(ConflictException);
    });

    it('when the mail fails: drops the unusable code and returns a clear 503, not a raw 500', async () => {
        const { service, repo } = make({ mail: jest.fn().mockRejectedValue(new Error('SMTP down')) });
        await expect(service.sendOtp('a@b.com')).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(repo.delete).toHaveBeenLastCalledWith({ email: 'a@b.com' });
    });
});

describe('OtpService.requireVerifiedEmailForSignup', () => {
    it('throws a string message so the client can display it', async () => {
        const repo = { findOne: jest.fn().mockResolvedValue(null) };
        const service = new OtpService(
            repo as never,
            { sendOtpEmail: jest.fn() } as never,
            { findByEmail: jest.fn() } as never,
        );

        await expect(service.requireVerifiedEmailForSignup('x@y.com')).rejects.toEqual(
            expect.objectContaining({
                message: 'Email not verified. Please complete OTP verification first.',
            }),
        );
        await expect(service.requireVerifiedEmailForSignup('x@y.com')).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('only accepts a verified row that has not expired', async () => {
        const repo = { findOne: jest.fn().mockResolvedValue({ verified: true }) };
        const service = new OtpService(repo as never, {} as never, {} as never);
        await service.requireVerifiedEmailForSignup('x@y.com');
        const where = repo.findOne.mock.calls[0][0].where;
        expect(where.verified).toBe(true);
        expect(where.expiresAt).toBeDefined(); // MoreThan(now) — a stale verification no longer counts
    });
});

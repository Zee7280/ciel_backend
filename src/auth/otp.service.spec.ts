import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
        expect(repo.save).not.toHaveBeenCalled();
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
});

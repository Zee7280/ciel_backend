import {
    Injectable,
    BadRequestException,
    ForbiddenException,
    ConflictException,
    HttpException,
    HttpStatus,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { EmailOtp } from './entities/email-otp.entity';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';

const OTP_TTL_MS = 5 * 60 * 1000;
/** After a correct code, the email stays "verified" this long so the signup form can still be fixed and resubmitted. */
const VERIFIED_SIGNUP_WINDOW_MS = 30 * 60 * 1000;
/** Wrong guesses allowed per code before a new one must be requested (6 digits = 1M combinations). */
const MAX_VERIFY_ATTEMPTS = 5;
/** Server-side resend throttle; slightly under the frontend's 30s cooldown so a legit resend never trips it. */
const MIN_RESEND_INTERVAL_MS = 25 * 1000;
const BCRYPT_ROUNDS = 8;

@Injectable()
export class OtpService {
    private readonly logger = new Logger(OtpService.name);

    constructor(
        @InjectRepository(EmailOtp)
        private readonly emailOtpRepository: Repository<EmailOtp>,
        private readonly mailService: MailService,
        private readonly usersService: UsersService,
    ) {}

    private normalizeEmail(email: string): string {
        return String(email || '')
            .trim()
            .toLowerCase();
    }

    private generateSixDigitOtp(): string {
        const n = crypto.randomInt(0, 1_000_000);
        return n.toString().padStart(6, '0');
    }

    private plainOtpMatches(stored: string, provided: string): boolean {
        const a = String(stored);
        const b = String(provided);
        try {
            if (a.length !== b.length) {
                return false;
            }
            return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
        } catch {
            return false;
        }
    }

    async sendOtp(rawEmail: string) {
        const email = this.normalizeEmail(rawEmail);
        if (!email) {
            throw new BadRequestException('Email is required');
        }

        const existingUser = await this.usersService.findByEmail(email);
        if (existingUser) {
            throw new ConflictException('This email is already registered');
        }

        const latest = await this.emailOtpRepository.findOne({
            where: { email },
            order: { createdAt: 'DESC' },
        });
        if (
            latest?.createdAt &&
            Date.now() - new Date(latest.createdAt).getTime() < MIN_RESEND_INTERVAL_MS
        ) {
            throw new HttpException(
                'Please wait a few seconds before requesting another code.',
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        await this.emailOtpRepository.delete({ email });

        const otp = this.generateSixDigitOtp();
        const otpHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);
        const expiresAt = new Date(Date.now() + OTP_TTL_MS);

        // Only the hash is stored — the plain code lives in the email alone.
        await this.emailOtpRepository.save(
            this.emailOtpRepository.create({
                email,
                otp: null,
                otpHash,
                expiresAt,
                verified: false,
                attempts: 0,
            }),
        );

        try {
            await this.mailService.sendOtpEmail(email, otp);
        } catch (error) {
            // No email went out, so this code is unusable — drop it and tell the user plainly.
            this.logger.error(
                `OTP email failed for ${email}: ${(error as Error)?.message || error}`,
            );
            await this.emailOtpRepository.delete({ email });
            throw new ServiceUnavailableException(
                'We could not send the verification email right now. Please try again in a moment.',
            );
        }

        return {
            success: true,
            message: 'OTP sent',
        };
    }

    async verifyOtp(rawEmail: string, rawOtp: string) {
        const email = this.normalizeEmail(rawEmail);
        const otp = String(rawOtp || '').trim();

        // Latest row for this email — including already-verified — so a retry after a
        // failed signup (duplicate, validation, etc.) does not look like an expired code.
        const row = await this.emailOtpRepository.findOne({
            where: { email },
            order: { createdAt: 'DESC' },
        });

        if (!row || new Date() > row.expiresAt) {
            throw new BadRequestException('Invalid or expired OTP. Please request a new code.');
        }

        if ((row.attempts ?? 0) >= MAX_VERIFY_ATTEMPTS) {
            await this.emailOtpRepository.delete({ email });
            throw new BadRequestException(
                'Too many incorrect attempts. Please request a new code.',
            );
        }

        const valid = row.otpHash
            ? await bcrypt.compare(otp, row.otpHash)
            : row.otp
              ? this.plainOtpMatches(row.otp, otp)
              : false;
        if (!valid) {
            row.attempts = (row.attempts ?? 0) + 1;
            await this.emailOtpRepository.save(row);
            throw new BadRequestException('Invalid OTP');
        }

        if (!row.verified) {
            row.verified = true;
            row.expiresAt = new Date(Date.now() + VERIFIED_SIGNUP_WINDOW_MS);
            await this.emailOtpRepository.save(row);
        }

        return {
            success: true,
            message: 'OTP verified',
        };
    }

    async requireVerifiedEmailForSignup(rawEmail: string): Promise<void> {
        const email = this.normalizeEmail(rawEmail);
        const row = await this.emailOtpRepository.findOne({
            where: { email, verified: true, expiresAt: MoreThan(new Date()) },
            order: { createdAt: 'DESC' },
        });

        if (!row) {
            throw new ForbiddenException(
                'Email not verified. Please complete OTP verification first.',
            );
        }
    }

    async clearOtpsForEmail(rawEmail: string): Promise<void> {
        const email = this.normalizeEmail(rawEmail);
        await this.emailOtpRepository.delete({ email });
    }
}

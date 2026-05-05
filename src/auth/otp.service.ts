import {
    Injectable,
    BadRequestException,
    ForbiddenException,
    ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { EmailOtp } from './entities/email-otp.entity';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';

const OTP_TTL_MS = 5 * 60 * 1000;
/** Keep hashing so inserts work on DBs where otpHash is still NOT NULL; plain otp is stored in `otp`. */
const BCRYPT_ROUNDS = 8;

@Injectable()
export class OtpService {
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

        await this.emailOtpRepository.delete({ email });

        const otp = this.generateSixDigitOtp();
        const otpHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);
        const expiresAt = new Date(Date.now() + OTP_TTL_MS);

        await this.emailOtpRepository.save(
            this.emailOtpRepository.create({
                email,
                otp,
                otpHash,
                expiresAt,
                verified: false,
            }),
        );

        await this.mailService.sendOtpEmail(email, otp);

        return {
            success: true,
            message: 'OTP sent',
        };
    }

    async verifyOtp(rawEmail: string, rawOtp: string) {
        const email = this.normalizeEmail(rawEmail);
        const otp = String(rawOtp || '').trim();

        const row = await this.emailOtpRepository.findOne({
            where: { email, verified: false },
            order: { createdAt: 'DESC' },
        });

        if (!row || new Date() > row.expiresAt) {
            throw new BadRequestException('Invalid or expired OTP. Please request a new code.');
        }

        const valid = row.otp
            ? this.plainOtpMatches(row.otp, otp)
            : row.otpHash
              ? await bcrypt.compare(otp, row.otpHash)
              : false;
        if (!valid) {
            throw new BadRequestException('Invalid OTP');
        }

        row.verified = true;
        await this.emailOtpRepository.save(row);

        return {
            success: true,
            message: 'OTP verified',
        };
    }

    async requireVerifiedEmailForSignup(rawEmail: string): Promise<void> {
        const email = this.normalizeEmail(rawEmail);
        const row = await this.emailOtpRepository.findOne({
            where: { email, verified: true },
            order: { createdAt: 'DESC' },
        });

        if (!row) {
            throw new ForbiddenException({
                success: false,
                message: 'Email not verified. Please complete OTP verification first.',
            });
        }
    }

    async clearOtpsForEmail(rawEmail: string): Promise<void> {
        const email = this.normalizeEmail(rawEmail);
        await this.emailOtpRepository.delete({ email });
    }
}

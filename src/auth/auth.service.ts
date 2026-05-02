import { Injectable, UnauthorizedException, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { Organization } from '../organizations/entities/organization.entity';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { MailService } from '../mail/mail.service';
import { OtpService } from './otp.service';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private organizationsService: OrganizationsService,
        private mailService: MailService,
        private otpService: OtpService,
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
    ) { }

    /**
     * After a new faculty or partner user registers, link any existing opportunities
     * that were submitted with their email address but have no facultyId / organizationId yet.
     * This is best-effort — a failure here must never block the signup response.
     */
    private async reconcileNewUser(user: User, org: Organization | null): Promise<void> {
        const email = (user.email || '').trim().toLowerCase();
        if (!email) return;

        try {
            if (user.role === UserRole.FACULTY) {
                // Set facultyId on opportunities whose supervision email matches this faculty's email
                await this.opportunitiesRepository
                    .createQueryBuilder()
                    .update(Opportunity)
                    .set({ facultyId: user.id })
                    .where('"facultyId" IS NULL')
                    .andWhere(
                        `(LOWER(TRIM(COALESCE(supervision->>'contact', ''))) = :email`
                        + ` OR LOWER(TRIM(COALESCE(supervision->>'official_email', ''))) = :email)`,
                        { email },
                    )
                    .execute();
            } else if (org) {
                // Partner user: link their organization to opportunities that were submitted
                // with their email but only have a placeholder org or no org at all.
                const matching = await this.opportunitiesRepository
                    .createQueryBuilder('opp')
                    .leftJoinAndSelect('opp.organization', 'org')
                    .where(
                        `(LOWER(TRIM(COALESCE(opp.external_partner_collaboration->>'official_email', ''))) = :email`
                        + ` OR LOWER(TRIM(COALESCE(opp.supervision->>'external_partner_email', ''))) = :email`
                        + ` OR LOWER(TRIM(COALESCE(opp.supervision->>'partner_email', ''))) = :email`
                        + ` OR LOWER(TRIM(COALESCE(opp.executing_context->'partner'->>'official_email', ''))) = :email`
                        + ` OR LOWER(TRIM(COALESCE(opp.partner_organization->>'official_email', ''))) = :email)`,
                        { email },
                    )
                    .andWhere(
                        `(opp."organizationId" IS NULL OR org."verificationStatus" = :placeholder)`,
                        { placeholder: 'unclaimed_student_initiated' },
                    )
                    .getMany();

                if (matching.length > 0) {
                    await this.opportunitiesRepository
                        .createQueryBuilder()
                        .update(Opportunity)
                        .set({ organizationId: org.id })
                        .whereInIds(matching.map((o) => o.id))
                        .execute();
                }
            }
        } catch (err) {
            console.warn('Post-signup reconciliation failed (non-fatal):', (err as Error).message);
        }
    }

    async signup(signupDto: SignupDto) {
        try {
            const { password, email: rawEmail, ...rawUserData } = signupDto;
            const { status: _clientStatus, ...userData } = rawUserData as SignupDto & { status?: string };
            const email = rawEmail.trim().toLowerCase();

            // Check if user already exists
            const existingUser = await this.usersService.findByEmail(email);
            if (existingUser) {
                throw new ConflictException('Email already exists');
            }

            await this.otpService.requireVerifiedEmailForSignup(email);

            const hashedPassword = await bcrypt.hash(password, 10);

            let organization: Organization | null = null;
            if (userData.orgName && userData.orgType) {
                organization = await this.organizationsService.create({
                    name: userData.orgName,
                    orgType: userData.orgType,
                });
            }

            const needsMembershipFee =
                !!organization &&
                (userData.role === UserRole.UNIVERSITY || userData.role === UserRole.CORPORATE);

            const user = await this.usersService.create({
                ...userData,
                email,
                password: hashedPassword,
                organization,
                ...(needsMembershipFee ? { status: 'pending_membership_payment' } : {}),
            });

            try {
                await this.mailService.sendWelcomeEmail(user.email, user.name);
            } finally {
                await this.otpService.clearOtpsForEmail(email);
            }

            // Link any pre-existing opportunities that were awaiting this user's email
            await this.reconcileNewUser(user, organization);

            return {
                success: true,
                message: needsMembershipFee
                    ? 'Account created. Pay the membership fee and submit proof, or wait for admin activation.'
                    : 'User created successfully',
                data: {
                    user: await this.usersService.formatUserResponse(user),
                },
            };
        } catch (error) {
            console.error('Signup error:', error);

            // Handle duplicate email error from database
            if (error.code === '23505') {
                throw new ConflictException('Email already exists');
            }

            throw error;
        }
    }

    async login(loginDto: LoginDto) {
        const { email: rawLoginEmail, password } = loginDto;
        const email = rawLoginEmail.trim().toLowerCase();
        const user = await this.usersService.findByEmail(email);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (
            user.status !== 'active' &&
            user.status !== 'approved' &&
            user.status !== 'pending_membership_payment'
        ) {
            throw new UnauthorizedException('Account is not active');
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const payload = {
            sub: user.id,
            email: user.email,
            role: user.role,
            organizationId: user.organization?.id,
            organizationName: user.organization?.name || user.orgName,
            department: user.department,
            faculty_department: user.faculty_department,
            city: user.city,
            university: user.university || user.institution,
            tokenVersion: user.tokenVersion ?? 0,
        };
        const expiresIn = loginDto.isMobile ? '30d' : '10h';

        return {
            success: true,
            data: {
                access_token: this.jwtService.sign(payload, { expiresIn }),
                user: await this.usersService.formatUserResponse(user),
            },
        };
    }

    async forgotPassword(email: string) {
        const user = await this.usersService.findByEmail(email);

        // Always return success to prevent email enumeration
        if (!user) {
            return { success: true, message: 'Reset link sent to email.' };
        }

        // Generate a secure random token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiry = new Date();
        expiry.setHours(expiry.getHours() + 1); // Token valid for 1 hour

        // Save token and expiry to the user
        await this.usersService.savePasswordResetToken(user.id, resetToken, expiry);

        // Send the reset email
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;
        await this.mailService.sendPasswordResetEmail(user.email, resetLink);

        return {
            success: true,
            message: 'Reset link sent to email.',
        };
    }

    async resetPassword(token: string, newPassword: string) {
        const user = await this.usersService.findByResetToken(token);

        if (!user || !user.passwordResetExpiry || new Date() > user.passwordResetExpiry) {
            return {
                success: false,
                message: 'Invalid or expired token.'
            };
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await this.usersService.updatePassword(user.id, hashedPassword);

        return { success: true, message: 'Password updated successfully!' };
    }

}

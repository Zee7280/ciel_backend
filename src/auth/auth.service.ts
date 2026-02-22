import { Injectable, UnauthorizedException, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { Organization } from '../organizations/entities/organization.entity';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private organizationsService: OrganizationsService,
    ) { }

    async signup(signupDto: SignupDto) {
        try {
            console.log('Signup payload:', signupDto);
            const { password, email, ...userData } = signupDto;

            // Check if user already exists
            const existingUser = await this.usersService.findByEmail(email);
            if (existingUser) {
                throw new ConflictException('Email already exists');
            }

            const hashedPassword = await bcrypt.hash(password, 10);

            let organization: Organization | null = null;
            if (userData.orgName && userData.orgType) {
                organization = await this.organizationsService.create({
                    name: userData.orgName,
                    orgType: userData.orgType,
                });
            }

            const user = await this.usersService.create({
                ...userData,
                email,
                password: hashedPassword,
                organization: organization // Link the org
            });

            return {
                success: true,
                message: 'User created successfully',
                data: {
                    user: this.usersService.formatUserResponse(user)
                }
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
        const { email, password } = loginDto;
        const user = await this.usersService.findByEmail(email);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (user.status !== 'active' && user.status !== 'approved') {
            throw new UnauthorizedException('Account is not active');
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const payload = { sub: user.id, email: user.email, role: user.role, organizationId: user.organization?.id };
        const expiresIn = loginDto.isMobile ? '30d' : '60m';

        return {
            success: true,
            data: {
                access_token: this.jwtService.sign(payload, { expiresIn }),
                user: this.usersService.formatUserResponse(user)
            }
        };
    }

    async forgotPassword(email: string) {
        const user = await this.usersService.findByEmail(email);

        // Always return success to prevent email enumeration
        if (!user) {
            return { success: true, message: 'If an account with that email exists, a reset link has been sent.' };
        }

        // Generate a secure random token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiry = new Date();
        expiry.setHours(expiry.getHours() + 1); // Token valid for 1 hour

        // Save token and expiry to the user
        await this.usersService.savePasswordResetToken(user.id, resetToken, expiry);

        // In a real app, send this via email. For now, return it in the response for testing.
        return {
            success: true,
            message: 'Password reset token generated. In production, this would be sent via email.',
            data: {
                resetToken, // Remove this in production; send via email instead
                expiresAt: expiry
            }
        };
    }

    async resetPassword(token: string, newPassword: string) {
        const user = await this.usersService.findByResetToken(token);

        if (!user) {
            throw new BadRequestException('Invalid or expired reset token');
        }

        if (!user.passwordResetExpiry || new Date() > user.passwordResetExpiry) {
            throw new BadRequestException('Reset token has expired. Please request a new one.');
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await this.usersService.updatePassword(user.id, hashedPassword);

        return { success: true, message: 'Password has been reset successfully. Please login with your new password.' };
    }
}

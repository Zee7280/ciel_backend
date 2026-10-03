import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly otpService: OtpService,
    ) { }

    @Post('send-otp')
    @RateLimit(
        { name: 'send-otp-ip', limit: 8, windowMs: 10 * 60_000, by: 'ip' },
        { name: 'send-otp-email', limit: 6, windowMs: 60 * 60_000, by: 'email' },
    )
    async sendOtp(@Body() dto: SendOtpDto) {
        return this.otpService.sendOtp(dto.email);
    }

    @Post('verify-otp')
    @RateLimit(
        { name: 'verify-otp-acct', limit: 10, windowMs: 10 * 60_000, by: 'ip+email' },
        { name: 'verify-otp-ip', limit: 60, windowMs: 10 * 60_000, by: 'ip' },
    )
    async verifyOtp(@Body() dto: VerifyOtpDto) {
        return this.otpService.verifyOtp(dto.email, dto.otp);
    }

    @Post('signup')
    @RateLimit({ name: 'signup-ip', limit: 15, windowMs: 60 * 60_000, by: 'ip' })
    async signup(@Body() signupDto: SignupDto) {
        return this.authService.signup(signupDto);
    }

    @Post('login')
    @RateLimit(
        { name: 'login-acct', limit: 10, windowMs: 15 * 60_000, by: 'ip+email', message: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
        { name: 'login-ip', limit: 100, windowMs: 15 * 60_000, by: 'ip', message: 'Too many sign-in attempts from this network. Please wait a few minutes and try again.' },
    )
    async login(@Body() loginDto: LoginDto) {
        return this.authService.login(loginDto);
    }

    @Post('forgot-password')
    @RateLimit(
        { name: 'forgot-email', limit: 3, windowMs: 60 * 60_000, by: 'email', message: 'A reset link was already requested for this email recently. Please check your inbox, or try again later.' },
        { name: 'forgot-ip', limit: 10, windowMs: 60 * 60_000, by: 'ip' },
    )
    async forgotPassword(@Body('email') email: string) {
        return this.authService.forgotPassword(email);
    }

    @Post('reset-password')
    @RateLimit({ name: 'reset-ip', limit: 10, windowMs: 10 * 60_000, by: 'ip' })
    async resetPassword(@Body() dto: ResetPasswordDto) {
        return this.authService.resetPassword(dto.token, dto.newPassword);
    }

    /** Server-side logout: bumps tokenVersion so THIS token (and every other session) stops working
     * immediately, instead of staying valid until it expires after the client forgot it. */
    @Post('logout')
    @UseGuards(JwtAuthGuard)
    async logout(@Request() req) {
        await this.authService.logout(req.user.id);
        return { success: true };
    }
}

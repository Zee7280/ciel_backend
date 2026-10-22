import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { proofUploadOptions } from '../common/safe-upload';
import { S3Service } from '../common/s3.service';
import { UsersService } from '../users/users.service';
import {
  SIGNUP_PROOF_FOLDER,
  sanitizeSignupProofDocuments,
} from './signup-proof.util';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  RateLimit,
  RateLimitGuard,
} from '../common/rate-limit/rate-limit.guard';
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
    private readonly s3Service: S3Service,
    private readonly usersService: UsersService,
  ) {}

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
    {
      name: 'verify-otp-acct',
      limit: 10,
      windowMs: 10 * 60_000,
      by: 'ip+email',
    },
    { name: 'verify-otp-ip', limit: 60, windowMs: 10 * 60_000, by: 'ip' },
  )
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.otpService.verifyOtp(dto.email, dto.otp);
  }

  /**
   * Proof-of-affiliation / KYC file for an account that doesn't exist yet. Only open between a
   * successful OTP verification and the signup call (signup clears the OTP), so it can't be used
   * as an anonymous file host.
   */
  @Post('signup-proof')
  // IP only: a multipart body isn't parsed yet when the guard runs, so an email key would be empty.
  @RateLimit({
    name: 'signup-proof-ip',
    limit: 12,
    windowMs: 10 * 60_000,
    by: 'ip',
  })
  @UseInterceptors(FileInterceptor('file', proofUploadOptions))
  async uploadSignupProof(
    @Body('email') rawEmail: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const email =
      typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!email) throw new BadRequestException('Email is required.');
    if (!file) throw new BadRequestException('Attach an image or a PDF.');
    await this.otpService.requireVerifiedEmailForSignup(email);
    if (await this.usersService.findByEmail(email)) {
      throw new ConflictException('Email already exists');
    }
    const url = await this.s3Service.uploadFile(file, SIGNUP_PROOF_FOLDER);
    return {
      success: true,
      data: { url, fileName: String(file.originalname || '').slice(0, 200) },
    };
  }

  @Post('signup')
  @RateLimit({ name: 'signup-ip', limit: 15, windowMs: 60 * 60_000, by: 'ip' })
  async signup(@Body() signupDto: SignupDto) {
    signupDto.signupProofDocuments = sanitizeSignupProofDocuments(
      signupDto.signupProofDocuments,
      (url) => this.s3Service.keyFromPublicUrl(url),
    );
    return this.authService.signup(signupDto);
  }

  @Post('login')
  @RateLimit(
    {
      name: 'login-acct',
      limit: 10,
      windowMs: 15 * 60_000,
      by: 'ip+email',
      message:
        'Too many sign-in attempts. Please wait a few minutes and try again.',
    },
    {
      name: 'login-ip',
      limit: 100,
      windowMs: 15 * 60_000,
      by: 'ip',
      message:
        'Too many sign-in attempts from this network. Please wait a few minutes and try again.',
    },
  )
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('forgot-password')
  @RateLimit(
    {
      name: 'forgot-email',
      limit: 3,
      windowMs: 60 * 60_000,
      by: 'email',
      message:
        'A reset link was already requested for this email recently. Please check your inbox, or try again later.',
    },
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
  async logout(@Request() req: { user: { id: string } }) {
    await this.authService.logout(req.user.id);
    return { success: true };
  }
}

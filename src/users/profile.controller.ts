import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import type {
  ChangePasswordInput,
  GenericProfileUpdateInput,
} from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/** `req.user` as populated by JwtStrategy.validate(). */
type AuthenticatedRequest = { user: { id: string } };

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  getProfile(@Request() req: AuthenticatedRequest) {
    return this.usersService.getProfile(req.user.id);
  }

  @Put()
  async updateProfile(
    @Request() req: AuthenticatedRequest,
    @Body() body: GenericProfileUpdateInput,
  ) {
    const result = await this.usersService.updateGenericProfile(
      req.user.id,
      body,
    );
    return { success: true, data: result.data };
  }

  @Post('change-password')
  async changePassword(
    @Request() req: AuthenticatedRequest,
    @Body() body: ChangePasswordInput,
  ) {
    try {
      return await this.usersService.changePassword(req.user.id, body);
    } catch (error) {
      throw new BadRequestException((error as { message?: string }).message);
    }
  }
}

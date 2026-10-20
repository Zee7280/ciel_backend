import {
  Controller,
  Get,
  Put,
  Body,
  UseGuards,
  Request,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

type AuthenticatedRequest = { user: { id: string } };

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async getSettings(@Request() req: AuthenticatedRequest) {
    const user = await this.usersService.findOne(req.user.id);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const defaultSettings = {
      notifications: {
        email: true,
        push: false,
        sms: false,
      },
      privacy: {
        profileVisibility: 'public',
        showEmail: false,
      },
      language: 'en',
      theme: 'light',
    };

    return {
      success: true,
      data: (user.settings as Record<string, unknown>) || defaultSettings,
    };
  }

  @Put()
  async updateSettings(
    @Request() req: AuthenticatedRequest,
    @Body() settings: Record<string, unknown>,
  ) {
    // Merge with existing settings
    const user = await this.usersService.findOne(req.user.id);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const newSettings: Record<string, unknown> = {
      ...((user.settings as Record<string, unknown>) || {}),
      ...settings,
    };

    await this.usersService.update(req.user.id, { settings: newSettings });
    return { success: true, data: newSettings };
  }
}

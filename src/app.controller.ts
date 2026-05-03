import { Controller, Get, Head, HttpCode, UseGuards, Request } from '@nestjs/common';
import { AppService } from './app.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { Roles } from './auth/roles.decorator';
import { UserRole } from './users/enums/user-role.enum';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Quiet probe requests to raw backend host (Vercel); real favicon lives on the web app. */
  @Get('favicon.ico')
  @Head('favicon.ico')
  @HttpCode(204)
  favicon(): void {
    return;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.STUDENT)
  @Get('profile')
  getProfile(@Request() req) {
    return {
      message: 'You are authorized!',
      user: req.user
    };
  }
}

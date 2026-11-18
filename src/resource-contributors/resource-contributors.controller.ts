import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResourceContributorsService } from './resource-contributors.service';

/** Public contribution certificate (QR / email link); no PII beyond the contributor's name. */
@Controller('public/contributions')
export class PublicContributionsController {
  constructor(private readonly service: ResourceContributorsService) {}

  @Get(':token')
  getCertificate(@Param('token') token: string) {
    return this.service.getPublicCertificate(token);
  }
}

/** Signed-in user's own acknowledged contributions (any role). */
@Controller('contributions')
@UseGuards(JwtAuthGuard)
export class ContributionsController {
  constructor(private readonly service: ResourceContributorsService) {}

  @Get('me')
  async mine(@Request() req: { user: { id: string; email?: string } }) {
    const items = await this.service.listForUser({
      id: req.user.id,
      email: req.user.email,
    });
    return { success: true, count: items.length, items };
  }
}

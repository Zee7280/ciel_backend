import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Request,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request as ExpressRequest, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import {
  RateLimit,
  RateLimitGuard,
} from '../common/rate-limit/rate-limit.guard';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { UniversitySsoService } from './university-sso.service';
import {
  ActivateUniversitySsoDto,
  SsoCallbackQuery,
  SsoCompleteDto,
  SsoExchangeDto,
  SsoStartQuery,
  SsoTestQuery,
  UpsertUniversitySsoDto,
} from './dto/university-sso.dto';

type AuthedRequest = ExpressRequest & { user: { id: string } };

/** Browser-facing sign-in flow. The provider redirects back to `callback`, which always redirects on. */
@Controller('auth/sso')
@UseGuards(RateLimitGuard)
export class UniversitySsoController {
  constructor(private readonly sso: UniversitySsoService) {}

  @Get('universities')
  async universities() {
    return { success: true, data: await this.sso.listActiveForLogin() };
  }

  @Get('start')
  @RateLimit({ name: 'sso-start', limit: 30, windowMs: 10 * 60_000, by: 'ip' })
  async start(
    @Query() q: SsoStartQuery,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const url = await this.sso.start(q, this.sso.redirectUriFor(req));
    res.redirect(302, url);
  }

  @Get('test')
  @RateLimit({ name: 'sso-test', limit: 20, windowMs: 10 * 60_000, by: 'ip' })
  async test(
    @Query() q: SsoTestQuery,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const url = await this.sso.startTest(q.token, this.sso.redirectUriFor(req));
    res.redirect(302, url);
  }

  @Get('callback')
  @RateLimit({
    name: 'sso-callback',
    limit: 60,
    windowMs: 10 * 60_000,
    by: 'ip',
  })
  async callback(
    @Query() q: SsoCallbackQuery,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const url = await this.sso.handleCallback(q, this.sso.redirectUriFor(req));
    res.redirect(302, url);
  }

  @Post('exchange')
  @RateLimit({
    name: 'sso-exchange',
    limit: 30,
    windowMs: 10 * 60_000,
    by: 'ip',
  })
  async exchange(@Body() dto: SsoExchangeDto) {
    return this.sso.exchange(dto.ticket);
  }

  @Post('complete')
  @RateLimit({
    name: 'sso-complete',
    limit: 10,
    windowMs: 60 * 60_000,
    by: 'ip',
  })
  async complete(@Body() dto: SsoCompleteDto) {
    return this.sso.complete(dto);
  }
}

/** Super admin: configure, test, activate and disable SSO per university. */
@Controller('admin/university-sso')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminUniversitySsoController {
  constructor(private readonly sso: UniversitySsoService) {}

  @Get()
  async list(@Req() req: ExpressRequest) {
    return {
      success: true,
      data: await this.sso.listForAdmin(this.sso.redirectUriFor(req)),
    };
  }

  @Get(':organizationId')
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Req() req: ExpressRequest,
  ) {
    return {
      success: true,
      data: await this.sso.getForAdmin(
        organizationId,
        this.sso.redirectUriFor(req),
      ),
    };
  }

  @Put(':organizationId')
  async upsert(
    @Request() req: AuthedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpsertUniversitySsoDto,
  ) {
    return {
      success: true,
      data: await this.sso.upsert(
        req.user,
        organizationId,
        dto,
        this.sso.redirectUriFor(req),
      ),
    };
  }

  @Post(':organizationId/activate')
  async activate(
    @Request() req: AuthedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: ActivateUniversitySsoDto,
  ) {
    return {
      success: true,
      data: await this.sso.activate(
        req.user,
        organizationId,
        dto ?? {},
        this.sso.redirectUriFor(req),
      ),
    };
  }

  @Post(':organizationId/disable')
  async disable(
    @Request() req: AuthedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return {
      success: true,
      data: await this.sso.disable(
        req.user,
        organizationId,
        this.sso.redirectUriFor(req),
      ),
    };
  }

  @Post(':organizationId/test-link')
  async testLink(
    @Request() req: AuthedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return {
      success: true,
      data: await this.sso.createTestLink(
        req.user,
        organizationId,
        this.sso.apiBaseFor(req),
      ),
    };
  }

  @Delete(':organizationId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return {
      success: true,
      data: await this.sso.remove(req.user, organizationId),
    };
  }
}

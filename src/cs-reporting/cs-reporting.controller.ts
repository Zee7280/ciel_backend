import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CsReportingService } from './cs-reporting.service';
import { CreateCsReportDto } from './dto/create-cs-report.dto';
import { csReportPdf, csReportXlsx } from './cs-reporting.export';

type AdminRequest = Request & {
  user: { id: string; email?: string; name?: string };
};

const FORMATS = {
  xlsx: {
    build: csReportXlsx,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  pdf: { build: csReportPdf, type: 'application/pdf' },
} as const;

/** Community-service reports for HEC, government and universities. Generating is audited by the
 * interceptor; downloads are GETs, so each one is written to the audit log here. */
@Controller('admin/cs-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class CsReportingController {
  constructor(
    private readonly reporting: CsReportingService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  @Get()
  list() {
    return this.reporting.list();
  }

  @Post()
  create(@Body() dto: CreateCsReportDto, @Req() req: AdminRequest) {
    return this.reporting.create(dto, req.user);
  }

  @Get(':id/xlsx')
  xlsx(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
    @Res() res: Response,
  ) {
    return this.download(id, 'xlsx', req, res);
  }

  @Get(':id/pdf')
  pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
    @Res() res: Response,
  ) {
    return this.download(id, 'pdf', req, res);
  }

  private async download(
    id: string,
    format: keyof typeof FORMATS,
    req: AdminRequest,
    res: Response,
  ) {
    const snapshot = await this.reporting.get(id);
    const file = await FORMATS[format].build(snapshot);
    await this.auditLogs.recordMutation({
      action: `GET /admin/cs-reports/:id/${format}`,
      user: req.user.email ?? req.user.id,
      user_email: req.user.email ?? null,
      ip: req.ip ?? null,
      target: snapshot.code,
      target_type: 'cs_report',
      details: { format, includeStudents: snapshot.includeStudents },
    });
    res.set({
      'Content-Type': FORMATS[format].type,
      'Content-Disposition': `attachment; filename="community-service-report-${snapshot.code}.${format}"`,
      'Cache-Control': 'no-store',
    });
    res.send(file);
  }
}

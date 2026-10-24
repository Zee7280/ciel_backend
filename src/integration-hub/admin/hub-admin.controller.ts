import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { UserRole } from '../../users/enums/user-role.enum';
import { Organization } from '../../organizations/entities/organization.entity';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';
import { PlatformsService } from '../platforms/platforms.service';
import { ConnectionsService } from '../platforms/connections.service';
import { CredentialsService } from '../security/credentials.service';
import { MetricCatalogService } from '../metrics/metric-catalog.service';
import { ProcessingService } from '../processing/processing.service';
import { EvidenceService } from '../evidence/evidence.service';
import { HubRecordsService } from './hub-records.service';
import { HubHealthService } from './hub-health.service';
import {
  ConnectionDecisionDto,
  CreatePlatformDto,
  IssueCredentialDto,
  MetricDefinitionDto,
  ProposeConnectionDto,
  ReviewRecordDto,
  SetPlatformStatusDto,
  UpdateConnectionDto,
  UpdateMetricDefinitionDto,
  UpdatePlatformDto,
} from '../platforms/dto/platform.dto';
import { HubSecretsService } from '../security/hub-secrets.service';
import { HubStorageService } from '../evidence/hub-storage.service';

type AdminRequest = {
  user: { id: string; email?: string; name?: string };
  ip?: string;
};

function actorOf(req: AdminRequest): HubActor {
  return {
    type: 'super_admin',
    id: req.user.id,
    label: req.user.email ?? req.user.name ?? null,
    ip: req.ip ?? null,
  };
}

/**
 * Super Admin Integration Console. Everything here is JWT + SUPER_ADMIN; the only core table it
 * touches is `organizations`, read-only, to validate and name the organization on a connection.
 */
@Controller('admin/integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class HubAdminController {
  constructor(
    private readonly platforms: PlatformsService,
    private readonly connections: ConnectionsService,
    private readonly credentials: CredentialsService,
    private readonly metrics: MetricCatalogService,
    private readonly processing: ProcessingService,
    private readonly evidence: EvidenceService,
    private readonly records: HubRecordsService,
    private readonly health: HubHealthService,
    private readonly audit: HubAuditService,
    private readonly secrets: HubSecretsService,
    private readonly storage: HubStorageService,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
  ) {}

  // ---- overview -------------------------------------------------------------------------------

  @Get('health')
  async getHealth(@Query('refresh') refresh?: string) {
    const data = await this.health.snapshot(refresh === '1');
    return {
      success: true,
      data: {
        ...data,
        configuration: {
          secrets_key_configured: this.secrets.configured,
          evidence_storage_configured: this.storage.configured,
          evidence_bucket: this.storage.configured ? this.storage.bucket : null,
        },
      },
    };
  }

  /** Core lookup (read-only) so the propose-connection form can pick an organization by name. */
  @Get('organizations/search')
  async searchOrganizations(@Query('q') q?: string) {
    const term = (q ?? '').trim();
    if (term.length < 2) return { success: true, data: [] };
    // Only approved, unblocked organizations can hold a connection, so only those are offered.
    const rows = await this.organizations.find({
      where: {
        name: ILike(`%${term}%`),
        verificationStatus: 'APPROVED',
        isBlocked: false,
      },
      select: { id: true, name: true, orgType: true, verificationStatus: true },
      take: 20,
      order: { name: 'ASC' },
    });
    return { success: true, data: rows };
  }

  // ---- platforms ------------------------------------------------------------------------------

  @Get('platforms')
  async listPlatforms(@Query() query: Record<string, string>) {
    const data = await this.platforms.list(query);
    return { success: true, ...data };
  }

  @Post('platforms')
  async createPlatform(
    @Req() req: AdminRequest,
    @Body() dto: CreatePlatformDto,
  ) {
    const data = await this.platforms.create(dto, actorOf(req));
    return { success: true, data };
  }

  @Get('platforms/:id')
  async getPlatform(@Param('id', ParseUUIDPipe) id: string) {
    const platform = await this.platforms.get(id);
    const credentials = await this.credentials.listForPlatform(id);
    const connections = await this.connections.list({
      platformId: id,
      limit: 100,
    });
    return {
      success: true,
      data: { platform, credentials, connections: connections.rows },
    };
  }

  @Patch('platforms/:id')
  async updatePlatform(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformDto,
  ) {
    const data = await this.platforms.update(id, dto, actorOf(req));
    return { success: true, data };
  }

  @Post('platforms/:id/status')
  async setPlatformStatus(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPlatformStatusDto,
  ) {
    const data = await this.platforms.setStatus(
      id,
      dto.status,
      dto.reason,
      actorOf(req),
    );
    return { success: true, data };
  }

  @Get('platforms/:id/credentials')
  async listCredentials(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.credentials.listForPlatform(id) };
  }

  @Post('platforms/:id/credentials')
  async issueCredential(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueCredentialDto,
  ) {
    const data = await this.credentials.issue(
      id,
      { label: dto.label, expiresInDays: dto.expiresInDays },
      actorOf(req),
    );
    return {
      success: true,
      message: 'Store the secret now; it is not shown again.',
      data,
    };
  }

  @Post('platforms/:id/credentials/:credentialId/revoke')
  async revokeCredential(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
  ) {
    const data = await this.credentials.revoke(id, credentialId, actorOf(req));
    return { success: true, data };
  }

  // ---- connections ----------------------------------------------------------------------------

  @Get('connections')
  async listConnections(@Query() query: Record<string, string>) {
    const data = await this.connections.list(query);
    return { success: true, ...data };
  }

  @Post('connections')
  async proposeConnection(
    @Req() req: AdminRequest,
    @Body() dto: ProposeConnectionDto,
  ) {
    if (!dto.organizationId)
      throw new BadRequestException('organizationId is required');
    const org = await this.organizations.findOne({
      where: { id: dto.organizationId },
      select: { id: true, name: true, verificationStatus: true },
    });
    if (!org) throw new NotFoundException('Organization not found');
    if (org.verificationStatus !== 'APPROVED') {
      throw new BadRequestException(
        'Only approved organizations can hold connections',
      );
    }
    const data = await this.connections.propose(
      dto,
      { id: org.id, name: org.name },
      actorOf(req),
      false,
    );
    return { success: true, data };
  }

  @Get('connections/:id')
  async getConnection(@Param('id', ParseUUIDPipe) id: string) {
    const connection = await this.connections.get(id);
    const summaries = await this.records.summariesFor(id);
    return { success: true, data: { connection, summaries } };
  }

  @Patch('connections/:id')
  async updateConnection(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConnectionDto,
  ) {
    return {
      success: true,
      data: await this.connections.update(id, dto, actorOf(req)),
    };
  }

  @Post('connections/:id/authorize')
  async authorizeConnection(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.connections.authorize(id, actorOf(req)),
    };
  }

  @Post('connections/:id/suspend')
  async suspendConnection(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectionDecisionDto,
  ) {
    return {
      success: true,
      data: await this.connections.suspend(id, actorOf(req), dto?.reason),
    };
  }

  @Post('connections/:id/resume')
  async resumeConnection(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.connections.resume(id, actorOf(req)),
    };
  }

  @Post('connections/:id/revoke')
  async revokeConnection(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectionDecisionDto,
  ) {
    return {
      success: true,
      data: await this.connections.revoke(id, actorOf(req), dto?.reason),
    };
  }

  // ---- events / processing --------------------------------------------------------------------

  @Get('events')
  async listEvents(@Query() query: Record<string, string>) {
    return { success: true, ...(await this.records.listEvents(query)) };
  }

  @Get('events/:id')
  async getEvent(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.records.getEvent(id) };
  }

  @Post('events/:id/replay')
  async replayEvent(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const outcome = await this.processing.replay(id);
    await this.audit.log({
      actor: actorOf(req),
      action: 'EVENT_REPLAYED',
      targetType: 'event',
      targetId: id,
      details: { ...outcome },
    });
    return { success: true, data: outcome };
  }

  @Post('events/sweep')
  async sweepNow(@Req() req: AdminRequest) {
    const result = await this.processing.sweep({ limit: 50, budgetMs: 20_000 });
    await this.audit.log({
      actor: actorOf(req),
      action: 'SWEEP_RUN',
      targetType: 'system',
      details: { ...result },
    });
    return { success: true, data: result };
  }

  // ---- records --------------------------------------------------------------------------------

  @Get('records')
  async listRecords(@Query() query: Record<string, string>) {
    return { success: true, ...(await this.records.listRecords(query)) };
  }

  @Get('records/:id')
  async getRecord(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.records.getRecord(id) };
  }

  @Post('records/:id/review')
  async reviewRecord(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRecordDto,
  ) {
    return {
      success: true,
      data: await this.records.review(
        id,
        dto.reviewState,
        dto.note,
        actorOf(req),
      ),
    };
  }

  /** Operational: recompute one connection's summaries from its current records (audited). */
  @Post('connections/:id/rebuild-summaries')
  async rebuildSummaries(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.connections.get(id);
    const rows = await this.processing.rebuildSummaries(id);
    await this.audit.log({
      actor: actorOf(req),
      action: 'SUMMARIES_REBUILT',
      targetType: 'connection',
      targetId: id,
      connectionId: id,
      details: { rows },
    });
    return { success: true, data: { rows } };
  }

  @Get('summaries')
  async summaries(@Query('connectionId', ParseUUIDPipe) connectionId: string) {
    return {
      success: true,
      data: await this.records.summariesFor(connectionId),
    };
  }

  // ---- evidence -------------------------------------------------------------------------------

  @Get('evidence')
  async listEvidence(@Query() query: Record<string, string>) {
    return { success: true, ...(await this.evidence.list(query)) };
  }

  @Get('evidence/:id/view-url')
  async evidenceViewUrl(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.evidence.viewUrl(id, {
        actor: actorOf(req),
        allowRestricted: true,
      }),
    };
  }

  // ---- metrics --------------------------------------------------------------------------------

  @Get('metrics')
  async listMetrics() {
    return { success: true, data: await this.metrics.list() };
  }

  @Post('metrics')
  async createMetric(
    @Req() req: AdminRequest,
    @Body() dto: MetricDefinitionDto,
  ) {
    return {
      success: true,
      data: await this.metrics.create(dto, actorOf(req)),
    };
  }

  @Patch('metrics/:id')
  async updateMetric(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMetricDefinitionDto,
  ) {
    return {
      success: true,
      data: await this.metrics.update(id, dto, actorOf(req)),
    };
  }

  // ---- audit ----------------------------------------------------------------------------------

  @Get('audit')
  async listAudit(@Query() query: Record<string, string>) {
    return { success: true, ...(await this.audit.list(query)) };
  }
}

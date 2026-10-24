import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UseInterceptors } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OrgResponseInterceptor } from './org-response.interceptor';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { UserRole } from '../../users/enums/user-role.enum';
import { Organization } from '../../organizations/entities/organization.entity';
import { ExternalPlatform } from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';
import { ConnectionsService } from '../platforms/connections.service';
import { EvidenceService } from '../evidence/evidence.service';
import { HubRecordsService } from './hub-records.service';
import {
  ConnectionDecisionDto,
  ProposeConnectionDto,
} from '../platforms/dto/platform.dto';

type OrgRequest = {
  user: {
    id: string;
    email?: string;
    name?: string;
    role: string;
    organizationId?: string;
  };
  ip?: string;
};

/**
 * Organization-side External Records (design §5, interface B). Scoped to the caller's own
 * organization on every query; another organization's data is "not found", never "forbidden".
 */
@Controller('org/integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(OrgResponseInterceptor)
@Roles(
  UserRole.UNIVERSITY,
  UserRole.NGO,
  UserRole.CORPORATE,
  UserRole.ORGANIZATION_ADMIN,
)
export class HubOrgController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly records: HubRecordsService,
    private readonly evidence: EvidenceService,
    private readonly audit: HubAuditService,
    @InjectRepository(ExternalPlatform, HUB_CONNECTION)
    private readonly platforms: Repository<ExternalPlatform>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
  ) {}

  private orgIdOf(req: OrgRequest): string {
    const id = req.user.organizationId;
    if (!id) {
      throw new ForbiddenException(
        'Your account is not linked to an organization',
      );
    }
    return id;
  }

  private actorOf(req: OrgRequest): HubActor {
    return {
      type: 'org_admin',
      id: req.user.id,
      label: req.user.email ?? req.user.name ?? null,
      ip: req.ip ?? null,
    };
  }

  /** Platforms an organization may connect to (live or sandbox), minimal fields. */
  @Get('platforms')
  async listPlatforms() {
    const rows = await this.platforms.find({
      where: { status: In(['live', 'sandbox']) },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        status: true,
        approvedEventTypes: true,
        integrationMode: true,
      },
      order: { name: 'ASC' },
    });
    return { success: true, data: rows };
  }

  @Get('connections')
  async listConnections(
    @Req() req: OrgRequest,
    @Query() query: Record<string, string>,
  ) {
    const data = await this.connections.list({
      ...query,
      organizationId: this.orgIdOf(req),
    });
    return { success: true, ...data };
  }

  @Post('connections')
  async propose(@Req() req: OrgRequest, @Body() dto: ProposeConnectionDto) {
    const orgId = this.orgIdOf(req);
    const org = await this.organizations.findOne({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        verificationStatus: true,
        isBlocked: true,
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    if (org.verificationStatus !== 'APPROVED' || org.isBlocked) {
      throw new ForbiddenException(
        'Only approved organizations can connect external platforms',
      );
    }
    const data = await this.connections.propose(
      {
        ...dto,
        organizationId: orgId,
        personalFieldsAllowed: false,
        orgEvidenceOpenAllowed: false,
      },
      { id: org.id, name: org.name },
      this.actorOf(req),
      true,
    );
    return { success: true, data };
  }

  @Get('connections/:id')
  async getConnection(
    @Req() req: OrgRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const orgId = this.orgIdOf(req);
    const connection = await this.connections.getForOrganization(id, orgId);
    const summaries = await this.records.summariesFor(id, {
      organizationId: orgId,
    });
    return { success: true, data: { connection, summaries } };
  }

  @Post('connections/:id/approve')
  async approve(
    @Req() req: OrgRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.connections.orgApprove(
        id,
        this.orgIdOf(req),
        this.actorOf(req),
      ),
    };
  }

  @Post('connections/:id/reject')
  async reject(
    @Req() req: OrgRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectionDecisionDto,
  ) {
    return {
      success: true,
      data: await this.connections.orgReject(
        id,
        this.orgIdOf(req),
        this.actorOf(req),
        dto?.reason,
      ),
    };
  }

  @Post('connections/:id/request-suspension')
  async requestSuspension(
    @Req() req: OrgRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectionDecisionDto,
  ) {
    return {
      success: true,
      data: await this.connections.orgRequestSuspension(
        id,
        this.orgIdOf(req),
        this.actorOf(req),
        dto?.reason,
      ),
    };
  }

  @Get('records')
  async listRecords(
    @Req() req: OrgRequest,
    @Query() query: Record<string, string>,
  ) {
    return {
      success: true,
      ...(await this.records.listRecords(query, {
        organizationId: this.orgIdOf(req),
      })),
    };
  }

  @Get('records/:id')
  async getRecord(
    @Req() req: OrgRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.records.getRecord(id, {
        organizationId: this.orgIdOf(req),
      }),
    };
  }

  @Get('evidence')
  async listEvidence(
    @Req() req: OrgRequest,
    @Query() query: Record<string, string>,
  ) {
    return {
      success: true,
      ...(await this.evidence.list({
        ...query,
        organizationId: this.orgIdOf(req),
      })),
    };
  }

  /** Opening an original needs the explicit per-connection permission (design §3 of the approval memo). */
  @Get('evidence/:id/view-url')
  async evidenceViewUrl(
    @Req() req: OrgRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      success: true,
      data: await this.evidence.viewUrl(id, {
        actor: this.actorOf(req),
        organizationId: this.orgIdOf(req),
        allowRestricted: false,
      }),
    };
  }

  @Get('audit')
  async listAudit(
    @Req() req: OrgRequest,
    @Query() query: Record<string, string>,
  ) {
    const orgId = this.orgIdOf(req);
    const connectionId = query.connectionId;
    if (!connectionId)
      return { success: true, rows: [], total: 0, page: 1, limit: 25 };
    await this.connections.getForOrganization(connectionId, orgId);
    return {
      success: true,
      ...(await this.audit.list({ ...query, connectionId })),
    };
  }
}

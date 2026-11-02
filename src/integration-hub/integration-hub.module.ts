import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HUB_CONNECTION } from './hub-connection.constants';
import { buildHubDataSourceOptions } from './hub-data-source';
import { HUB_ENTITIES } from './entities';
import { Organization } from '../organizations/entities/organization.entity';
import { CronSecretGuard } from '../jobs/cron-secret.guard';
import { HubAuditService } from './audit/hub-audit.service';
import { HubSecretsService } from './security/hub-secrets.service';
import { CredentialsService } from './security/credentials.service';
import { PlatformAuthGuard } from './security/platform-auth.guard';
import { PlatformsService } from './platforms/platforms.service';
import { ConnectionsService } from './platforms/connections.service';
import { MetricCatalogService } from './metrics/metric-catalog.service';
import { ProcessingService } from './processing/processing.service';
import { IntakeService } from './intake/intake.service';
import { HubStorageService } from './evidence/hub-storage.service';
import { EvidenceService } from './evidence/evidence.service';
import { RetentionService } from './maintenance/retention.service';
import { HubRecordsService } from './admin/hub-records.service';
import { HubHealthService } from './admin/hub-health.service';
import { HubDeletionService } from './platforms/hub-deletion.service';
import { HubVendorController } from './vendor/hub-vendor.controller';
import { HubAdminController } from './admin/hub-admin.controller';
import { HubOrgController } from './admin/hub-org.controller';
import { HubInternalJobsController } from './maintenance/hub-internal-jobs.controller';
import { HubExportController } from './export/hub-export.controller';
import { HubExportService } from './export/hub-export.service';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { FypEntry } from '../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../paths/entities/venture-entry.entity';
import { QuickWorkLog } from '../quick-work/entities/quick-work-log.entity';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';

/**
 * Integration Hub root module. Registered by AppModule only when HUB_DATABASE_URL is set, so a
 * deployment without the hub (or with a broken hub URL) never affects the core application.
 *
 * Hub services inject repositories with `@InjectRepository(Entity, HUB_CONNECTION)` and therefore
 * run under the restricted database role. Core repositories (default connection) appear here for
 * two read-only uses: `Organization`, used by the admin/org controllers to validate and name the
 * organization on a connection, and the University Export API (`export/`), which reads core
 * records for the university on an approved connection — never intake or processing.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: HUB_CONNECTION,
      // A wrong HUB_DATABASE_URL must fail fast at boot (visible in the deploy log), not hang
      // every cold start for Nest's default 9 × 3 s retries.
      useFactory: () => ({
        ...buildHubDataSourceOptions(process.env, 'runtime'),
        retryAttempts: 1,
        retryDelay: 500,
      }),
    }),
    TypeOrmModule.forFeature(HUB_ENTITIES, HUB_CONNECTION),
    TypeOrmModule.forFeature([
      Organization,
      User,
      Opportunity,
      AttendanceLog,
      StudentReport,
      FypEntry,
      VentureEntry,
      QuickWorkLog,
    ]),
    FacultyUniversityScopeModule,
  ],
  controllers: [
    HubVendorController,
    HubExportController,
    HubAdminController,
    HubOrgController,
    HubInternalJobsController,
  ],
  providers: [
    HubExportService,
    HubAuditService,
    HubSecretsService,
    CredentialsService,
    PlatformAuthGuard,
    PlatformsService,
    ConnectionsService,
    MetricCatalogService,
    ProcessingService,
    IntakeService,
    HubStorageService,
    EvidenceService,
    RetentionService,
    HubRecordsService,
    HubHealthService,
    HubDeletionService,
    CronSecretGuard,
  ],
  exports: [TypeOrmModule],
})
export class IntegrationHubModule implements OnModuleInit {
  constructor(
    private readonly health: HubHealthService,
    private readonly guard: PlatformAuthGuard,
  ) {}

  onModuleInit(): void {
    this.health.bindRateLimitCounter(() => this.guard.limiter.rateLimitHits);
  }
}

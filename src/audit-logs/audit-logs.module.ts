import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditLogsService } from './audit-logs.service';
import { AdminMutationAuditInterceptor } from './admin-mutation-audit.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditLogsService, AdminMutationAuditInterceptor],
  exports: [AuditLogsService, AdminMutationAuditInterceptor],
})
export class AuditLogsModule {}

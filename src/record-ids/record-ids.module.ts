import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { Organization } from '../organizations/entities/organization.entity';
import { User } from '../users/entities/user.entity';
import { RecordCounter } from './entities/record-counter.entity';
import { University } from './entities/university.entity';
import { RecordIdsAdminController } from './record-ids.controller';
import { RecordIdsService } from './record-ids.service';

/** Global so the Paths, Quick Work and Reports services can stamp ids without module wiring. */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([University, RecordCounter, Organization, User]),
    AuditLogsModule,
  ],
  controllers: [RecordIdsAdminController],
  providers: [RecordIdsService],
  exports: [RecordIdsService],
})
export class RecordIdsModule {}

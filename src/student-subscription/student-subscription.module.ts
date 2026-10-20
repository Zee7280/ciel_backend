import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentSubscriptionFee } from './entities/student-subscription-fee.entity';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { StudentSubscriptionService } from './student-subscription.service';
import { StudentSubscriptionController } from './student-subscription.controller';
import { AdminStudentSubscriptionController } from './admin-student-subscription.controller';
import { SubscriptionActiveGuard } from './subscription-active.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { StorageModule } from '../common/storage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([StudentSubscriptionFee, User, Organization]),
    NotificationsModule,
    AuditLogsModule,
    StorageModule,
  ],
  controllers: [
    StudentSubscriptionController,
    AdminStudentSubscriptionController,
  ],
  providers: [StudentSubscriptionService, SubscriptionActiveGuard],
  exports: [StudentSubscriptionService, SubscriptionActiveGuard],
})
export class StudentSubscriptionModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { StudentReport } from '../reports/entities/student-report.entity';
import { User } from '../users/entities/user.entity';
import { ResourceContributionAcknowledgement } from './entities/resource-contribution-acknowledgement.entity';
import {
  ContributionsController,
  PublicContributionsController,
} from './resource-contributors.controller';
import { ResourceContributorsService } from './resource-contributors.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ResourceContributionAcknowledgement,
      StudentReport,
      User,
    ]),
    NotificationsModule,
  ],
  controllers: [PublicContributionsController, ContributionsController],
  providers: [ResourceContributorsService],
  exports: [ResourceContributorsService],
})
export class ResourceContributorsModule {}

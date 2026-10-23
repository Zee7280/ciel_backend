import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentReport } from './entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunityAwardService } from './community-award.service';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([StudentReport, Organization]),
    NotificationsModule,
    FacultyUniversityScopeModule,
  ],
  providers: [CommunityAwardService],
  exports: [CommunityAwardService],
})
export class CommunityAwardModule {}

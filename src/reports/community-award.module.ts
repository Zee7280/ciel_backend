import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentReport } from './entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { PathGraderRun } from '../paths/entities/path-grader-run.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunityAwardService } from './community-award.service';

@Module({
    imports: [TypeOrmModule.forFeature([StudentReport, Organization, PathGraderRun]), NotificationsModule],
    providers: [CommunityAwardService],
    exports: [CommunityAwardService],
})
export class CommunityAwardModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PathsController } from './paths.controller';
import { AdminPathsController } from './admin-paths.controller';
import { PathsService } from './paths.service';
import { CourseProjectEntry } from './entities/course-project-entry.entity';
import { FypEntry } from './entities/fyp-entry.entity';
import { VentureEntry } from './entities/venture-entry.entity';
import { TeamMemberInvite } from './entities/team-member-invite.entity';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { StorageModule } from '../common/storage.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([CourseProjectEntry, FypEntry, VentureEntry, TeamMemberInvite, User, Organization]),
        StorageModule,
        MailModule,
        NotificationsModule,
    ],
    controllers: [PathsController, AdminPathsController],
    providers: [PathsService],
    exports: [TypeOrmModule],
})
export class PathsModule { }

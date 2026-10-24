import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuickWorkLog } from './entities/quick-work-log.entity';
import { QuickWorkParticipant } from './entities/quick-work-participant.entity';
import { QuickWorkService } from './quick-work.service';
import {
  FacultyQuickWorkController,
  QuickWorkController,
} from './quick-work.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      QuickWorkLog,
      QuickWorkParticipant,
      User,
      AttendanceLog,
    ]),
    MailModule,
    NotificationsModule,
  ],
  controllers: [QuickWorkController, FacultyQuickWorkController],
  providers: [QuickWorkService],
})
export class QuickWorkModule {}

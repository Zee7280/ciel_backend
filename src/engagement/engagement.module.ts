import { Module } from '@nestjs/common';
import { StorageModule } from '../common/storage.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Participation } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { EngagementService } from './engagement.service';
import { EngagementController } from './engagement.controller';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';

import { MailModule } from '../mail/mail.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Participation, AttendanceLog, Opportunity, User]),
        StorageModule,
        MailModule,
    ],
    providers: [
        EngagementService
    ],
    controllers: [
        EngagementController
    ],
    exports: [
        EngagementService
    ],
})
export class EngagementModule { }

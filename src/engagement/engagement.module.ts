import { Module } from '@nestjs/common';
import { StorageModule } from '../common/storage.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Participant } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { EngagementService } from './engagement.service';
import { EngagementController } from './engagement.controller';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { OpportunityTeamMember } from '../opportunities/entities/opportunity-team-member.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([Participant, AttendanceLog, Opportunity, User, OpportunityTeamMember]),
        StorageModule,
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

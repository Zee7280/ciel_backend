import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Participant } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { EngagementService } from './engagement.service';
import { EngagementController } from './engagement.controller';
import { Opportunity } from '../opportunities/entities/opportunity.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([Participant, AttendanceLog, Opportunity]),
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

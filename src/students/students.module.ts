import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { OpportunityParticipant } from '../opportunities/entities/opportunity-participant.entity';
import { OpportunityTeamMember } from '../opportunities/entities/opportunity-team-member.entity';

@Module({
    imports: [TypeOrmModule.forFeature([User, Opportunity, Timesheet, OpportunityParticipant, OpportunityTeamMember])],
    controllers: [StudentsController],
    providers: [StudentsService],
    exports: [StudentsService],
})
export class StudentsModule { }

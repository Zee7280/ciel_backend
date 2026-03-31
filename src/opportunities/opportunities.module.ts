import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OpportunitiesService } from './opportunities.service';
import { OpportunitiesController } from './opportunities.controller';
import { AdminOpportunitiesController } from './admin-opportunities.controller';
import { PublicOpportunitiesController } from './public-opportunities.controller';
import { ParticipantsController } from './participants.controller';
import { Opportunity } from './entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { EngagementModule } from '../engagement/engagement.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Opportunity, Participation]),
        OrganizationsModule,
        UsersModule,
        EngagementModule
    ],
    controllers: [OpportunitiesController, AdminOpportunitiesController, PublicOpportunitiesController, ParticipantsController],
    providers: [OpportunitiesService],
    exports: [OpportunitiesService],
})
export class OpportunitiesModule { }

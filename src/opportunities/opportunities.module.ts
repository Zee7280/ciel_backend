import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OpportunitiesService } from './opportunities.service';
import { OpportunitiesController } from './opportunities.controller';
import { AdminOpportunitiesController } from './admin-opportunities.controller';
import { Opportunity } from './entities/opportunity.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OpportunityParticipant } from './entities/opportunity-participant.entity';
import { OpportunityTeamMember } from './entities/opportunity-team-member.entity';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [TypeOrmModule.forFeature([Opportunity, OpportunityParticipant, OpportunityTeamMember]), OrganizationsModule, UsersModule],
    controllers: [OpportunitiesController, AdminOpportunitiesController],
    providers: [OpportunitiesService],
    exports: [OpportunitiesService],
})
export class OpportunitiesModule { }

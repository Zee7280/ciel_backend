import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OpportunitiesService } from './opportunities.service';
import { OpportunitiesController } from './opportunities.controller';
import { AdminOpportunitiesController } from './admin-opportunities.controller';
import { PublicOpportunitiesController } from './public-opportunities.controller';
import { ParticipantsController } from './participants.controller';
import { Opportunity } from './entities/opportunity.entity';
import { OpportunityApplication } from './entities/opportunity-application.entity';
import { OpportunityApplicationsService } from './opportunity-applications.service';
import { Organization } from '../organizations/entities/organization.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { EngagementModule } from '../engagement/engagement.module';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';
import { StudentReport } from '../reports/entities/student-report.entity';
import { StudentOpportunitiesController } from './student-opportunities.controller';
import { OpportunityWorkflowService } from './opportunity-workflow.service';
import { VerificationVerifyAuthGuard } from '../auth/verification-verify-auth.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Opportunity,
            Organization,
            Participation,
            User,
            OpportunityApplication,
            StudentReport,
        ]),
        OrganizationsModule,
        UsersModule,
        EngagementModule,
        MailModule,
        NotificationsModule,
        AuditLogsModule,
    ],
    controllers: [OpportunitiesController, AdminOpportunitiesController, PublicOpportunitiesController, ParticipantsController, StudentOpportunitiesController],
    providers: [OpportunitiesService, OpportunityWorkflowService, OpportunityApplicationsService, VerificationVerifyAuthGuard],
    exports: [OpportunitiesService, OpportunityWorkflowService, OpportunityApplicationsService],
})
export class OpportunitiesModule { }

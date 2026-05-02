import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FacultyUniversityScopeAssignment } from './entities/faculty-university-scope-assignment.entity';
import { FacultyUniversityScopeService } from './faculty-university-scope.service';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { AdminFacultyUniversityScopeController } from './admin-faculty-university-scope.controller';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            FacultyUniversityScopeAssignment,
            User,
            Organization,
            Participation,
            OpportunityApplication,
            Opportunity,
        ]),
        AuditLogsModule,
    ],
    controllers: [AdminFacultyUniversityScopeController],
    providers: [FacultyUniversityScopeService],
    exports: [FacultyUniversityScopeService],
})
export class FacultyUniversityScopeModule {}

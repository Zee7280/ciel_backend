import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';
import { StudentSubscriptionModule } from '../student-subscription/student-subscription.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UniversitySso } from './entities/university-sso.entity';
import { SsoLoginTicket } from './entities/sso-login-ticket.entity';
import { UniversitySsoService } from './university-sso.service';
import {
  AdminUniversitySsoController,
  UniversitySsoController,
} from './university-sso.controller';

/**
 * University single sign-on for students (OpenID Connect: Google Workspace, Microsoft 365 or a
 * generic provider). Off until the platform switch is on AND an admin activates a university.
 * Reuses the existing University, Student and User records and the normal login status checks.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UniversitySso,
      SsoLoginTicket,
      User,
      Organization,
    ]),
    AuthModule,
    UsersModule,
    FacultyUniversityScopeModule,
    StudentSubscriptionModule,
    AuditLogsModule,
  ],
  controllers: [UniversitySsoController, AdminUniversitySsoController],
  providers: [UniversitySsoService],
})
export class UniversitySsoModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationMembershipFee } from './entities/organization-membership-fee.entity';
import { User } from '../users/entities/user.entity';
import { Setting } from '../settings/entities/setting.entity';
import { OrganizationMembershipService } from './organization-membership.service';
import { OrganizationMembershipController } from './organization-membership.controller';
import { AdminOrganizationMembershipController } from './admin-organization-membership.controller';
import { MembershipActiveGuard } from './membership-active.guard';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationMembershipFee, User, Setting]),
        AuditLogsModule,
    ],
    controllers: [OrganizationMembershipController, AdminOrganizationMembershipController],
    providers: [OrganizationMembershipService, MembershipActiveGuard],
    exports: [OrganizationMembershipService, MembershipActiveGuard],
})
export class OrganizationMembershipModule { }

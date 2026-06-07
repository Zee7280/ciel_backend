import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UsersAliasController, UsersController } from './users.controller';
import { ProfileController } from './profile.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizationMembershipModule } from '../organization-membership/organization-membership.module';

@Module({
    imports: [TypeOrmModule.forFeature([User]), NotificationsModule, OrganizationMembershipModule],
    controllers: [UsersController, UsersAliasController, ProfileController],
    providers: [UsersService],
    exports: [UsersService],
})
export class UsersModule { }

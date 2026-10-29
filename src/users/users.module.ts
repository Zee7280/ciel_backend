import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { FacultyUniversityConfirmation } from './entities/faculty-university-confirmation.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ProfileController } from './profile.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizationMembershipModule } from '../organization-membership/organization-membership.module';
import { StudentSubscriptionModule } from '../student-subscription/student-subscription.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, FacultyUniversityConfirmation]),
    NotificationsModule,
    OrganizationMembershipModule,
    StudentSubscriptionModule,
  ],
  controllers: [UsersController, ProfileController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

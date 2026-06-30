import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './admin/admin.module';
import { PartnersModule } from './partners/partners.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { OpportunitiesModule } from './opportunities/opportunities.module';
import { VerificationsModule } from './verifications/verifications.module';
import { StudentsModule } from './students/students.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { FundingModule } from './funding/funding.module';
import { SettingsModule } from './settings/settings.module';
import { Setting } from './settings/entities/setting.entity';
import { ChatModule } from './chat/chat.module';
import { MailModule } from './mail/mail.module';
import { EngagementModule } from './engagement/engagement.module';
import { StorageModule } from './common/storage.module';
import { PaymentsModule } from './payments/payments.module';
import { FacultyModule } from './faculty/faculty.module';
import { ContactModule } from './contact/contact.module';
import { PlatformStatsModule } from './platform-stats/platform-stats.module';
import { SupportModule } from './support/support.module';
import { APP_FILTER } from '@nestjs/core';
import { IssueLogsExceptionFilter } from './issue-logs/issue-logs.filter';
import { IssueLogsModule } from './issue-logs/issue-logs.module';
import { OrganizationMembershipModule } from './organization-membership/organization-membership.module';
import { FeedbackModule } from './feedback/feedback.module';
import { TutorialsModule } from './tutorials/tutorials.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_NAME'),
        ssl:
          process.env.NODE_ENV === 'production' || process.env.VERCEL
            ? {
                rejectUnauthorized: false,
              }
            : configService.get<string>('DB_SSL') === 'true'
              ? {
                  rejectUnauthorized: false,
                }
              : undefined,
        synchronize: true,
        autoLoadEntities: true,
        logging: false,
      }),
      inject: [ConfigService],
    }),
    AuthModule,
    UsersModule,
    AdminModule,
    PartnersModule,
    StudentsModule,
    OrganizationsModule,
    OpportunitiesModule,
    VerificationsModule,
    ReportsModule,
    FundingModule,
    NotificationsModule,
    SettingsModule,
    ChatModule,
    MailModule,
    EngagementModule,
    StorageModule,
    PaymentsModule,
    FacultyModule,
    ContactModule,
    PlatformStatsModule,
    SupportModule,
    IssueLogsModule,
    OrganizationMembershipModule,
    FeedbackModule,
    TutorialsModule,
    AnalyticsModule,
    JobsModule,
    TypeOrmModule.forFeature([Setting]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: IssueLogsExceptionFilter,
    },
  ],
})
export class AppModule {}

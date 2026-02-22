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
        ssl: (process.env.NODE_ENV === 'production' || process.env.VERCEL) ? {
          rejectUnauthorized: false
        } : (configService.get<string>('DB_SSL') === 'true' ? {
          rejectUnauthorized: false,
        } : undefined),
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
    TypeOrmModule.forFeature([Setting])
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }

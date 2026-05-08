import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformTutorial } from './entities/platform-tutorial.entity';
import { TutorialsService } from './tutorials.service';
import { AdminTutorialsController } from './admin-tutorials.controller';
import { StudentTutorialsController } from './student-tutorials.controller';
import { PlatformTutorialsController } from './platform-tutorials.controller';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([PlatformTutorial]),
        AuditLogsModule,
    ],
    controllers: [
        AdminTutorialsController,
        StudentTutorialsController,
        PlatformTutorialsController,
    ],
    providers: [TutorialsService],
    exports: [TutorialsService],
})
export class TutorialsModule {}

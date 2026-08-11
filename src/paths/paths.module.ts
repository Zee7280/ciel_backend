import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PathsController } from './paths.controller';
import { AdminPathsController } from './admin-paths.controller';
import { PathsService } from './paths.service';
import { CourseProjectEntry } from './entities/course-project-entry.entity';
import { FypEntry } from './entities/fyp-entry.entity';
import { VentureEntry } from './entities/venture-entry.entity';
import { User } from '../users/entities/user.entity';
import { StorageModule } from '../common/storage.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([CourseProjectEntry, FypEntry, VentureEntry, User]),
        StorageModule,
    ],
    controllers: [PathsController, AdminPathsController],
    providers: [PathsService],
    exports: [TypeOrmModule],
})
export class PathsModule { }

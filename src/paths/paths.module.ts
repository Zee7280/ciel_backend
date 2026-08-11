import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PathsController } from './paths.controller';
import { PathsService } from './paths.service';
import { CourseProjectEntry } from './entities/course-project-entry.entity';
import { FypEntry } from './entities/fyp-entry.entity';
import { VentureEntry } from './entities/venture-entry.entity';
import { StorageModule } from '../common/storage.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([CourseProjectEntry, FypEntry, VentureEntry]),
        StorageModule,
    ],
    controllers: [PathsController],
    providers: [PathsService],
    exports: [TypeOrmModule],
})
export class PathsModule { }

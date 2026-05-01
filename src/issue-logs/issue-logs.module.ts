import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IssueLog } from './entities/issue-log.entity';
import { IssueLogsService } from './issue-logs.service';

@Module({
  imports: [TypeOrmModule.forFeature([IssueLog])],
  providers: [IssueLogsService],
  exports: [IssueLogsService],
})
export class IssueLogsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { CommunityAwardModule } from '../reports/community-award.module';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { NpeRankingEvaluation } from './entities/npe-ranking-evaluation.entity';
import { NpeRankingRun } from './entities/npe-ranking-run.entity';
import { NpeRankingSnapshot } from './entities/npe-ranking-snapshot.entity';
import { NpeStudioPublication } from './entities/npe-studio-publication.entity';
import { NpeRankingService } from './npe-ranking.service';
import { NpeStudioService } from './npe-studio.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudentReport,
      NpeRankingRun,
      NpeRankingEvaluation,
      NpeRankingSnapshot,
      NpeStudioPublication,
      AttendanceLog,
      Participation,
    ]),
    CommunityAwardModule,
    AiModule,
  ],
  providers: [NpeRankingService, NpeStudioService],
  exports: [NpeRankingService, NpeStudioService],
})
export class NpeRankingModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { CommunityAwardModule } from '../reports/community-award.module';
import { StudentReport } from '../reports/entities/student-report.entity';
import { NpeRankingEvaluation } from './entities/npe-ranking-evaluation.entity';
import { NpeRankingRun } from './entities/npe-ranking-run.entity';
import { NpeRankingSnapshot } from './entities/npe-ranking-snapshot.entity';
import { NpeRankingService } from './npe-ranking.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudentReport,
      NpeRankingRun,
      NpeRankingEvaluation,
      NpeRankingSnapshot,
    ]),
    CommunityAwardModule,
    AiModule,
  ],
  providers: [NpeRankingService],
  exports: [NpeRankingService],
})
export class NpeRankingModule {}

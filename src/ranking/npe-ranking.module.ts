import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { CommunityAwardModule } from '../reports/community-award.module';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { NpeAdminAction } from './entities/npe-admin-action.entity';
import { NpeCriterionOverride } from './entities/npe-criterion-override.entity';
import { NpeRankingChallenge } from './entities/npe-ranking-challenge.entity';
import { NpeRankingEvaluation } from './entities/npe-ranking-evaluation.entity';
import { NpeRankingRun } from './entities/npe-ranking-run.entity';
import { NpeRankingSnapshot } from './entities/npe-ranking-snapshot.entity';
import { NpeStudioPublication } from './entities/npe-studio-publication.entity';
import { NpeGovernanceService } from './npe-governance.service';
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
      NpeCriterionOverride,
      NpeAdminAction,
      NpeRankingChallenge,
      AttendanceLog,
      Participation,
    ]),
    CommunityAwardModule,
    AiModule,
  ],
  providers: [NpeRankingService, NpeStudioService, NpeGovernanceService],
  exports: [NpeRankingService, NpeStudioService, NpeGovernanceService],
})
export class NpeRankingModule {}

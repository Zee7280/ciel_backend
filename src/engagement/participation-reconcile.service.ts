import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { Participation } from './entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { buildTeamDisplayName } from './team-display-name.util';
import { demoteExtraTeamLeadsInScope } from './team-lead-canonical.util';

const ACTIVE_STATUSES = [
  'approved',
  'verified',
  'accepted',
  'finalized',
] as const;

@Injectable()
export class ParticipationReconcileService {
  private readonly logger = new Logger(ParticipationReconcileService.name);

  constructor(
    @InjectRepository(Participation)
    private readonly participationRepo: Repository<Participation>,
    @InjectRepository(Opportunity)
    private readonly opportunityRepo: Repository<Opportunity>,
  ) {}

  async reconcileEnrollmentMetadata(): Promise<{
    display_names_backfilled: number;
    duplicate_leads_normalized: number;
    scanned_teams: number;
  }> {
    const rowsMissingDisplay = await this.participationRepo.find({
      where: {
        teamId: Not(IsNull()),
        teamDisplayName: IsNull(),
        status: In([...ACTIVE_STATUSES]),
      },
      relations: ['student'],
      take: 500,
    });

    let displayNamesBackfilled = 0;
    const opportunityCache = new Map<string, Opportunity>();

    for (const row of rowsMissingDisplay) {
      const teamId = (row.teamId || '').trim();
      if (!teamId) continue;
      let opportunity = opportunityCache.get(row.projectId);
      if (!opportunity) {
        opportunity =
          (await this.opportunityRepo.findOne({
            where: { id: row.projectId },
          })) ?? undefined;
        if (opportunity) opportunityCache.set(row.projectId, opportunity);
      }
      if (!opportunity) continue;

      const lead = await this.participationRepo.findOne({
        where: {
          projectId: row.projectId,
          teamId,
          isTeamLead: true,
          status: In([...ACTIVE_STATUSES]),
        },
        relations: ['student'],
      });
      const anchor = lead ?? row;
      const displayName = buildTeamDisplayName(opportunity, anchor);
      const teamRows = await this.participationRepo.find({
        where: {
          projectId: row.projectId,
          teamId,
          status: In([...ACTIVE_STATUSES]),
        },
      });
      for (const member of teamRows) {
        if ((member.teamDisplayName || '').trim()) continue;
        member.teamDisplayName = displayName;
      }
      await this.participationRepo.save(teamRows);
      displayNamesBackfilled += teamRows.filter(
        (m) => m.teamDisplayName === displayName,
      ).length;
    }

    const teamIds = [
      ...new Set(
        (
          await this.participationRepo.find({
            where: { teamId: Not(IsNull()), status: In([...ACTIVE_STATUSES]) },
            select: ['projectId', 'teamId'],
            take: 1000,
          })
        )
          .map((r) => `${r.projectId}|${r.teamId}`)
          .filter(Boolean),
      ),
    ];

    let duplicateLeadsNormalized = 0;
    for (const key of teamIds) {
      const [projectId, teamId] = key.split('|');
      if (!projectId || !teamId) continue;
      const members = await this.participationRepo.find({
        where: { projectId, teamId, status: In([...ACTIVE_STATUSES]) },
      });
      const leadCount = members.filter((m) => m.isTeamLead).length;
      if (leadCount <= 1) continue;
      const canonical = members.find((m) => m.isTeamLead) ?? members[0];
      await demoteExtraTeamLeadsInScope(
        this.participationRepo,
        projectId,
        { teamId, applicationId: canonical.applicationId },
        canonical.id,
      );
      duplicateLeadsNormalized += 1;
    }

    this.logger.log(
      `Enrollment reconcile: display_names=${displayNamesBackfilled}, leads=${duplicateLeadsNormalized}, teams=${teamIds.length}`,
    );

    return {
      display_names_backfilled: displayNamesBackfilled,
      duplicate_leads_normalized: duplicateLeadsNormalized,
      scanned_teams: teamIds.length,
    };
  }
}

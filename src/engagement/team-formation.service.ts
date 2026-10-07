import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import crypto from 'crypto';
import { Participation } from './entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import {
  buildTeamDisplayName,
  countDistinctTeamIdsOnProject,
} from './team-display-name.util';
import { demoteExtraTeamLeadsInScope } from './team-lead-canonical.util';
import { resolveTeamSeatCap, teamCapacityError } from './team-capacity.util';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Platform-wide maximum team size (team lead included). */
export const MAX_TEAM_SIZE = 20;

const ACTIVE_STATUSES = [
  'approved',
  'verified',
  'accepted',
  'finalized',
] as const;

function isLowProgressReportStatus(status: string | null | undefined): boolean {
  const st = String(status || '')
    .trim()
    .toLowerCase();
  return (
    !st ||
    st === 'draft' ||
    st === 'revision' ||
    st === 'continue' ||
    st === 'rejected'
  );
}

@Injectable()
export class TeamFormationService {
  constructor(
    @InjectRepository(Participation)
    private readonly participationRepo: Repository<Participation>,
    @InjectRepository(Opportunity)
    private readonly opportunityRepo: Repository<Opportunity>,
    @InjectRepository(StudentReport)
    private readonly reportRepo: Repository<StudentReport>,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private generateTeamId(): string {
    const year = new Date().getFullYear();
    const a = crypto.randomBytes(4).toString('hex').toUpperCase();
    const b = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `TM-${year}-${a}-${b}`;
  }

  async formTeamFromLead(
    studentUserId: string,
    projectId: string,
    memberParticipationIds: string[] = [],
  ) {
    const opportunity = await this.opportunityRepo.findOne({
      where: { id: projectId },
    });
    if (!opportunity) {
      throw new NotFoundException('Project not found');
    }

    const lead = await this.participationRepo.findOne({
      where: { studentId: studentUserId, projectId },
      relations: ['student'],
    });
    if (!lead) {
      throw new NotFoundException('You are not enrolled on this project');
    }
    if (lead.studentId !== studentUserId) {
      throw new ForbiddenException(
        'Only the enrolled student can form a team for this seat',
      );
    }

    // Only a free (not-yet-teamed) student, or the lead of an existing team, may form / extend a team.
    // A plain member of someone else's team calling this would otherwise make themselves lead and
    // demote the real one.
    if ((lead.teamId || '').trim() && lead.isTeamLead !== true) {
      throw new ForbiddenException(
        'Only the team lead can add members to this team.',
      );
    }

    const memberIds = [
      ...new Set(memberParticipationIds.map((id) => id.trim()).filter(Boolean)),
    ];
    let members: Participation[] = [];
    if (memberIds.length) {
      members = await this.participationRepo.find({
        where: {
          id: In(memberIds),
          projectId,
          status: In([...ACTIVE_STATUSES]),
        },
      });
      if (members.length !== memberIds.length) {
        throw new BadRequestException(
          'One or more team member enrollments were not found on this project',
        );
      }
      if (members.some((m) => m.id === lead.id)) {
        throw new BadRequestException(
          'Team lead cannot be listed as a team member',
        );
      }
      // A lead may not poach members of another team (or another team's lead): that would also
      // delete their draft reports below.
      const leadTeamId = (lead.teamId || '').trim();
      const taken = members.filter(
        (m) =>
          m.isTeamLead === true ||
          ((m.teamId || '').trim() && (m.teamId || '').trim() !== leadTeamId),
      );
      if (taken.length) {
        throw new BadRequestException(
          'One or more students already belong to another team and cannot be added.',
        );
      }
      // Team size: never above the opportunity's seats, and never above the platform maximum.
      const seatCap = resolveTeamSeatCap(
        (opportunity.timeline as { volunteers_required?: unknown } | null)
          ?.volunteers_required,
      );
      const capError = teamCapacityError(members.length, seatCap);
      if (capError) throw new BadRequestException(capError);
      const existingMembers = leadTeamId
        ? await this.participationRepo.count({
            where: { projectId, teamId: leadTeamId, status: In([...ACTIVE_STATUSES]) },
          })
        : 1;
      if (members.length + Math.max(existingMembers, 1) > MAX_TEAM_SIZE) {
        throw new BadRequestException(
          `A team can have at most ${MAX_TEAM_SIZE} members including the team lead.`,
        );
      }
    }

    if (
      !memberIds.length &&
      lead.participationMode === 'individual' &&
      !(lead.teamId || '').trim()
    ) {
      return {
        formed: false,
        message: 'Add at least one verified team member before forming a team',
        team_id: null,
        team_display_name: lead.teamDisplayName,
      };
    }

    const existingTeamId = (lead.teamId || '').trim();
    const targetTeamId = existingTeamId || this.generateTeamId();

    const allProjectRows = await this.participationRepo.find({
      where: { projectId, status: In([...ACTIVE_STATUSES]) },
      relations: ['student'],
    });

    let teamSequence = 1;
    if (!existingTeamId) {
      teamSequence = countDistinctTeamIdsOnProject(allProjectRows) + 1;
    }

    const displayName = buildTeamDisplayName(opportunity, lead, teamSequence);
    const leadApplicationId = lead.applicationId;
    const leadName = lead.student?.name || lead.fullName || 'Your team lead';

    const result = await this.participationRepo.manager.transaction(
      async (em) => {
        const participationRepo = em.getRepository(Participation);
        const reportRepo = em.getRepository(StudentReport);

        const freshLead = await participationRepo.findOne({
          where: { id: lead.id },
          relations: ['student'],
        });
        if (!freshLead) {
          throw new NotFoundException('Lead enrollment not found');
        }

        freshLead.participationMode = 'team';
        freshLead.isTeamLead = true;
        freshLead.teamId = targetTeamId;
        freshLead.teamDisplayName = displayName;
        freshLead.formationSource = freshLead.formationSource || 'report';
        await participationRepo.save(freshLead);

        await demoteExtraTeamLeadsInScope(
          participationRepo,
          projectId,
          { teamId: targetTeamId, applicationId: leadApplicationId },
          freshLead.id,
        );

        const linked: Participation[] = [];
        const newlyLinkedIds: string[] = [];
        for (const member of members) {
          const alreadyOnThisTeam =
            (member.teamId || '').trim() === targetTeamId;
          member.teamId = targetTeamId;
          member.participationMode = 'team';
          member.isTeamLead = false;
          member.teamDisplayName = displayName;
          member.formationSource = member.formationSource || 'report';
          if (leadApplicationId) {
            member.applicationId = leadApplicationId;
          }
          member.attendanceApproverType =
            freshLead.attendanceApproverType ?? member.attendanceApproverType;
          member.primaryFacultyEmail =
            freshLead.primaryFacultyEmail ?? member.primaryFacultyEmail;
          member.secondaryFacultyEmail =
            freshLead.secondaryFacultyEmail ?? member.secondaryFacultyEmail;
          linked.push(member);
          if (!alreadyOnThisTeam) newlyLinkedIds.push(member.id);
        }
        if (linked.length) {
          await participationRepo.save(linked);
        }

        const nonLeadStudentIds = linked
          .map((m) => m.studentId)
          .filter((id): id is string => Boolean(id));
        if (nonLeadStudentIds.length && freshLead.studentId) {
          const reports = await reportRepo
            .createQueryBuilder('r')
            .where('r.studentId IN (:...sids)', { sids: nonLeadStudentIds })
            .andWhere(
              '(r.opportunityId = :oid OR (r.project_id IS NOT NULL AND TRIM(r.project_id) = CAST(:oid AS varchar)))',
              { oid: projectId },
            )
            .getMany();
          const toDelete = reports.filter((r) =>
            isLowProgressReportStatus(r.status),
          );
          if (toDelete.length) {
            await reportRepo.remove(toDelete);
          }
        }

        return {
          formed: true,
          team_id: targetTeamId,
          team_display_name: displayName,
          lead_participation_id: freshLead.id,
          member_participation_ids: linked.map((m) => m.id),
          newly_linked_participation_ids: newlyLinkedIds,
        };
      },
    );

    if (result.formed && result.newly_linked_participation_ids?.length) {
      await this.notifyLinkedTeamMembers({
        projectId,
        opportunity,
        leadName,
        teamDisplayName: result.team_display_name,
        memberParticipationIds: result.newly_linked_participation_ids,
      });
    }

    return result;
  }

  private async notifyLinkedTeamMembers(params: {
    projectId: string;
    opportunity: Opportunity;
    leadName: string;
    teamDisplayName: string | null | undefined;
    memberParticipationIds: string[];
  }) {
    const members = await this.participationRepo.find({
      where: { id: In(params.memberParticipationIds) },
      relations: ['student'],
    });

    for (const member of members) {
      const email = (member.student?.email || member.email || '').trim();
      const userId = member.studentId?.trim();
      if (email) {
        await this.mailService.sendTeamMemberAddedToProject({
          to: email,
          leadName: params.leadName,
          projectTitle: params.opportunity.title,
          teamDisplayName: params.teamDisplayName,
          projectId: params.projectId,
        });
      }
      if (userId) {
        await this.notificationsService.createNotification(userId, {
          type: 'team',
          title: 'Added to a project team',
          message: `${params.leadName} added you to ${params.opportunity.title}. Open your member portal to log attendance — your team lead files the report.`,
        });
      }
    }
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { Opportunity } from './entities/opportunity.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Payment } from '../payments/entities/payment.entity';
import { AdminTeamSnapshot } from './entities/admin-team-snapshot.entity';
import { AdminTeamOpDto } from './dto/admin-team-op.dto';
import { AdminMergeTeamMembersDto } from './dto/admin-merge-team-members.dto';
import { buildTeamDisplayName } from '../engagement/team-display-name.util';
import {
  resolveTeamSeatCap,
  teamCapacityError,
} from '../engagement/team-capacity.util';
import {
  plain,
  restoreSnapshot,
  saveSnapshot,
  type SnapshotActor,
} from './admin-team-snapshot.util';
import {
  OpportunityApplicationsService,
  TEAM_ACTIVE_PARTICIPATION_STATUSES,
} from './opportunity-applications.service';

/**
 * Admin "Teams & enrollments" safety layer: impact previews, undo snapshots and single-seat roster
 * operations (move / make lead / make individual). Depends on OpportunityApplicationsService for the
 * roster listing and report helpers; that service does not depend on this one.
 */
@Injectable()
export class AdminTeamSafetyService {
  constructor(
    @InjectRepository(Participation)
    private readonly participationRepo: Repository<Participation>,
    @InjectRepository(Opportunity)
    private readonly opportunityRepo: Repository<Opportunity>,
    private readonly apps: OpportunityApplicationsService,
  ) {}

  /**
   * Roster corrections on one enrolled seat: move to another team, make individual, make lead.
   * `dryRun` returns blockers/warnings and writes nothing; a real run saves an undo snapshot first.
   */
  async adminTeamOp(
    opportunityId: string,
    dto: AdminTeamOpDto,
    actor: SnapshotActor | undefined,
    dryRun: boolean,
  ) {
    const opportunity = await this.opportunityRepo.findOne({
      where: { id: opportunityId },
    });
    if (!opportunity) throw new NotFoundException('Opportunity not found');

    const member = await this.participationRepo.findOne({
      where: {
        id: dto.member_participation_id,
        projectId: opportunityId,
        status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
      },
    });
    if (!member) {
      throw new BadRequestException(
        await this.apps.describeMissingMergeEnrollments(opportunityId, [
          dto.member_participation_id,
        ]),
      );
    }

    const blockers: string[] = [];
    const warnings: string[] = [];
    const who = member.fullName || member.email || 'This member';
    const sourceTeamId = (member.teamId || '').trim();
    const sourceMates = sourceTeamId
      ? await this.participationRepo.find({
          where: {
            projectId: opportunityId,
            teamId: sourceTeamId,
            status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
          },
          order: { createdAt: 'ASC' },
        })
      : [];
    const successor = sourceMates.find((m) => m.id !== member.id) ?? null;
    const leavingLead = member.isTeamLead === true && !!successor;

    let targetTeamId = '';
    let targetMembers: Participation[] = [];
    let draftsToRemove: StudentReport[] = [];

    if (dto.op === 'split') {
      if (!sourceTeamId) blockers.push(`${who} is already an individual enrollment.`);
    } else if (dto.op === 'set_lead') {
      if (!sourceTeamId) blockers.push(`${who} is not on a team.`);
      else if (member.isTeamLead) blockers.push(`${who} is already the team lead.`);
    } else {
      targetTeamId = (dto.target_team_id || '').trim();
      if (!targetTeamId) blockers.push('Choose the team to move this member into.');
      else if (targetTeamId === sourceTeamId) blockers.push(`${who} is already on that team.`);
      else {
        targetMembers = await this.participationRepo.find({
          where: {
            projectId: opportunityId,
            teamId: targetTeamId,
            status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
          },
          order: { createdAt: 'ASC' },
        });
        if (!targetMembers.length) blockers.push('That team was not found on this project. Reload and try again.');
        else {
          const capError = teamCapacityError(
            targetMembers.length,
            resolveTeamSeatCap(opportunity.timeline?.volunteers_required),
          );
          if (capError) blockers.push(capError);
        }
      }
      if (member.studentId) {
        const reports = await this.apps.findReportsForOpportunityStudents(opportunityId, [member.studentId]);
        if (reports.some((r) => this.apps.isBlockingReportStatusForTeamMerge(r.status))) {
          blockers.push(`${who} already has a submitted or verified report. Resolve it manually first.`);
        }
        draftsToRemove = reports.filter((r) => this.apps.isLowProgressReportStatus(r.status));
        if (draftsToRemove.length) {
          warnings.push(`${draftsToRemove.length} draft report(s) of ${who} will be removed (restorable with Undo); the team lead's report is used instead.`);
        }
      }
    }
    if (leavingLead && successor && dto.op !== 'set_lead') {
      warnings.push(`${successor.fullName || 'Another member'} becomes lead of the team ${who} leaves.`);
    }
    if (dto.op === 'split' && sourceTeamId && member.studentId) {
      warnings.push('The team report stays with the team lead; this member will need their own report.');
    }

    const preview = {
      success: true,
      data: {
        can_apply: blockers.length === 0,
        op: dto.op,
        member: { id: member.id, name: member.fullName ?? null, email: member.email ?? null },
        from_team_id: sourceTeamId || null,
        to_team_id: dto.op === 'move' ? targetTeamId : null,
        undoable: true,
      },
      blockers,
      warnings,
    };
    if (dryRun || blockers.length) {
      if (!dryRun) throw new BadRequestException(blockers.join(' '));
      return preview;
    }

    let snapshotId = '';
    await this.participationRepo.manager.transaction(async (em) => {
      const repo = em.getRepository(Participation);
      const changed = new Map<string, Participation>();
      const track = (row: Participation) => changed.set(row.id, row);
      const before = new Map<string, Record<string, unknown>>();
      const remember = (row: Participation) => {
        if (before.has(row.id)) return;
        before.set(row.id, {
          id: row.id,
          teamId: row.teamId ?? null,
          participationMode: row.participationMode ?? null,
          isTeamLead: row.isTeamLead === true,
          teamDisplayName: row.teamDisplayName ?? null,
          formationSource: row.formationSource ?? null,
          applicationId: row.applicationId ?? null,
        });
      };

      remember(member);
      if (dto.op === 'set_lead') {
        for (const m of sourceMates) {
          remember(m);
          m.isTeamLead = m.id === member.id;
          track(m);
        }
      } else {
        if (leavingLead && successor) {
          remember(successor);
          successor.isTeamLead = true;
          track(successor);
        }
        if (dto.op === 'split') {
          member.teamId = null as never;
          member.participationMode = 'individual';
          member.isTeamLead = false;
          member.teamDisplayName = null as never;
        } else {
          const targetLead =
            targetMembers.find((m) => m.isTeamLead) ?? targetMembers[0];
          member.teamId = targetTeamId;
          member.participationMode = 'team';
          member.isTeamLead = false;
          member.teamDisplayName =
            targetLead.teamDisplayName ||
            buildTeamDisplayName(opportunity, targetLead);
          member.formationSource = member.formationSource || 'admin_merge';
          if (targetLead.applicationId) {
            member.applicationId = targetLead.applicationId;
          }
        }
        track(member);
      }
      if (!changed.has(member.id)) track(member);
      await repo.save([...changed.values()]);

      let deletedReports: StudentReport[] = [];
      if (dto.op === 'move' && draftsToRemove.length) {
        const reportRepo = em.getRepository(StudentReport);
        deletedReports = plain(draftsToRemove);
        await reportRepo.remove(draftsToRemove);
      }

      const snapshot = await saveSnapshot(em, {
        opportunityId,
        kind: dto.op === 'move' ? 'move_member' : dto.op === 'split' ? 'split_member' : 'set_lead',
        label:
          dto.op === 'move'
            ? `${who} → team ${targetTeamId}`
            : dto.op === 'split'
              ? `${who} made individual`
              : `${who} made lead of team ${sourceTeamId}`,
        actor,
        summary: {
          participations: before.size,
          reports: deletedReports.length,
          payments: 0,
          applications: 0,
        },
        payload: {
          before: [...before.values()],
          demotedLeadIds: [],
          deletedReports,
          reassigned: null,
        },
      });
      snapshotId = snapshot.id;
    });

    const refreshed = await this.apps.adminListOpportunityTeams(opportunityId);
    return {
      success: true,
      snapshot_id: snapshotId,
      message:
        dto.op === 'move'
          ? `${who} moved to team ${targetTeamId}.`
          : dto.op === 'split'
            ? `${who} is now an individual enrollment.`
            : `${who} is now the team lead.`,
      ...refreshed,
    };
  }

  async adminListTeamSnapshots(opportunityId: string, limit = 25) {
    const rows = await this.participationRepo.manager
      .getRepository(AdminTeamSnapshot)
      .find({
        where: { opportunityId },
        order: { createdAt: 'DESC' },
        take: Math.min(Math.max(limit, 1), 100),
        select: [
          'id',
          'kind',
          'label',
          'actorEmail',
          'summary',
          'restoredAt',
          'restoredBy',
          'createdAt',
        ],
      });
    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        actor_email: r.actorEmail,
        summary: r.summary,
        restored_at: r.restoredAt,
        restored_by: r.restoredBy,
        created_at: r.createdAt,
      })),
    };
  }

  async adminRestoreTeamSnapshot(
    opportunityId: string,
    snapshotId: string,
    actor?: SnapshotActor,
  ) {
    const result = await this.participationRepo.manager.transaction((em) =>
      restoreSnapshot(em, snapshotId, opportunityId, actor),
    );
    const refreshed = await this.apps.adminListOpportunityTeams(opportunityId);
    return {
      success: true,
      message: 'Change undone.',
      restored: result.restored,
      ...refreshed,
    };
  }

  /** What deleting this whole team would remove — shown before the admin confirms. */
  async adminPreviewDeleteTeam(opportunityId: string, teamId: string) {
    const members = await this.apps.findActiveParticipationsForAdminTeamRoute(
      opportunityId,
      teamId,
    );
    if (!members.length) {
      throw new NotFoundException('Team not found for this opportunity');
    }
    return this.buildDeletePreview(opportunityId, members, true);
  }

  async adminPreviewDeleteTeamMember(
    opportunityId: string,
    teamId: string,
    memberId: string,
  ) {
    const decoded = decodeURIComponent((memberId || '').trim());
    if (!this.apps.looksLikeUuidParam(decoded)) {
      throw new BadRequestException(
        'This line is roster-only until seats are issued. Withdraw the student application instead.',
      );
    }
    const member = await this.participationRepo.findOne({
      where: {
        id: decoded,
        projectId: opportunityId,
        status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
      },
    });
    if (!member) {
      throw new NotFoundException('Team member not found for this opportunity');
    }
    const preview = await this.buildDeletePreview(opportunityId, [member], false);
    const dbTeamId = (member.teamId || '').trim();
    if (dbTeamId && member.isTeamLead) {
      const others = await this.participationRepo.find({
        where: {
          projectId: opportunityId,
          teamId: dbTeamId,
          status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
        },
        order: { createdAt: 'ASC' },
      });
      const next = others.find((o) => o.id !== member.id);
      if (next) {
        preview.warnings.push(
          `${next.fullName || 'Another member'} will become the team lead.`,
        );
      }
    }
    return preview;
  }

  private async buildDeletePreview(
    opportunityId: string,
    members: Participation[],
    wholeTeam: boolean,
  ) {
    const studentIds = members
      .map((m) => m.studentId)
      .filter((id): id is string => Boolean(id));
    const reports = studentIds.length
      ? await this.apps.findReportsForOpportunityStudents(opportunityId, studentIds)
      : [];
    const payments = studentIds.length
      ? await this.participationRepo.manager.getRepository(Payment).count({
          where: { projectId: opportunityId, studentId: In(studentIds) },
        })
      : 0;
    const nameByStudent = new Map(
      members.map((m) => [m.studentId, m.fullName ?? m.email ?? 'Member']),
    );
    const warnings: string[] = [];
    const blocking = reports.filter((r) =>
      this.apps.isBlockingReportStatusForTeamMerge(r.status),
    );
    if (blocking.length) {
      warnings.push(
        `${blocking.length} report(s) are already submitted or verified and will be deleted too.`,
      );
    }
    if (payments > 0) {
      warnings.push(`${payments} payment record(s) will be removed.`);
    }
    return {
      success: true,
      data: {
        scope: wholeTeam ? 'team' : 'member',
        members: members.map((m) => ({
          id: m.id,
          name: m.fullName ?? null,
          email: m.email ?? null,
          role: m.isTeamLead ? 'lead' : 'member',
        })),
        reports: reports.map((r) => ({
          id: r.id,
          status: r.status ?? null,
          owner: nameByStudent.get(r.studentId) ?? null,
        })),
        payments,
        applications_to_withdraw: new Set(
          members.map((m) => m.applicationId).filter(Boolean),
        ).size,
        undoable: true,
      },
      warnings,
    };
  }

  /** Dry run of a merge: same checks as the real thing, nothing is written. */
  async adminPreviewMergeTeamMembers(
    opportunityId: string,
    dto: AdminMergeTeamMembersDto,
  ) {
    const memberIds = [
      ...new Set(
        dto.member_participation_ids.map((id) => id.trim()).filter(Boolean),
      ),
    ];
    const leadId = dto.lead_participation_id.trim();
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (memberIds.length < 2) blockers.push('Select at least two enrollments.');
    if (!memberIds.includes(leadId)) {
      blockers.push('The team lead must be one of the selected enrollments.');
    }
    const members = await this.participationRepo.find({
      where: {
        id: In(memberIds),
        projectId: opportunityId,
        status: In([...TEAM_ACTIVE_PARTICIPATION_STATUSES]),
      },
    });
    if (members.length !== memberIds.length) {
      const found = new Set(members.map((m) => m.id));
      blockers.push(
        await this.apps.describeMissingMergeEnrollments(
          opportunityId,
          memberIds.filter((id) => !found.has(id)),
        ),
      );
    }
    const nonLead = members.filter((m) => m.id !== leadId && m.studentId);
    const nonLeadReports = nonLead.length
      ? await this.apps.findReportsForOpportunityStudents(
          opportunityId,
          nonLead.map((m) => m.studentId as string),
        )
      : [];
    const submitted = nonLeadReports.filter((r) =>
      this.apps.isBlockingReportStatusForTeamMerge(r.status),
    );
    if (submitted.length) {
      blockers.push(
        'A non-lead member already has a submitted or verified report. Resolve it manually first.',
      );
    }
    const drafts = nonLeadReports.filter((r) =>
      this.apps.isLowProgressReportStatus(r.status),
    );
    if (drafts.length && dto.delete_non_lead_draft_reports !== false) {
      warnings.push(
        `${drafts.length} draft report(s) on non-lead members will be removed (restorable with Undo).`,
      );
    }
    const teamIds = new Set(
      members.map((m) => (m.teamId || '').trim()).filter(Boolean),
    );
    if (teamIds.size > 1) {
      warnings.push(
        `Members currently belong to ${teamIds.size} different teams; they will all move into one.`,
      );
    }
    return {
      success: true,
      data: {
        can_merge: blockers.length === 0,
        members: members.map((m) => ({
          id: m.id,
          name: m.fullName ?? null,
          email: m.email ?? null,
          current_team_id: m.teamId ?? null,
          will_be_lead: m.id === leadId,
        })),
        draft_reports_to_remove: drafts.length,
        undoable: true,
      },
      blockers,
      warnings,
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { User } from '../users/entities/user.entity';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';
import { findCanonicalTeamLeadParticipation } from '../engagement/team-lead-canonical.util';
import {
  attendanceCountsTowardProgress,
  resolveEffectiveAttendanceApproverType,
} from '../engagement/attendance-approver.util';
import { buildTeamDisplayName } from '../engagement/team-display-name.util';
import { resolveParticipationForAttendanceUnlock } from '../engagement/attendance-unlock.util';
import {
  participationPhaseLabel,
  resolveParticipationPhase,
} from './participation-phase.util';

export type ParticipationYourRole =
  | 'none'
  | 'pending_application'
  | 'individual_owner'
  | 'team_lead'
  | 'team_member';

export type ParticipationRecommendedAction =
  | 'apply_individual'
  | 'apply_team_lead'
  | 'wait_for_lead'
  | 'complete_verification'
  | 'open_team_report'
  | 'open_my_participation'
  | 'open_own_report';

export type ParticipationGuideResult = {
  your_role: ParticipationYourRole;
  recommended_action: ParticipationRecommendedAction;
  can_apply: boolean;
  can_apply_as_team_lead: boolean;
  team_lead_name: string | null;
  team_display_name: string | null;
  attendance_approver_type: 'faculty' | 'partner';
  attendance_approver_label: string;
  participation_phase: ReturnType<typeof resolveParticipationPhase>;
  participation_phase_label: string;
  messages: { en: string; ur: string };
};

function normEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function personName(row: Participation | null | undefined): string {
  if (!row) return '';
  return (row.fullName || row.student?.name || row.email || '').trim();
}

@Injectable()
export class StudentParticipationService {
  constructor(
    @InjectRepository(Participation)
    private readonly participationRepo: Repository<Participation>,
    @InjectRepository(Opportunity)
    private readonly opportunityRepo: Repository<Opportunity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(StudentReport)
    private readonly reportRepo: Repository<StudentReport>,
    @InjectRepository(AttendanceLog)
    private readonly attendanceLogRepo: Repository<AttendanceLog>,
    private readonly applicationsService: OpportunityApplicationsService,
  ) {}

  private async loadUser(studentUserId: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: studentUserId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private approverLabel(type: 'faculty' | 'partner'): string {
    return type === 'partner'
      ? 'NGO / partner organisation verifies attendance'
      : 'Faculty supervisor verifies attendance';
  }

  private enrichGuide(
    guide: Omit<
      ParticipationGuideResult,
      'participation_phase' | 'participation_phase_label'
    >,
    context: {
      participation?: Participation | null;
      opportunity: Opportunity;
      reportStatus?: string | null;
      approvedHours?: number;
      requiredHours?: number;
    },
  ): ParticipationGuideResult {
    const approverType = resolveEffectiveAttendanceApproverType(
      context.participation?.attendanceApproverType,
      context.opportunity,
    );
    const phase = resolveParticipationPhase({
      guideRole: guide.your_role,
      participationMode: context.participation?.participationMode,
      isTeamLead: context.participation?.isTeamLead,
      emailVerified: context.participation?.emailVerified,
      attendanceVerificationPending:
        context.participation?.attendanceVerificationRequested === true &&
        !context.participation?.adminAttendanceEditable,
      approverType,
      approvedHours: context.approvedHours,
      requiredHours: context.requiredHours,
      reportStatus: context.reportStatus,
    });
    return {
      ...guide,
      participation_phase: phase,
      participation_phase_label: participationPhaseLabel(phase),
    };
  }

  private async resolveReportStatusForParticipation(
    studentUserId: string,
    projectId: string,
    participation: Participation,
  ): Promise<string | null> {
    const isMember =
      participation.participationMode === 'team' &&
      participation.isTeamLead !== true;
    let reportStudentId = studentUserId;
    if (isMember) {
      const lead = await findCanonicalTeamLeadParticipation(
        this.participationRepo,
        projectId,
        {
          teamId: participation.teamId,
          applicationId: participation.applicationId,
        },
      );
      if (!lead?.studentId) return null;
      reportStudentId = lead.studentId;
    }
    const report = await this.reportRepo.findOne({
      where: [
        { studentId: reportStudentId, opportunityId: projectId },
        { studentId: reportStudentId, project_id: projectId },
      ],
      order: { updatedAt: 'DESC' },
    });
    return report?.status ?? null;
  }

  async getParticipationGuide(
    studentUserId: string,
    opportunityId: string,
    options?: { reportStatus?: string | null },
  ): Promise<ParticipationGuideResult> {
    const user = await this.loadUser(studentUserId);
    const email = normEmail(user.email);
    const opportunity = await this.opportunityRepo.findOne({
      where: { id: opportunityId },
    });
    if (!opportunity) throw new NotFoundException('Opportunity not found');

    const approverType = resolveEffectiveAttendanceApproverType(
      null,
      opportunity,
    );
    const approverLabel = this.approverLabel(approverType);

    const mine = await this.participationRepo.findOne({
      where: { studentId: studentUserId, projectId: opportunityId },
      relations: ['student'],
    });
    const reportStatus =
      options?.reportStatus !== undefined
        ? options.reportStatus
        : mine
          ? await this.resolveReportStatusForParticipation(
              studentUserId,
              opportunityId,
              mine,
            )
          : null;

    if (mine?.isTeamLead) {
      return this.enrichGuide(
        {
          your_role: 'team_lead',
          recommended_action: 'open_team_report',
          can_apply: false,
          can_apply_as_team_lead: false,
          team_lead_name: personName(mine),
          team_display_name:
            mine.teamDisplayName || buildTeamDisplayName(opportunity, mine),
          attendance_approver_type: approverType,
          attendance_approver_label: approverLabel,
          messages: {
            en: 'You are the team lead. Continue your team report and add members in Section 1 if needed.',
            ur: 'You are the team lead. Continue your team report and add members in Section 1 if needed.',
          },
        },
        { participation: mine, opportunity, reportStatus },
      );
    }

    if (mine?.participationMode === 'team') {
      const lead = await findCanonicalTeamLeadParticipation(
        this.participationRepo,
        opportunityId,
        {
          teamId: mine.teamId,
          applicationId: mine.applicationId,
        },
      );
      return this.enrichGuide(
        {
          your_role: 'team_member',
          recommended_action: 'open_my_participation',
          can_apply: false,
          can_apply_as_team_lead: false,
          team_lead_name: personName(lead),
          team_display_name:
            mine.teamDisplayName ||
            (lead ? buildTeamDisplayName(opportunity, lead) : null),
          attendance_approver_type: resolveEffectiveAttendanceApproverType(
            mine.attendanceApproverType,
            opportunity,
          ),
          attendance_approver_label: approverLabel,
          messages: {
            en: 'You are on a team project. Do not apply separately — update your attendance only; your team lead files the report.',
            ur: 'You are on a team project. Do not apply separately — update your attendance only; your team lead files the report.',
          },
        },
        { participation: mine, opportunity, reportStatus },
      );
    }

    if (mine) {
      return this.enrichGuide(
        {
          your_role: 'individual_owner',
          recommended_action: 'open_own_report',
          can_apply: false,
          can_apply_as_team_lead: false,
          team_lead_name: null,
          team_display_name: null,
          attendance_approver_type: resolveEffectiveAttendanceApproverType(
            mine.attendanceApproverType,
            opportunity,
          ),
          attendance_approver_label: approverLabel,
          messages: {
            en: 'You are enrolled individually. Continue your report, or add teammates later in Section 1.',
            ur: 'You are enrolled individually. Continue your report, or add teammates later in Section 1.',
          },
        },
        { participation: mine, opportunity, reportStatus },
      );
    }

    if (
      await this.applicationsService.hasOpenPipelineApplication(
        studentUserId,
        opportunityId,
      )
    ) {
      return this.enrichGuide(
        {
          your_role: 'pending_application',
          recommended_action: 'wait_for_lead',
          can_apply: false,
          can_apply_as_team_lead: false,
          team_lead_name: null,
          team_display_name: null,
          attendance_approver_type: approverType,
          attendance_approver_label: approverLabel,
          messages: {
            en: 'Your application is pending approval.',
            ur: 'Your application is pending approval.',
          },
        },
        { participation: null, opportunity },
      );
    }

    const claimed =
      await this.applicationsService.collectClaimedEmailsOnOpenApplications(
        opportunityId,
      );
    if (email && claimed.has(email)) {
      return this.enrichGuide(
        {
          your_role: 'none',
          recommended_action: 'wait_for_lead',
          can_apply: false,
          can_apply_as_team_lead: false,
          team_lead_name: null,
          team_display_name: null,
          attendance_approver_type: approverType,
          attendance_approver_label: approverLabel,
          messages: {
            en: 'You are listed on another open application for this project. Wait for your team lead or withdraw first.',
            ur: 'You are listed on another open application for this project. Wait for your team lead or withdraw first.',
          },
        },
        { participation: null, opportunity },
      );
    }

    return this.enrichGuide(
      {
        your_role: 'none',
        recommended_action: 'apply_individual',
        can_apply: true,
        can_apply_as_team_lead: true,
        team_lead_name: null,
        team_display_name: null,
        attendance_approver_type: approverType,
        attendance_approver_label: approverLabel,
        messages: {
          en: 'Joining a teammate who already started? Do not apply — ask them to add you in Section 1. Your own work? Apply as Individual.',
          ur: 'Joining a teammate who already started? Do not apply — ask them to add you in Section 1. Your own work? Apply as Individual.',
        },
      },
      { participation: null, opportunity },
    );
  }

  async getMyParticipation(studentUserId: string, projectId: string) {
    const opportunity = await this.opportunityRepo.findOne({
      where: { id: projectId },
    });
    if (!opportunity) throw new NotFoundException('Project not found');

    const mine = await this.participationRepo.findOne({
      where: { studentId: studentUserId, projectId },
      relations: ['student'],
    });
    if (!mine)
      throw new NotFoundException('You are not enrolled on this project');

    const reportStatus = await this.resolveReportStatusForParticipation(
      studentUserId,
      projectId,
      mine,
    );
    const guide = await this.getParticipationGuide(studentUserId, projectId, {
      reportStatus,
    });
    const isLead = mine.isTeamLead === true;
    const isMember = mine.participationMode === 'team' && !isLead;

    const logs = await this.attendanceLogRepo.find({
      where: { participantId: mine.id },
      order: { dateOfEngagement: 'DESC' },
    });
    const approvedHours = logs
      .filter((l) => attendanceCountsTowardProgress(l))
      .reduce((sum, l) => sum + (Number(l.sessionHours) || 0), 0);
    const loggedHours = logs.reduce(
      (sum, l) => sum + (Number(l.sessionHours) || 0),
      0,
    );

    const teamReportStatus = isMember ? reportStatus : null;
    const ownReportStatus = !isMember ? reportStatus : null;

    const requiredHours =
      Number(opportunity.timeline?.expected_hours) ||
      Number(opportunity.requiredHours) ||
      16;

    const teamPeers =
      mine.participationMode === 'team'
        ? await this.participationRepo.find({ where: { projectId } })
        : [mine];
    const effectiveParticipation =
      resolveParticipationForAttendanceUnlock(mine, teamPeers) ?? mine;
    const adminUnlocked = effectiveParticipation.adminAttendanceEditable === true;

    const verificationPending =
      mine.attendanceVerificationRequested === true && !adminUnlocked;

    let participation_state:
      | 'verify'
      | 'log_attendance'
      | 'pending_approval'
      | 'complete' = 'log_attendance';
    if (!mine.emailVerified) participation_state = 'verify';
    else if (verificationPending) participation_state = 'pending_approval';
    else if (approvedHours >= requiredHours) participation_state = 'complete';

    const reportStatusForPhase = isMember ? teamReportStatus : ownReportStatus;
    const phase =
      guide.participation_phase ??
      resolveParticipationPhase({
        guideRole: guide.your_role,
        participationMode: mine.participationMode,
        isTeamLead: isLead,
        emailVerified: mine.emailVerified,
        attendanceVerificationPending: verificationPending,
        approverType: guide.attendance_approver_type,
        approvedHours,
        requiredHours,
        reportStatus: reportStatusForPhase,
      });

    return {
      success: true,
      data: {
        project_id: projectId,
        project_title: opportunity.title,
        your_role: guide.your_role,
        is_team_lead: isLead,
        is_team_member: isMember,
        team_display_name: guide.team_display_name,
        team_lead_name: guide.team_lead_name,
        attendance_approver_type: guide.attendance_approver_type,
        attendance_approver_label: guide.attendance_approver_label,
        participation_phase: phase,
        participation_phase_label: participationPhaseLabel(phase),
        participation_state,
        hours: {
          required: requiredHours,
          logged: loggedHours,
          approved: approvedHours,
        },
        attendance_locked:
          (mine.attendanceLocked === true && !adminUnlocked) || verificationPending,
        team_report_status: teamReportStatus,
        recommended_action: guide.recommended_action,
        messages: guide.messages,
        participation_id: mine.id,
      },
    };
  }
}

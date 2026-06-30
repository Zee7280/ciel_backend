export type ParticipationGuideRole =
  | 'none'
  | 'pending_application'
  | 'individual_owner'
  | 'team_lead'
  | 'team_member';

export type ParticipationPhase =
  | 'not_applied'
  | 'application_pending'
  | 'enrolled_individual'
  | 'team_formed_lead'
  | 'team_member_pending_verification'
  | 'team_member_active'
  | 'attendance_pending_partner'
  | 'attendance_pending_faculty'
  | 'report_in_progress'
  | 'report_submitted'
  | 'verified';

const VERIFIED_REPORT_STATUSES = new Set(['verified', 'paid', 'finalized']);
const SUBMITTED_REPORT_STATUSES = new Set([
  'submitted',
  'payment_pending',
  'payment_under_review',
  'partner_verified',
]);
const DRAFTISH_REPORT_STATUSES = new Set([
  'draft',
  'continue',
  'revision',
  'rejected',
  '',
]);

function normalizeReportStatus(status: string | null | undefined): string {
  return String(status || '')
    .trim()
    .toLowerCase();
}

export function resolveParticipationPhase(input: {
  guideRole: ParticipationGuideRole;
  participationMode?: string | null;
  isTeamLead?: boolean;
  emailVerified?: boolean;
  attendanceVerificationPending?: boolean;
  approverType?: 'partner' | 'faculty';
  approvedHours?: number;
  requiredHours?: number;
  reportStatus?: string | null;
}): ParticipationPhase {
  const reportSt = normalizeReportStatus(input.reportStatus);
  if (VERIFIED_REPORT_STATUSES.has(reportSt)) {
    return 'verified';
  }
  if (SUBMITTED_REPORT_STATUSES.has(reportSt)) {
    return 'report_submitted';
  }

  if (input.guideRole === 'none') {
    return 'not_applied';
  }
  if (input.guideRole === 'pending_application') {
    return 'application_pending';
  }

  if (input.attendanceVerificationPending) {
    return input.approverType === 'partner'
      ? 'attendance_pending_partner'
      : 'attendance_pending_faculty';
  }

  if (input.guideRole === 'team_member') {
    if (!input.emailVerified) {
      return 'team_member_pending_verification';
    }
    return 'team_member_active';
  }

  if (input.guideRole === 'team_lead') {
    if (reportSt && !DRAFTISH_REPORT_STATUSES.has(reportSt)) {
      return 'report_submitted';
    }
    if (input.participationMode === 'team' || input.isTeamLead) {
      return 'team_formed_lead';
    }
    return 'report_in_progress';
  }

  if (input.guideRole === 'individual_owner') {
    if (reportSt && !DRAFTISH_REPORT_STATUSES.has(reportSt)) {
      return 'report_submitted';
    }
    if (
      reportSt === 'draft' ||
      reportSt === 'continue' ||
      reportSt === 'revision'
    ) {
      return 'report_in_progress';
    }
    return 'enrolled_individual';
  }

  return 'not_applied';
}

export function participationPhaseLabel(phase: ParticipationPhase): string {
  const labels: Record<ParticipationPhase, string> = {
    not_applied: 'Not applied',
    application_pending: 'Application pending',
    enrolled_individual: 'Enrolled · individual',
    team_formed_lead: 'Team lead',
    team_member_pending_verification: 'Verify email',
    team_member_active: 'Team member · attendance',
    attendance_pending_partner: 'Partner reviewing attendance',
    attendance_pending_faculty: 'Faculty reviewing attendance',
    report_in_progress: 'Report in progress',
    report_submitted: 'Report submitted',
    verified: 'Verified',
  };
  return labels[phase] ?? phase;
}

export function participationPhaseTone(
  phase: ParticipationPhase,
): 'neutral' | 'warning' | 'success' | 'info' {
  if (phase === 'verified' || phase === 'team_member_active') return 'success';
  if (
    phase === 'attendance_pending_partner' ||
    phase === 'attendance_pending_faculty' ||
    phase === 'application_pending' ||
    phase === 'team_member_pending_verification'
  ) {
    return 'warning';
  }
  if (phase === 'report_submitted' || phase === 'team_formed_lead')
    return 'info';
  return 'neutral';
}

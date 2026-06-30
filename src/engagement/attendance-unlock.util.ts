import { Participation } from './entities/participant.entity';
import { User } from '../users/entities/user.entity';

export type AttendanceUnlockStatus = {
  unlocked: boolean;
  status: 'Unlocked' | 'Locked';
  missing: string[];
  admin_override?: boolean;
};

export function resolveIdentityVerificationStatus(
  user: User | null | undefined,
  participation: Participation | null | undefined,
): 'verified' | 'pending' | 'failed' {
  const cnicOk = Boolean(user?.cnic?.trim() || participation?.cnicHash);
  const mobileOk = participation?.mobileVerified === true;
  const emailOk = participation?.emailVerified === true;
  const profileOk =
    user?.profile_verified === true && user?.identity_verified === true;
  if (cnicOk && mobileOk && emailOk && profileOk) return 'verified';
  if (!cnicOk && !mobileOk && !emailOk) return 'failed';
  return 'pending';
}

export function computeAcademicCompletionPercent(
  participation: Participation | null | undefined,
  user: User | null | undefined,
): number {
  if (!participation) return 0;
  const checks = [
    Boolean(
      participation.universityName || user?.university || user?.institution,
    ),
    Boolean(participation.academicProgram || user?.major),
    Boolean(participation.yearOfStudy),
    Boolean(participation.academicIntegrationType),
    Boolean(participation.department || user?.department),
  ];
  const completed = checks.filter(Boolean).length;
  return Math.round((completed / checks.length) * 100);
}

export function isTeamConfigurationComplete(members: Participation[]): boolean {
  return (
    members.length > 0 &&
    (members[0].participationMode !== 'team' || members.length > 1)
  );
}

/** Teammates inherit team lead admin override when grouped on the same application/team. */
export function resolveParticipationForAttendanceUnlock(
  participation: Participation | null | undefined,
  teamMembers: Participation[] = [],
): Participation | null | undefined {
  if (!participation || participation.adminAttendanceEditable === true) {
    return participation;
  }
  if (participation.participationMode !== 'team' || participation.isTeamLead) {
    return participation;
  }

  const teamLeadOverride = teamMembers.find((member) => {
    if (!member.isTeamLead || member.adminAttendanceEditable !== true)
      return false;
    if (participation.teamId && member.teamId) {
      return participation.teamId === member.teamId;
    }
    if (participation.applicationId && member.applicationId) {
      return participation.applicationId === member.applicationId;
    }
    return false;
  });

  if (!teamLeadOverride) return participation;
  return { ...participation, adminAttendanceEditable: true };
}

export function resolveAttendanceUnlockStatus(
  user: User | null | undefined,
  participation: Participation | null | undefined,
  teamConfigured: boolean,
): AttendanceUnlockStatus {
  if (participation?.adminAttendanceEditable === true) {
    return {
      unlocked: true,
      status: 'Unlocked',
      missing: [],
      admin_override: true,
    };
  }

  const identityOk =
    resolveIdentityVerificationStatus(user, participation) === 'verified';
  const academicOk =
    computeAcademicCompletionPercent(participation, user) >= 80;
  const teamOk = participation?.participationMode !== 'team' || teamConfigured;
  const unlocked =
    identityOk &&
    academicOk &&
    teamOk &&
    participation?.attendanceLocked !== true;

  return {
    unlocked,
    status: unlocked ? 'Unlocked' : 'Locked',
    missing: [
      !identityOk ? 'identity_verification' : null,
      !academicOk ? 'academic_info' : null,
      !teamOk ? 'team_setup' : null,
      participation?.attendanceLocked ? 'attendance_locked' : null,
    ].filter((value): value is string => Boolean(value)),
  };
}

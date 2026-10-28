/**
 * Faculty supervision before an impact report starts.
 *
 * Joining an opportunity no longer waits for faculty (CIEL PK admin approves the seat), so the
 * named primary faculty supervisor confirms the student before a NEW report can start. Exempt:
 * student-created opportunities (their faculty already approved the opportunity), a supervisor
 * who is the opportunity's own faculty, and seats with no faculty named (legacy rows).
 */

const norm = (v: unknown): string =>
  typeof v === 'string' ? v.trim().toLowerCase() : '';

export type SupervisionSeatLike = {
  primaryFacultyEmail?: string | null;
  facultySupervisorEmail?: string | null;
};

export function namedSupervisorEmail(
  seat: SupervisionSeatLike | null | undefined,
): string {
  return (
    norm(seat?.primaryFacultyEmail) || norm(seat?.facultySupervisorEmail) || ''
  );
}

/** Emails of faculty already attached to the opportunity itself. */
export function opportunitySupervisorEmails(
  opp: { supervision?: unknown } | null | undefined,
  facultyUserEmail?: string | null,
): string[] {
  const sup =
    opp?.supervision && typeof opp.supervision === 'object'
      ? (opp.supervision as Record<string, unknown>)
      : {};
  return [
    norm(facultyUserEmail),
    norm(sup.contact),
    norm(sup.official_email),
    norm(sup.supervisor_email),
    norm(sup.faculty_email),
  ].filter(Boolean);
}

export function supervisionRequiredForReport(input: {
  isStudentCreated: boolean;
  namedEmail: string;
  opportunityFacultyEmails: string[];
}): boolean {
  if (input.isStudentCreated) return false;
  if (!input.namedEmail) return false;
  return !input.opportunityFacultyEmails.includes(input.namedEmail);
}

/** Supervision-request emails go out at most this often per seat. */
export const SUPERVISION_REQUEST_RESEND_MS = 12 * 60 * 60 * 1000;

export const FACULTY_SUPERVISION_PENDING = 'faculty_supervision_pending';

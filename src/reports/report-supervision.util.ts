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

export type OpportunityFacultyLike = {
  supervision?: unknown;
  visibility_and_academic_linkage?: unknown;
};

/**
 * The faculty representative an NGO / university names on its listing
 * (`visibility_and_academic_linkage.faculty_institutional_representative.official_email`), normalised.
 */
export function facultyRepresentativeEmail(
  opp: OpportunityFacultyLike | null | undefined,
): string {
  const val =
    opp?.visibility_and_academic_linkage &&
    typeof opp.visibility_and_academic_linkage === 'object'
      ? (opp.visibility_and_academic_linkage as Record<string, unknown>)
      : null;
  const fir =
    val?.faculty_institutional_representative &&
    typeof val.faculty_institutional_representative === 'object'
      ? (val.faculty_institutional_representative as Record<string, unknown>)
      : null;
  return norm(fir?.official_email);
}

/** Emails of faculty already attached to the opportunity itself. */
export function opportunitySupervisorEmails(
  opp: OpportunityFacultyLike | null | undefined,
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
    facultyRepresentativeEmail(opp),
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

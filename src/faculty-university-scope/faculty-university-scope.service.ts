import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets, In, IsNull } from 'typeorm';
import { FacultyUniversityScopeAssignment } from './entities/faculty-university-scope-assignment.entity';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import {
  universityNameMatchSql,
  universityNamesMatch,
} from '../opportunities/university-scope.util';
import {
  facultyMayRepresentUniversity,
  isAffiliatedWithUniversity,
  isListedUniversityName,
  type UniversityOrgRef,
} from './university-affiliation.util';

/** Everything a university organization's views are scoped to, resolved once per request. */
export type UniversityScope = {
  org: UniversityOrgRef;
  /** Students of this university ({@link isAffiliatedWithUniversity}). */
  studentIds: Set<string>;
  /** Opportunities the university dashboard lists. */
  opportunityIds: Set<string>;
  /** Owned by the university, or published by one of its authorised faculty: every report counts. */
  institutionalOpportunityIds: Set<string>;
  /** `projectId|t:teamId` and `projectId|a:applicationId` of the university's students' seats. */
  affiliatedTeamKeys: Set<string>;
};

/** Report fields the university scope check reads. */
export type UniversityScopedReport = {
  studentId?: string | null;
  opportunityId?: string | null;
  project_id?: string | null;
};

/** Keeps `IN (...)` lists well under the Postgres bind-parameter limit. */
const ID_CHUNK = 5000;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) {
    out.push(items.slice(i, i + ID_CHUNK));
  }
  return out;
}

@Injectable()
export class FacultyUniversityScopeService {
  constructor(
    @InjectRepository(FacultyUniversityScopeAssignment)
    private readonly assignmentRepo: Repository<FacultyUniversityScopeAssignment>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(Participation)
    private readonly participationRepo: Repository<Participation>,
    @InjectRepository(OpportunityApplication)
    private readonly applicationRepo: Repository<OpportunityApplication>,
    @InjectRepository(Opportunity)
    private readonly opportunityRepo: Repository<Opportunity>,
    @InjectRepository(StudentReport)
    private readonly reportRepo: Repository<StudentReport>,
  ) {}

  /** Only reads orgType, so it accepts any org-shaped object — including the sensitive-field-filtered
   * shape OrganizationsService.getMyOrganization() returns (verifiedBy/verificationNotes/isBlocked
   * stripped for privacy), which callers like Opportunities/Partners pass in without the full entity. */
  isUniversityOrganization(org: Pick<Organization, 'orgType'>): boolean {
    return String(org.orgType || '')
      .trim()
      .toLowerCase()
      .includes('university');
  }

  normalizeOrgName(name: string): string {
    return (name || '').trim().toLowerCase();
  }

  async getAssignmentForFaculty(
    facultyUserId: string,
  ): Promise<FacultyUniversityScopeAssignment | null> {
    return this.assignmentRepo.findOne({
      where: { facultyUser: { id: facultyUserId } },
      relations: ['universityOrganization', 'facultyUser'],
    });
  }

  async getDelegatedOrganizationId(
    facultyUserId: string,
  ): Promise<string | null> {
    const row = await this.assignmentRepo.findOne({
      where: { facultyUser: { id: facultyUserId } },
      select: { id: true },
      relations: ['universityOrganization'],
    });
    return row?.universityOrganization?.id ?? null;
  }

  /**
   * Students whose profile university/institution names this organization — by the same
   * spelling-tolerant rule as apply eligibility ({@link universityNamesMatch}: "BNU" and
   * "Beaconhouse  National University (BNU)" both name "Beaconhouse National University (BNU)").
   */
  studentProfileMatchesOrganization(
    student: User | null | undefined,
    orgName: string,
  ): boolean {
    if (!student || student.role !== UserRole.STUDENT || !orgName) return false;
    return (
      universityNamesMatch(student.university, orgName) ||
      universityNamesMatch(student.institution, orgName)
    );
  }

  /** SQL twin of {@link studentProfileMatchesOrganization} for the user aliased `alias`. */
  studentProfileMatchesOrganizationSql(
    alias: string,
    orgName: string,
    paramPrefix: string,
  ): { sql: string; params: Record<string, string | string[]> } {
    const uni = universityNameMatchSql(
      `${alias}.university`,
      orgName,
      `${paramPrefix}U`,
    );
    const inst = universityNameMatchSql(
      `${alias}.institution`,
      orgName,
      `${paramPrefix}I`,
    );
    return {
      sql: `(${uni.sql} OR ${inst.sql})`,
      params: { ...uni.params, ...inst.params },
    };
  }

  /**
   * A student of this university: the profile names it, or the account is linked to the
   * organization itself — the two student-identity sources the delegated-faculty views use.
   */
  async studentBelongsToOrganization(
    student: User | null | undefined,
    org: Pick<Organization, 'id' | 'name'>,
  ): Promise<boolean> {
    if (!student?.id || student.role !== UserRole.STUDENT) return false;
    const ref = { id: org.id, name: org.name };
    if (
      isAffiliatedWithUniversity(
        {
          organizationId: student.organization?.id,
          university: student.university,
          institution: student.institution,
        },
        ref,
      )
    ) {
      return true;
    }
    if (student.organization?.id) return false;
    const linked = await this.usersRepo.count({
      where: { id: student.id, organization: { id: org.id } },
    });
    if (linked > 0) return true;
    // A blank / free-text profile: the university the student entered on a project seat counts.
    if (
      [student.university, student.institution].some((name) =>
        isListedUniversityName(name),
      )
    ) {
      return false;
    }
    const seats = await this.participationRepo.find({
      where: { studentId: student.id },
      select: ['id', 'universityName', 'universityId'],
    });
    return isAffiliatedWithUniversity(
      {
        university: student.university,
        institution: student.institution,
        claims: seats.map((seat) => seat.universityName),
        claimedOrganizationIds: seats.map((seat) => seat.universityId),
      },
      ref,
    );
  }

  /**
   * Students of this university: account linked to it or profile naming it, plus students whose
   * blank / free-text profile is completed by a project seat naming it. One rule for every view.
   */
  async resolveAffiliatedStudentIds(
    org: UniversityOrgRef,
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!org?.id || !org.name) return ids;
    const profile = this.studentProfileMatchesOrganizationSql(
      'u',
      org.name,
      'affilProfile',
    );
    const direct = await this.usersRepo
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .where('u.role = :sr', { sr: UserRole.STUDENT })
      .andWhere(
        new Brackets((b) => {
          b.where('u."organizationId"::text = :orgId', {
            orgId: org.id,
          }).orWhere(profile.sql, profile.params);
        }),
      )
      .getRawMany<{ id: string }>();
    for (const row of direct) if (row.id) ids.add(row.id);

    const enrollment = universityNameMatchSql(
      'p.universityName',
      org.name,
      'affilEnroll',
    );
    const claimed = await this.participationRepo
      .createQueryBuilder('p')
      .innerJoin('p.student', 'u')
      .select('u.id', 'id')
      .addSelect('u.university', 'university')
      .addSelect('u.institution', 'institution')
      .addSelect('u."organizationId"', 'organizationId')
      .addSelect('p.universityName', 'universityName')
      .addSelect('p.universityId', 'universityId')
      .where('u.role = :sr', { sr: UserRole.STUDENT })
      .andWhere(
        new Brackets((b) => {
          b.where(`TRIM(COALESCE(p.universityId, '')) = :orgId`, {
            orgId: org.id,
          }).orWhere(enrollment.sql, enrollment.params);
        }),
      )
      .getRawMany<{
        id: string;
        university: string | null;
        institution: string | null;
        universityName: string | null;
        universityId: string | null;
        organizationId: string | null;
      }>();
    for (const row of claimed) {
      if (!row.id || ids.has(row.id)) continue;
      // Linked to another organization: that link decides (same as studentBelongsToOrganization).
      if (row.organizationId && row.organizationId !== org.id) continue;
      if (
        isAffiliatedWithUniversity(
          {
            university: row.university,
            institution: row.institution,
            claims: [row.universityName],
            claimedOrganizationIds: [row.universityId],
          },
          org,
        )
      ) {
        ids.add(row.id);
      }
    }
    return ids;
  }

  /**
   * The full university scope: its students, every opportunity they take part in / applied to /
   * created / reported on, opportunities the university owns, and opportunities its authorised faculty publish.
   */
  async resolveUniversityScope(
    universityOrganizationId: string,
  ): Promise<UniversityScope | null> {
    if (!universityOrganizationId) return null;
    const org = await this.orgRepo.findOne({
      where: { id: universityOrganizationId },
    });
    if (!org) return null;
    const ref: UniversityOrgRef = { id: org.id, name: org.name };
    const studentIds = await this.resolveAffiliatedStudentIds(ref);
    const students = [...studentIds];

    const opportunityIds = new Set<string>();
    const institutionalOpportunityIds = new Set<string>();
    const affiliatedTeamKeys = new Set<string>();

    const owned = await this.opportunityRepo.find({
      where: { organizationId: org.id },
      select: ['id'],
    });
    for (const row of owned) {
      opportunityIds.add(row.id);
      institutionalOpportunityIds.add(row.id);
    }

    const delegatedFacultyIds = (
      await this.assignmentRepo.find({
        where: { universityOrganization: { id: org.id } },
        relations: ['facultyUser'],
      })
    )
      .map((row) => row.facultyUser?.id)
      .filter((id): id is string => !!id);
    for (const part of chunks(delegatedFacultyIds)) {
      const published = await this.opportunityRepo.find({
        where: { creatorId: In(part) },
        select: ['id'],
      });
      for (const row of published) {
        opportunityIds.add(row.id);
        institutionalOpportunityIds.add(row.id);
      }
    }

    for (const part of chunks(students)) {
      const seats = await this.participationRepo.find({
        where: { studentId: In(part) },
        select: ['id', 'projectId', 'teamId', 'applicationId'],
      });
      for (const seat of seats) {
        if (!seat.projectId) continue;
        opportunityIds.add(seat.projectId);
        if (seat.teamId) {
          affiliatedTeamKeys.add(`${seat.projectId}|t:${seat.teamId}`);
        }
        if (seat.applicationId) {
          affiliatedTeamKeys.add(`${seat.projectId}|a:${seat.applicationId}`);
        }
      }
      const applications = await this.applicationRepo.find({
        where: { studentUserId: In(part), withdrawnAt: IsNull() },
        select: ['id', 'opportunityId'],
      });
      for (const app of applications) {
        if (app.opportunityId) opportunityIds.add(app.opportunityId);
      }
      const created = await this.opportunityRepo.find({
        where: { creatorId: In(part) },
        select: ['id'],
      });
      for (const row of created) opportunityIds.add(row.id);
      // A report can outlive (or predate) its seat; the student's own report still counts.
      const reports = await this.reportRepo.find({
        where: { studentId: In(part) },
        select: ['id', 'opportunityId', 'project_id'],
      });
      for (const report of reports) {
        const pid = report.opportunityId || report.project_id;
        if (pid) opportunityIds.add(pid);
      }
    }

    return {
      org: ref,
      studentIds,
      opportunityIds,
      institutionalOpportunityIds,
      affiliatedTeamKeys,
    };
  }

  /**
   * Reports a university may see: any report on its own / its faculty's opportunities, and on
   * other opportunities only its own students' reports (or a team report with one of its students
   * on the team) — never the reports of other universities' students who shared the listing.
   */
  async filterReportsToUniversityScope<T extends UniversityScopedReport>(
    scope: UniversityScope,
    reports: T[],
  ): Promise<T[]> {
    const projectOf = (r: T) => String(r.opportunityId || r.project_id || '');
    const undecided = reports.filter((r) => {
      const pid = projectOf(r);
      return (
        !!pid &&
        scope.opportunityIds.has(pid) &&
        !scope.institutionalOpportunityIds.has(pid) &&
        !scope.studentIds.has(String(r.studentId || ''))
      );
    });
    const teamKeysByOwnerProject = new Map<string, string[]>();
    const owners = [
      ...new Set(undecided.map((r) => String(r.studentId || ''))),
    ].filter(Boolean);
    if (owners.length && scope.affiliatedTeamKeys.size) {
      for (const part of chunks(owners)) {
        const seats = await this.participationRepo.find({
          where: { studentId: In(part) },
          select: ['id', 'studentId', 'projectId', 'teamId', 'applicationId'],
        });
        for (const seat of seats) {
          const key = `${seat.studentId}|${seat.projectId}`;
          const list = teamKeysByOwnerProject.get(key) ?? [];
          if (seat.teamId) list.push(`${seat.projectId}|t:${seat.teamId}`);
          if (seat.applicationId) {
            list.push(`${seat.projectId}|a:${seat.applicationId}`);
          }
          teamKeysByOwnerProject.set(key, list);
        }
      }
    }
    return reports.filter((r) => {
      const pid = projectOf(r);
      if (!pid || !scope.opportunityIds.has(pid)) return false;
      if (scope.institutionalOpportunityIds.has(pid)) return true;
      const owner = String(r.studentId || '');
      if (scope.studentIds.has(owner)) return true;
      return (teamKeysByOwnerProject.get(`${owner}|${pid}`) ?? []).some((key) =>
        scope.affiliatedTeamKeys.has(key),
      );
    });
  }

  /**
   * SQL for "this participation (seat) belongs to the university": its student is the
   * university's, or the seat is on an opportunity the university owns / its faculty published.
   * `null` when the scope is empty (nothing matches).
   */
  participationInScopeSql(
    scope: UniversityScope,
    alias: string,
  ): { sql: string; params: Record<string, string[]> } | null {
    const studentIds = [...scope.studentIds];
    const projectIds = [...scope.institutionalOpportunityIds];
    const parts: string[] = [];
    const params: Record<string, string[]> = {};
    if (studentIds.length) {
      parts.push(`${alias}.student_id::text = ANY(:scopeStudentIds)`);
      params.scopeStudentIds = studentIds;
    }
    if (projectIds.length) {
      parts.push(`${alias}.project_id::text = ANY(:scopeProjectIds)`);
      params.scopeProjectIds = projectIds;
    }
    return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : null;
  }

  /**
   * What a university login may read on the reports side: the opportunity ids its dashboard lists,
   * plus the report filter that keeps other universities' students out of shared listings.
   */
  async universityReportAccess(universityOrganizationId: string): Promise<{
    opportunityIds: string[];
    /** The university's own students (see {@link resolveAffiliatedStudentIds}). */
    studentIds: Set<string>;
    /** Owned by the university or published by its authorised faculty: every seat / report counts. */
    institutionalOpportunityIds: Set<string>;
    restrictTo: <T extends UniversityScopedReport>(rows: T[]) => Promise<T[]>;
    includes: (report: UniversityScopedReport) => Promise<boolean>;
  }> {
    const scope = await this.resolveUniversityScope(universityOrganizationId);
    if (!scope) {
      return {
        opportunityIds: [],
        studentIds: new Set(),
        institutionalOpportunityIds: new Set(),
        restrictTo: () => Promise.resolve([]),
        includes: () => Promise.resolve(false),
      };
    }
    return {
      opportunityIds: [...scope.opportunityIds],
      studentIds: scope.studentIds,
      institutionalOpportunityIds: scope.institutionalOpportunityIds,
      restrictTo: (rows) => this.filterReportsToUniversityScope(scope, rows),
      includes: (report) => this.reportInUniversityScope(scope, report),
    };
  }

  async reportInUniversityScope(
    scope: UniversityScope,
    report: UniversityScopedReport,
  ): Promise<boolean> {
    return (
      (await this.filterReportsToUniversityScope(scope, [report])).length > 0
    );
  }

  /**
   * Faculty whose profile names this university and who are not authorised for any university
   * yet — the University's "awaiting authorisation" list.
   */
  async listFacultyAwaitingAuthorisation(
    universityOrganizationId: string,
  ): Promise<User[]> {
    const org = await this.orgRepo.findOne({
      where: { id: universityOrganizationId },
    });
    if (!org) return [];
    const uni = universityNameMatchSql('u.university', org.name, 'awaitU');
    const inst = universityNameMatchSql('u.institution', org.name, 'awaitI');
    return this.usersRepo
      .createQueryBuilder('u')
      .where('u.role = :fr', { fr: UserRole.FACULTY })
      .andWhere('u.status IN (:...st)', { st: ['active', 'approved'] })
      .andWhere(`(${uni.sql} OR ${inst.sql})`, {
        ...uni.params,
        ...inst.params,
      })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM faculty_university_scope_assignments a WHERE a.faculty_user_id = u.id)`,
      )
      .orderBy('u.name', 'ASC')
      .limit(200)
      .getMany();
  }

  /**
   * Opportunity IDs a university organization (and its delegated faculty) sees — see
   * {@link resolveUniversityScope}.
   */
  async resolveOpportunityIdsForUniversityOrganization(
    universityOrganizationId: string,
  ): Promise<string[]> {
    const scope = await this.resolveUniversityScope(universityOrganizationId);
    return scope ? [...scope.opportunityIds] : [];
  }

  async assign(params: {
    facultyUserId: string;
    universityOrganizationId: string;
    assignedByAdminId: string;
  }): Promise<FacultyUniversityScopeAssignment> {
    const faculty = await this.usersRepo.findOne({
      where: { id: params.facultyUserId },
    });
    if (!faculty || faculty.role !== UserRole.FACULTY) {
      throw new BadRequestException(
        'Target user must be an independent faculty account',
      );
    }

    const org = await this.orgRepo.findOne({
      where: { id: params.universityOrganizationId },
    });
    if (!org) {
      throw new NotFoundException('University organization not found');
    }
    if (!this.isUniversityOrganization(org)) {
      throw new BadRequestException(
        'Organization must be a university-type organization',
      );
    }

    const admin = await this.usersRepo.findOne({
      where: { id: params.assignedByAdminId },
    });
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only platform admins can assign university scope',
      );
    }

    const existing = await this.assignmentRepo.findOne({
      where: { facultyUser: { id: faculty.id } },
      relations: ['facultyUser', 'universityOrganization', 'assignedByAdmin'],
    });

    if (existing) {
      existing.universityOrganization = org;
      existing.assignedByAdmin = admin;
      return this.assignmentRepo.save(existing);
    }

    const created = this.assignmentRepo.create({
      facultyUser: faculty,
      universityOrganization: org,
      assignedByAdmin: admin,
    });
    return this.assignmentRepo.save(created);
  }

  async assignByUniversityOperator(params: {
    facultyEmail: string;
    universityOrganizationId: string;
    operatorUserId: string;
  }): Promise<FacultyUniversityScopeAssignment> {
    const email = String(params.facultyEmail || '')
      .trim()
      .toLowerCase();
    if (!email) {
      throw new BadRequestException('Faculty email is required');
    }
    const faculty = await this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email })
      .getOne();
    if (!faculty || faculty.role !== UserRole.FACULTY) {
      throw new BadRequestException('No faculty account exists for that email');
    }

    const org = await this.orgRepo.findOne({
      where: { id: params.universityOrganizationId },
    });
    if (!org) {
      throw new NotFoundException('University organization not found');
    }
    if (!this.isUniversityOrganization(org)) {
      throw new BadRequestException(
        'Organization must be a university-type organization',
      );
    }

    const operator = await this.usersRepo.findOne({
      where: { id: params.operatorUserId },
      relations: ['organization'],
    });
    if (!operator || operator.organization?.id !== org.id) {
      throw new ForbiddenException(
        'Only this university can authorise faculty for its own institution',
      );
    }
    if (
      !facultyMayRepresentUniversity(faculty, { id: org.id, name: org.name })
    ) {
      throw new BadRequestException(
        `This faculty account is registered at ${faculty.university || faculty.institution}, not ${org.name}. Ask them to correct their profile, or contact CIEL PK admin.`,
      );
    }

    const existing = await this.assignmentRepo.findOne({
      where: { facultyUser: { id: faculty.id } },
      relations: ['facultyUser', 'universityOrganization', 'assignedByAdmin'],
    });
    if (existing) {
      // A university may re-confirm its own faculty, never take one over from another
      // university; moving a faculty between universities is a CIEL PK admin decision.
      if (existing.universityOrganization?.id !== org.id) {
        throw new ConflictException(
          'This faculty is already authorised for another university. Ask CIEL PK admin to move them.',
        );
      }
      // Already authorised here: nothing to change, and the original grantor stays on record.
      return existing;
    }
    const created = this.assignmentRepo.create({
      facultyUser: faculty,
      universityOrganization: org,
      assignedByAdmin: operator,
    });
    return this.assignmentRepo.save(created);
  }

  async removeForUniversityOrganization(
    facultyUserId: string,
    universityOrganizationId: string,
  ): Promise<void> {
    const existing = await this.assignmentRepo.findOne({
      where: { facultyUser: { id: facultyUserId } },
      relations: ['universityOrganization'],
    });
    if (!existing) {
      throw new NotFoundException(
        'No university scope assignment for this faculty',
      );
    }
    if (existing.universityOrganization?.id !== universityOrganizationId) {
      throw new ForbiddenException(
        'That faculty is not allocated to this university',
      );
    }
    await this.assignmentRepo.remove(existing);
  }

  async remove(facultyUserId: string): Promise<void> {
    const existing = await this.assignmentRepo.findOne({
      where: { facultyUser: { id: facultyUserId } },
    });
    if (!existing) {
      throw new NotFoundException(
        'No university scope assignment for this faculty',
      );
    }
    await this.assignmentRepo.remove(existing);
  }

  async listAll(): Promise<FacultyUniversityScopeAssignment[]> {
    return this.assignmentRepo.find({
      relations: ['facultyUser', 'universityOrganization', 'assignedByAdmin'],
      order: { createdAt: 'DESC' },
    });
  }

  async listForUniversityOrganization(
    universityOrganizationId: string,
  ): Promise<FacultyUniversityScopeAssignment[]> {
    return this.assignmentRepo.find({
      where: { universityOrganization: { id: universityOrganizationId } },
      relations: ['facultyUser', 'universityOrganization'],
      order: { createdAt: 'DESC' },
    });
  }

  async canFacultyReviewApplicationAsUniversityDelegate(
    facultyUserId: string,
    studentUser: User | null | undefined,
  ): Promise<boolean> {
    const row = await this.getAssignmentForFaculty(facultyUserId);
    if (!row?.universityOrganization) return false;
    return this.studentBelongsToOrganization(
      studentUser,
      row.universityOrganization,
    );
  }
}

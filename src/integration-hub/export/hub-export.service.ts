import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/enums/user-role.enum';
import { Organization } from '../../organizations/entities/organization.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';
import { AttendanceLog } from '../../engagement/entities/attendance-log.entity';
import { StudentReport } from '../../reports/entities/student-report.entity';
import { FypEntry } from '../../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../../paths/entities/venture-entry.entity';
import { QuickWorkLog } from '../../quick-work/entities/quick-work-log.entity';
import { isCreditedParticipant } from '../../quick-work/quick-work.util';
import {
  hoursFromReportSection1,
  isPlaceholderPartnerOrg,
  sdgsFromVerifiedReport,
  verifiedRecordWhere,
} from '../../platform-stats/platform-stats.ledger.util';
import {
  buildImpactVerifyUrl,
  formatCertificateVerificationCode,
} from '../../reports/certificate-verification-code.util';
import {
  FacultyUniversityScopeService,
  type UniversityScope,
} from '../../faculty-university-scope/faculty-university-scope.service';
import { isAffiliatedWithUniversity } from '../../faculty-university-scope/university-affiliation.util';
import { ExternalConnection, ExternalPlatform } from '../entities';
import { ConnectionsService } from '../platforms/connections.service';
import {
  decodeCursor,
  type ExportQuery,
  HubExportError,
  keysetWhere,
  paginate,
} from './export-cursor.util';
import { type HubExportScope } from './export-scopes.constants';

/** Who is reading, resolved once per request from the signed platform + `connection_id`. */
export type ExportAccess = {
  platform: ExternalPlatform;
  connection: ExternalConnection;
  organization: { id: string; name: string };
  /**
   * Email / phone are included only when the connection allows personal fields AND the platform
   * is live: a sandbox credential exists for wiring tests and never carries personal data.
   */
  personalFields: boolean;
};

export type ExportPage<T> = {
  rows: T[];
  next_cursor: string | null;
  has_more: boolean;
};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** SDG numbers from the jsonb mappings on FYP / venture entries (several historical shapes). */
function sdgNumbersFromMapping(mapping: unknown): number[] {
  const m = mapping as { entries?: unknown[] } | null | undefined;
  const entries = Array.isArray(m?.entries) ? m.entries : [];
  const out = new Set<number>();
  for (const e of entries) {
    const r = (e ?? {}) as Record<string, unknown>;
    const n = Number(r.goalNumber ?? r.sdg ?? r.sdgNumber ?? r.goal);
    if (Number.isInteger(n) && n >= 1 && n <= 17) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

@Injectable()
export class HubExportService {
  /** Internal batch size when a page must be post-filtered in memory (FYP / ventures / quick). */
  private static readonly FILTER_BATCH = 200;
  private static readonly FILTER_MAX_ROUNDS = 25;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(Opportunity)
    private readonly opportunityRepo: Repository<Opportunity>,
    @InjectRepository(AttendanceLog)
    private readonly attendance: Repository<AttendanceLog>,
    @InjectRepository(StudentReport)
    private readonly reports: Repository<StudentReport>,
    @InjectRepository(FypEntry) private readonly fyps: Repository<FypEntry>,
    @InjectRepository(VentureEntry)
    private readonly ventureRepo: Repository<VentureEntry>,
    @InjectRepository(QuickWorkLog)
    private readonly quickLogs: Repository<QuickWorkLog>,
    private readonly scopeService: FacultyUniversityScopeService,
    private readonly connections: ConnectionsService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------- access

  /**
   * The signed platform may read `scope` for the organization on `connectionId` when: the
   * connection belongs to this platform and is active / within its validity window, the platform
   * is approved for the scope, the connection grants it, and the organization is a university.
   */
  async resolveAccess(
    platform: ExternalPlatform,
    connectionId: unknown,
    scope: HubExportScope,
  ): Promise<ExportAccess> {
    const id = text(connectionId);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new HubExportError(
        HttpStatus.BAD_REQUEST,
        'CONNECTION_ID_REQUIRED',
        'connection_id (uuid of your connection to the university) is required',
      );
    }
    const resolved = await this.connections.resolveForIntake(id, platform.id);
    if (!resolved.ok) {
      throw new HubExportError(
        HttpStatus.FORBIDDEN,
        resolved.code,
        'The connection is unknown, inactive or outside its validity window',
      );
    }
    const connection = resolved.connection;
    if (
      !platform.approvedEventTypes.includes(scope) ||
      !connection.scopes.includes(scope)
    ) {
      throw new HubExportError(
        HttpStatus.FORBIDDEN,
        'SCOPE_NOT_GRANTED',
        `This connection is not approved for ${scope}`,
      );
    }
    const org = await this.organizations.findOne({
      where: { id: connection.organizationId },
    });
    if (!org) {
      throw new HubExportError(
        HttpStatus.FORBIDDEN,
        'ORGANIZATION_NOT_FOUND',
        'The organization on this connection no longer exists',
      );
    }
    if (!this.scopeService.isUniversityOrganization(org)) {
      throw new HubExportError(
        HttpStatus.FORBIDDEN,
        'ORGANIZATION_NOT_UNIVERSITY',
        'Export scopes are only available on university connections',
      );
    }
    return {
      platform,
      connection,
      organization: { id: org.id, name: org.name },
      personalFields:
        connection.personalFieldsAllowed === true && platform.status === 'live',
    };
  }

  private async scopeFor(
    access: ExportAccess,
  ): Promise<UniversityScope | null> {
    return this.scopeService.resolveUniversityScope(access.organization.id);
  }

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('APP_URL') ||
      ''
    ).replace(/\/+$/, '');
  }

  private applyKeyset<T extends { updatedAt: Date; id: string }>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    q: ExportQuery,
  ): SelectQueryBuilder<T> {
    for (const part of keysetWhere(alias, q.cursor, q.updatedSince)) {
      qb.andWhere(part.sql, part.params);
    }
    return qb
      .orderBy(`${alias}.updatedAt`, 'ASC')
      .addOrderBy(`${alias}.id`, 'ASC');
  }

  private async usersById(ids: string[]): Promise<Map<string, User>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.users.find({
      where: { id: In(unique) },
      relations: ['organization'],
    });
    return new Map(rows.map((u) => [u.id, u]));
  }

  /** Student identity block shared by every row type. Email / phone only with personal fields. */
  private student(user: User | undefined, personal: boolean) {
    return {
      student_id: user?.id ?? null,
      registration_number: text(user?.registrationNumber) || null,
      student_name: text(user?.name) || null,
      department: text(user?.department) || null,
      programme: text(user?.major) || null,
      enrollment_year: text(user?.enrollmentYear) || null,
      ...(personal
        ? {
            email: text(user?.email) || null,
            phone: text(user?.phone) || null,
          }
        : {}),
    };
  }

  /**
   * Fetches cursor-ordered batches and keeps the rows `keep` accepts until a page of
   * `limit + 1` is filled or the source is exhausted. Used where membership of the university is
   * decided in memory (entries carry a typed university name, see isAffiliatedWithUniversity).
   */
  private async collectFiltered<T extends { updatedAt: Date; id: string }>(
    build: (q: ExportQuery, take: number) => Promise<T[]>,
    q: ExportQuery,
    keep: (batch: T[]) => Promise<T[]>,
  ): Promise<T[]> {
    const want = q.limit + 1;
    const out: T[] = [];
    let cursor = q.cursor;
    for (
      let round = 0;
      round < HubExportService.FILTER_MAX_ROUNDS && out.length < want;
      round += 1
    ) {
      const batch = await build(
        { ...q, cursor },
        Math.max(HubExportService.FILTER_BATCH, want),
      );
      if (!batch.length) break;
      out.push(...(await keep(batch)));
      const last = batch[batch.length - 1];
      cursor = { u: new Date(last.updatedAt).toISOString(), i: last.id };
      if (batch.length < Math.max(HubExportService.FILTER_BATCH, want)) break;
    }
    return out;
  }

  // -------------------------------------------------------------- students

  async students(access: ExportAccess, q: ExportQuery) {
    const scope = await this.scopeFor(access);
    const ids = scope ? [...scope.studentIds] : [];
    if (!ids.length) return { rows: [], next_cursor: null, has_more: false };
    const qb = this.users
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.organization', 'org')
      .where('u.id::text = ANY(:ids)', { ids })
      .andWhere('u.role = :role', { role: UserRole.STUDENT });
    const fetched = await this.applyKeyset(qb, 'u', q)
      .take(q.limit + 1)
      .getMany();
    const page = paginate(fetched, q.limit, (u) => ({
      updatedAt: u.updatedAt,
      id: u.id,
    }));
    return {
      ...page,
      rows: page.rows.map((u) => ({
        id: u.id,
        ...this.student(u, access.personalFields),
        university: text(u.university) || null,
        institution: text(u.institution) || null,
        city: text(u.city) || null,
        account_status: text(u.status) || null,
        profile_verified: u.profile_verified === true,
        identity_verified: u.identity_verified === true,
        linked_to_university_account:
          u.organization?.id === access.organization.id,
        created_at: iso(u.createdAt),
        updated_at: iso(u.updatedAt),
      })),
    };
  }

  // --------------------------------------------------------- opportunities

  async opportunities(access: ExportAccess, q: ExportQuery) {
    const scope = await this.scopeFor(access);
    const ids = scope ? [...scope.opportunityIds] : [];
    if (!ids.length) return { rows: [], next_cursor: null, has_more: false };
    const qb = this.opportunityRepo
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.organization', 'org')
      .where('o.id::text = ANY(:ids)', { ids })
      .andWhere('o.admin_approved = TRUE')
      .andWhere('COALESCE(o.admin_hidden, FALSE) = FALSE');
    const fetched = await this.applyKeyset(qb, 'o', q)
      .take(q.limit + 1)
      .getMany();
    const page = paginate(fetched, q.limit, (o) => ({
      updatedAt: o.updatedAt,
      id: o.id,
    }));
    const facultyIds = page.rows
      .map((o) => o.facultyId)
      .filter((id): id is string => Boolean(id));
    const faculty = await this.usersById(facultyIds);
    return {
      ...page,
      rows: page.rows.map((o) => {
        const tl = (o.timeline ?? {}) as Record<string, unknown>;
        const loc = (o.location ?? {}) as Record<string, unknown>;
        const sdg = (o.sdg_info ?? {}) as Record<string, unknown>;
        const sup = (o.supervision ?? {}) as Record<string, unknown>;
        const fac = o.facultyId ? faculty.get(o.facultyId) : undefined;
        const org =
          o.organization && !isPlaceholderPartnerOrg(o.organization)
            ? o.organization
            : null;
        return {
          id: o.id,
          title: text(o.title),
          types: Array.isArray(o.types) ? o.types : [],
          mode: text(o.mode) || null,
          city: text(loc.city) || null,
          venue: text(loc.venue) || null,
          start_date: text(tl.start_date) || null,
          end_date: text(tl.end_date) || null,
          expected_hours: num(tl.expected_hours),
          volunteers_required: num(tl.volunteers_required),
          primary_sdg: num(sdg.sdg_id) ?? num(o.sdg),
          secondary_sdgs: Array.isArray(o.secondary_sdgs)
            ? o.secondary_sdgs
                .map((s) => num((s as Record<string, unknown>)?.sdg_id))
                .filter((n): n is number => n !== null)
            : [],
          status: text(o.status) || null,
          workflow_stage: text(o.workflowStage) || null,
          is_student_created: o.isStudentCreated === true,
          owned_by_university: o.organizationId === access.organization.id,
          host_organization: org
            ? { id: org.id, name: org.name, type: text(org.orgType) || null }
            : null,
          faculty_supervisor: {
            name: text(fac?.name) || text(sup.supervisor_name) || null,
            ...(access.personalFields
              ? { email: text(fac?.email) || text(sup.contact) || null }
              : {}),
          },
          created_at: iso(o.createdAt),
          updated_at: iso(o.updatedAt),
        };
      }),
    };
  }

  // ----------------------------------------------- community service hours

  /** CIEL PK-verified structured reports: one row per student per project. */
  async communityServiceStructured(access: ExportAccess, q: ExportQuery) {
    const scope = await this.scopeFor(access);
    const studentIds = scope ? [...scope.studentIds] : [];
    const projectIds = scope ? [...scope.institutionalOpportunityIds] : [];
    if (!studentIds.length && !projectIds.length) {
      return { rows: [], next_cursor: null, has_more: false };
    }
    const statuses = verifiedRecordWhere().map((w) => w.status);
    const qb = this.reports
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.opportunity', 'opp')
      .leftJoinAndSelect('opp.organization', 'org')
      .leftJoinAndSelect('r.faculty', 'fac')
      .where('r.status IN (:...statuses)', { statuses })
      .andWhere("r.admin_status = 'approved'")
      .andWhere(
        '(r.studentId::text = ANY(:sids) OR r.opportunityId::text = ANY(:pids))',
        { sids: studentIds, pids: projectIds },
      );
    const fetched = await this.applyKeyset(qb, 'r', q)
      .take(q.limit + 1)
      .getMany();
    const page = paginate(fetched, q.limit, (r) => ({
      updatedAt: r.updatedAt,
      id: r.id,
    }));
    const users = await this.usersById(page.rows.map((r) => r.studentId));
    const hours = await this.attendanceHours(
      page.rows.map((r) => ({
        projectId: r.opportunityId || r.project_id,
        studentId: r.studentId,
      })),
    );
    const frontendUrl = this.frontendUrl();
    return {
      ...page,
      rows: page.rows.map((r) => {
        const projectId = r.opportunityId || r.project_id || null;
        const fromAttendance = projectId
          ? (hours.get(`${projectId}:${r.studentId}`) ?? 0)
          : 0;
        const fromReport = hoursFromReportSection1(r.section1);
        const org = r.opportunity?.organization;
        const host = org && !isPlaceholderPartnerOrg(org) ? org.name : null;
        return {
          record_id: r.id,
          source: 'structured' as const,
          ...this.student(users.get(r.studentId), access.personalFields),
          opportunity_id: projectId,
          title: text(r.opportunity?.title) || 'Community service project',
          host_organization: host,
          hours: round1(fromAttendance > 0 ? fromAttendance : fromReport),
          hours_source: fromAttendance > 0 ? 'attendance' : 'report',
          sdgs: sdgsFromVerifiedReport({
            primary_sdg_goal: r.primary_sdg_goal,
            section3: r.section3,
            opportunity: r.opportunity
              ? { sdg: r.opportunity.sdg, sdg_info: r.opportunity.sdg_info }
              : null,
          }),
          faculty_name: text(r.faculty?.name) || null,
          verified_at: iso(
            r.adminApprovedAt ?? r.adminReviewedAt ?? r.updatedAt,
          ),
          certificate_id: formatCertificateVerificationCode(
            r.verificationPublicSlug,
          ),
          verify_url: buildImpactVerifyUrl(r.verificationPublicSlug, {
            frontendUrl,
          }),
          updated_at: iso(r.updatedAt),
        };
      }),
    };
  }

  /** Approved Quick Community Impact logs: one row per credited participant of the university. */
  async communityServiceQuick(access: ExportAccess, q: ExportQuery) {
    const scope = await this.scopeFor(access);
    const studentIds = scope ? scope.studentIds : new Set<string>();
    if (!studentIds.size) {
      return { rows: [], next_cursor: null, has_more: false };
    }
    const fetched = await this.collectFiltered(
      (qq, take) =>
        this.applyKeyset(
          this.quickLogs
            .createQueryBuilder('l')
            .leftJoinAndSelect('l.participants', 'p')
            .where("l.status = 'approved'"),
          'l',
          qq,
        )
          .take(take)
          .getMany(),
      q,
      (batch) =>
        Promise.resolve(
          batch.filter((log) =>
            (log.participants ?? []).some(
              (p) => studentIds.has(p.userId) && isCreditedParticipant(p),
            ),
          ),
        ),
    );
    const page = paginate(fetched, q.limit, (l) => ({
      updatedAt: l.updatedAt,
      id: l.id,
    }));
    const users = await this.usersById(
      page.rows.flatMap((l) => (l.participants ?? []).map((p) => p.userId)),
    );
    const frontendUrl = this.frontendUrl();
    const rows = page.rows.flatMap((log) =>
      (log.participants ?? [])
        .filter((p) => studentIds.has(p.userId) && isCreditedParticipant(p))
        .map((p) => {
          const sdg = Number(log.sdg);
          const code = text(p.certificateCode) || null;
          return {
            record_id: `${log.id}:${p.id}`,
            source: 'quick' as const,
            ...this.student(users.get(p.userId), access.personalFields),
            opportunity_id: null,
            title: text(log.title) || 'Quick Community Impact',
            host_organization: text(log.host) || null,
            activity_date: text(log.activityDate) || null,
            hours: round1((Number(p.minutes) || 0) / 60),
            hours_source: 'quick',
            sdgs: Number.isInteger(sdg) && sdg >= 1 && sdg <= 17 ? [sdg] : [],
            faculty_name: text(log.facultyName) || null,
            verified_at: iso(log.reviewedAt ?? log.updatedAt),
            certificate_id: code,
            verify_url: code
              ? `${frontendUrl}/quick-impact/verify/${encodeURIComponent(code)}`
              : null,
            updated_at: iso(log.updatedAt),
          };
        }),
    );
    return { ...page, rows };
  }

  private async attendanceHours(
    pairs: { projectId: string | null; studentId: string }[],
  ): Promise<Map<string, number>> {
    const projectIds = [
      ...new Set(
        pairs.map((p) => p.projectId).filter((v): v is string => Boolean(v)),
      ),
    ];
    const studentIds = [...new Set(pairs.map((p) => p.studentId))];
    if (!projectIds.length || !studentIds.length) return new Map();
    const rows = await this.attendance
      .createQueryBuilder('log')
      .innerJoin('log.participant', 'part')
      .select('log.projectId', 'projectId')
      .addSelect('part.studentId', 'studentId')
      .addSelect('COALESCE(SUM(log.sessionHours), 0)', 'total')
      .where('log.projectId IN (:...projectIds)', { projectIds })
      .andWhere('part.studentId IN (:...studentIds)', { studentIds })
      .andWhere(
        `(log.approvalStatus = 'approved' OR log.entryStatus = 'verified')`,
      )
      .groupBy('log.projectId')
      .addGroupBy('part.studentId')
      .getRawMany<{ projectId: string; studentId: string; total: string }>();
    return new Map(
      rows.map((h) => [`${h.projectId}:${h.studentId}`, Number(h.total) || 0]),
    );
  }

  // ------------------------------------------------------------------- fyp

  /** Supervisor-approved, submitted FYP / thesis entries of the university's students. */
  async fyp(access: ExportAccess, q: ExportQuery) {
    const scope = await this.scopeFor(access);
    const org = access.organization;
    const fetched = await this.collectFiltered(
      (qq, take) =>
        this.applyKeyset(
          this.fyps
            .createQueryBuilder('e')
            .where("e.status = 'submitted'")
            .andWhere("e.supervisorApprovalStatus = 'approved'"),
          'e',
          qq,
        )
          .take(take)
          .getMany(),
      q,
      async (batch) => {
        const users = await this.usersById(batch.map((e) => e.userId));
        return batch.filter((e) =>
          this.belongs(
            users.get(e.userId),
            scope,
            org,
            (e.projectInfo as { university?: unknown } | null)?.university,
          ),
        );
      },
    );
    const page = paginate(fetched, q.limit, (e) => ({
      updatedAt: e.updatedAt,
      id: e.id,
    }));
    const users = await this.usersById(page.rows.map((e) => e.userId));
    return {
      ...page,
      rows: page.rows.map((e) => {
        const info = (e.projectInfo ?? {}) as Record<string, unknown>;
        return {
          id: e.id,
          ...this.student(users.get(e.userId), access.personalFields),
          title: text(e.projectTitle) || text(info.title) || null,
          school: text(info.school) || null,
          degree: text(info.degree) || null,
          graduation_year: text(info.graduationYear) || null,
          project_types: Array.isArray(info.projectTypes)
            ? (info.projectTypes as unknown[]).map(String)
            : text(info.projectType)
              ? [text(info.projectType)]
              : [],
          supervisor: {
            name: text(info.supervisorName) || null,
            ...(access.personalFields
              ? { email: text(info.supervisorEmail) || null }
              : {}),
          },
          sdgs: sdgNumbersFromMapping(e.sdgMapping),
          approval: {
            status: e.supervisorApprovalStatus,
            approved_at: iso(e.supervisorApprovalAt),
          },
          merit_rank: e.meritRibbon
            ? {
                rank: e.meritRibbon.rank,
                of: e.meritRibbon.of,
                scope: e.meritRibbon.scope,
              }
            : null,
          created_at: iso(e.createdAt),
          updated_at: iso(e.updatedAt),
        };
      }),
    };
  }

  // -------------------------------------------------------------- ventures

  /** Supervisor-approved, submitted startup / venture entries of the university's students. */
  async ventures(access: ExportAccess, q: ExportQuery) {
    const scope = await this.scopeFor(access);
    const org = access.organization;
    const fetched = await this.collectFiltered(
      (qq, take) =>
        this.applyKeyset(
          this.ventureRepo
            .createQueryBuilder('e')
            .where("e.status = 'submitted'")
            .andWhere(`e."reviewPipeline"->>'supervisorStatus' = 'approved'`),
          'e',
          qq,
        )
          .take(take)
          .getMany(),
      q,
      async (batch) => {
        const users = await this.usersById(batch.map((e) => e.userId));
        return batch.filter((e) =>
          this.belongs(
            users.get(e.userId),
            scope,
            org,
            e.academicSetup?.university,
          ),
        );
      },
    );
    const page = paginate(fetched, q.limit, (e) => ({
      updatedAt: e.updatedAt,
      id: e.id,
    }));
    const users = await this.usersById(page.rows.map((e) => e.userId));
    return {
      ...page,
      rows: page.rows.map((e) => {
        const a = e.academicSetup ?? {};
        return {
          id: e.id,
          ...this.student(users.get(e.userId), access.personalFields),
          venture_name: text(e.ventureName) || null,
          stage: text(e.stage) || null,
          faculty: text(a.faculty) || null,
          venture_department: text(a.department) || null,
          program: text(a.program) || null,
          academic_year: text(a.academicYear) || null,
          supervisor: {
            name: text(a.supervisorName) || null,
            ...(access.personalFields
              ? { email: text(a.supervisorEmail) || null }
              : {}),
          },
          sdgs: sdgNumbersFromMapping(e.sdgMapping),
          visible_on_showcase: e.isVisible === true,
          approval: {
            supervisor_status: e.reviewPipeline?.supervisorStatus ?? null,
            university_status: e.reviewPipeline?.universityStatus ?? null,
          },
          merit_rank: e.meritRibbon
            ? {
                rank: e.meritRibbon.rank,
                of: e.meritRibbon.of,
                scope: e.meritRibbon.scope,
              }
            : null,
          created_at: iso(e.createdAt),
          updated_at: iso(e.updatedAt),
        };
      }),
    };
  }

  /** The dashboards' membership rule: scope student, or profile / typed name names the university. */
  private belongs(
    user: User | undefined,
    scope: UniversityScope | null,
    org: { id: string; name: string },
    claim: unknown,
  ): boolean {
    if (!user) return false;
    if (scope?.studentIds.has(user.id)) return true;
    return isAffiliatedWithUniversity(
      {
        organizationId: user.organization?.id,
        university: user.university,
        institution: user.institution,
        claims: [typeof claim === 'string' ? claim : null],
      },
      org,
    );
  }

  // --------------------------------------------------------------- summary

  /**
   * Totals for a period (verified_at within [from, to]) — what a university puts in a semester
   * report. Walks the same row builders as the list endpoints so the numbers always agree.
   */
  async summary(
    access: ExportAccess,
    period: { from: Date | null; to: Date | null },
  ) {
    const scope = await this.scopeFor(access);
    const inPeriod = (at: string | null): boolean => {
      if (!at) return !period.from && !period.to;
      const t = new Date(at).getTime();
      if (period.from && t < period.from.getTime()) return false;
      if (period.to && t > period.to.getTime()) return false;
      return true;
    };
    const walk = async <T>(
      list: (q: ExportQuery) => Promise<ExportPage<T>>,
      onRow: (row: T) => void,
    ) => {
      let cursor: string | null = null;
      for (let i = 0; i < 200; i += 1) {
        const page: ExportPage<T> = await list({
          cursor: decodeCursor(cursor),
          limit: 500,
          updatedSince: null,
        });
        page.rows.forEach(onRow);
        if (!page.has_more || !page.next_cursor) break;
        cursor = page.next_cursor;
      }
    };

    const departments = new Map<
      string,
      { students: Set<string>; hours: number; records: number }
    >();
    const dept = (name: string | null) => {
      const key = name || 'Unspecified';
      const cur = departments.get(key) ?? {
        students: new Set<string>(),
        hours: 0,
        records: 0,
      };
      departments.set(key, cur);
      return cur;
    };

    let structuredRecords = 0;
    let structuredHours = 0;
    let quickRecords = 0;
    let quickHours = 0;
    const creditedStudents = new Set<string>();
    type CsRow = {
      student_id: string | null;
      department: string | null;
      hours: number;
      verified_at: string | null;
    };
    const credit = (row: CsRow, kind: 'structured' | 'quick') => {
      if (!inPeriod(row.verified_at)) return;
      if (kind === 'structured') {
        structuredRecords += 1;
        structuredHours += row.hours;
      } else {
        quickRecords += 1;
        quickHours += row.hours;
      }
      if (row.student_id) creditedStudents.add(row.student_id);
      const d = dept(row.department);
      d.records += 1;
      d.hours += row.hours;
      if (row.student_id) d.students.add(row.student_id);
    };
    await walk<CsRow>(
      (q) => this.communityServiceStructured(access, q),
      (r) => credit(r, 'structured'),
    );
    await walk<CsRow>(
      (q) => this.communityServiceQuick(access, q),
      (r) => credit(r, 'quick'),
    );

    let fypApproved = 0;
    await walk<{ approval: { approved_at: string | null } }>(
      (q) => this.fyp(access, q),
      (r) => {
        if (inPeriod(r.approval.approved_at)) fypApproved += 1;
      },
    );
    let venturesApproved = 0;
    await walk<{ updated_at: string | null }>(
      (q) => this.ventures(access, q),
      (r) => {
        if (inPeriod(r.updated_at)) venturesApproved += 1;
      },
    );

    const studentIds = scope ? [...scope.studentIds] : [];
    const studentsTotal = studentIds.length
      ? await this.users.count({
          where: { id: In(studentIds), role: UserRole.STUDENT },
        })
      : 0;
    const opportunitiesTotal = scope ? scope.opportunityIds.size : 0;

    return {
      period: { from: iso(period.from), to: iso(period.to) },
      students: {
        total: studentsTotal,
        with_verified_community_service: creditedStudents.size,
      },
      opportunities: { total: opportunitiesTotal },
      community_service: {
        structured_records: structuredRecords,
        structured_hours: round1(structuredHours),
        quick_impact_records: quickRecords,
        quick_impact_hours: round1(quickHours),
        total_hours: round1(structuredHours + quickHours),
      },
      fyp: { approved: fypApproved },
      ventures: { approved: venturesApproved },
      by_department: [...departments.entries()]
        .map(([department, d]) => ({
          department,
          students: d.students.size,
          records: d.records,
          hours: round1(d.hours),
        }))
        .sort(
          (a, b) =>
            b.hours - a.hours || a.department.localeCompare(b.department),
        ),
    };
  }
}

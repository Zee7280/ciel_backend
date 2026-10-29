import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { In, IsNull, Not, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import {
  buildImpactVerifyUrl,
  formatCertificateVerificationCode,
} from '../reports/certificate-verification-code.util';
import { QuickWorkLog } from '../quick-work/entities/quick-work-log.entity';
import {
  isCreditedParticipant,
  partnerList,
} from '../quick-work/quick-work.util';
import {
  beneficiariesFromSection4,
  hoursFromReportSection1,
  isPlaceholderPartnerOrg,
  partnerNamesFromSection7,
  sdgsFromVerifiedReport,
  verifiedRecordWhere,
} from '../platform-stats/platform-stats.ledger.util';
import {
  cityKeyFromPin,
  cityKeyFromText,
} from '../platform-stats/quick-work-ledger.util';
import {
  normalizeCityKey,
  PAKISTAN_CITY_GEO,
} from '../platform-stats/pakistan-geo';
import { CsReportSnapshot } from './entities/cs-report-snapshot.entity';
import { CreateCsReportDto } from './dto/create-cs-report.dto';
import {
  buildCsReport,
  CS_HOURS_SOURCE,
  type CsProjectDraft,
  type CsReportFilters,
  type CsStudentCredit,
  pktDate,
} from './cs-reporting.util';

type Admin = { id: string; email?: string; name?: string };

/** Crockford base32, as certificate IDs use, so a code read off a printout is not misread. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const shortRef = (prefix: string, id: string) =>
  `${prefix}-${id
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toUpperCase()}`;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function place(cityKey: string | null, fallbackCity = '') {
  const geo = cityKey ? PAKISTAN_CITY_GEO[cityKey] : undefined;
  return { city: geo?.name ?? fallbackCity, province: geo?.province ?? '' };
}

@Injectable()
export class CsReportingService {
  constructor(
    @InjectRepository(CsReportSnapshot)
    private readonly snapshots: Repository<CsReportSnapshot>,
    @InjectRepository(StudentReport)
    private readonly reports: Repository<StudentReport>,
    @InjectRepository(Participation)
    private readonly participations: Repository<Participation>,
    @InjectRepository(AttendanceLog)
    private readonly attendance: Repository<AttendanceLog>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(QuickWorkLog)
    private readonly quickLogs: Repository<QuickWorkLog>,
    private readonly config: ConfigService,
  ) {}

  /** Builds the report from live data and saves it as a snapshot that later downloads reuse. */
  async create(dto: CreateCsReportDto, admin: Admin) {
    const filters: CsReportFilters = {
      from: dto.from ?? null,
      to: dto.to ?? null,
      university: text(dto.university) || null,
      source: dto.source ?? 'all',
    };
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new BadRequestException('The start date is after the end date.');
    }

    const [structured, quick] = await Promise.all([
      filters.source === 'quick' ? [] : this.structuredDrafts(),
      filters.source === 'structured' ? [] : this.quickDrafts(),
    ]);
    const report = buildCsReport([...structured, ...quick], filters);
    if (!report.projects.length) {
      throw new BadRequestException(
        'No completed community service matches these filters.',
      );
    }

    const includeStudents = dto.includeStudents === true;
    const saved = await this.snapshots.save(
      this.snapshots.create({
        code: this.newCode(),
        preparedFor: text(dto.preparedFor) || null,
        filters,
        includeStudents,
        summary: report.summary,
        projects: report.projects,
        students: includeStudents ? report.students : null,
        generatedById: admin.id,
        generatedByName: admin.name || admin.email || null,
      }),
    );
    return this.listItem(saved);
  }

  async list() {
    const rows = await this.snapshots.find({
      select: [
        'id',
        'code',
        'preparedFor',
        'filters',
        'includeStudents',
        'summary',
        'generatedByName',
        'createdAt',
      ],
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return rows.map((r) => this.listItem(r));
  }

  async get(id: string): Promise<CsReportSnapshot> {
    const row = await this.snapshots.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Report not found.');
    return row;
  }

  private listItem(r: CsReportSnapshot) {
    return {
      id: r.id,
      code: r.code,
      preparedFor: r.preparedFor,
      filters: r.filters,
      includeStudents: r.includeStudents,
      summary: r.summary,
      generatedByName: r.generatedByName,
      createdAt: r.createdAt,
    };
  }

  private newCode(): string {
    const day = pktDate(new Date()).replace(/-/g, '');
    const rand = [...randomBytes(6)].map((b) => CODE_ALPHABET[b % 32]).join('');
    return `CSR-${day}-${rand}`;
  }

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('APP_URL') ||
      ''
    ).replace(/\/+$/, '');
  }

  /**
   * Community-service projects with at least one CIEL PK-verified report (the same "verified" the
   * public impact stats use). Everyone on the project's roster is credited with their own approved
   * attendance; a reporting student with no attendance rows is credited the hours of their
   * verified report.
   */
  private async structuredDrafts(): Promise<CsProjectDraft[]> {
    const reports = await this.reports.find({
      where: verifiedRecordWhere(),
      relations: [
        'student',
        'opportunity',
        'opportunity.organization',
        'faculty',
      ],
    });
    if (!reports.length) return [];

    const groups = new Map<string, StudentReport[]>();
    for (const r of reports) {
      const key = r.opportunityId || r.project_id || `report:${r.id}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const projectIds = [...groups.keys()].filter(
      (k) => !k.startsWith('report:'),
    );

    const [roster, hourRows] = projectIds.length
      ? await Promise.all([
          this.participations.find({
            where: { projectId: In(projectIds), studentId: Not(IsNull()) },
            select: [
              'id',
              'projectId',
              'studentId',
              'status',
              'universityName',
              'academicProgram',
            ],
          }),
          this.attendance
            .createQueryBuilder('log')
            .innerJoin('log.participant', 'part')
            .select('log.projectId', 'projectId')
            .addSelect('part.studentId', 'studentId')
            .addSelect('COALESCE(SUM(log.sessionHours), 0)', 'total')
            .where('log.projectId IN (:...projectIds)', { projectIds })
            .andWhere(
              `(log.approvalStatus = 'approved' OR log.entryStatus = 'verified')`,
            )
            .groupBy('log.projectId')
            .addGroupBy('part.studentId')
            .getRawMany<{
              projectId: string;
              studentId: string;
              total: string;
            }>(),
        ])
      : [[], []];

    const attendanceHours = new Map(
      hourRows.map((h) => [
        `${h.projectId}:${h.studentId}`,
        Number(h.total) || 0,
      ]),
    );
    const rosterByProject = new Map<string, Participation[]>();
    for (const p of roster) {
      if (p.status === 'rejected') continue;
      rosterByProject.set(p.projectId, [
        ...(rosterByProject.get(p.projectId) ?? []),
        p,
      ]);
    }

    const userIds = new Set<string>(reports.map((r) => r.studentId));
    for (const p of roster) if (p.studentId) userIds.add(p.studentId);
    const users = await this.usersById([...userIds]);
    const frontendUrl = this.frontendUrl();

    const drafts: CsProjectDraft[] = [];
    for (const [key, group] of groups) {
      const projectId = key.startsWith('report:') ? null : key;
      const opp = group.find((r) => r.opportunity)?.opportunity;
      const members = projectId ? (rosterByProject.get(projectId) ?? []) : [];
      const candidates = new Set<string>([
        ...members.map((m) => m.studentId),
        ...group.map((r) => r.studentId),
      ]);

      const credits: CsStudentCredit[] = [];
      for (const userId of candidates) {
        if (!userId) continue;
        const user = users.get(userId);
        const member = members.find((m) => m.studentId === userId);
        const own = group.find((r) => r.studentId === userId);
        const fromAttendance = projectId
          ? (attendanceHours.get(`${projectId}:${userId}`) ?? 0)
          : 0;
        const fromReport = own ? hoursFromReportSection1(own.section1) : 0;
        const slug = own?.verificationPublicSlug ?? null;
        credits.push({
          userId,
          name: text(user?.name),
          university: text(member?.universityName) || text(user?.university),
          programme: text(member?.academicProgram) || text(user?.department),
          batch: text(user?.enrollmentYear),
          rollNo: text(user?.registrationNumber),
          hours: fromAttendance > 0 ? fromAttendance : fromReport,
          hoursSource:
            fromAttendance > 0
              ? CS_HOURS_SOURCE.attendance
              : CS_HOURS_SOURCE.report,
          certificateId: formatCertificateVerificationCode(slug) ?? '',
          verifyUrl: buildImpactVerifyUrl(slug, { frontendUrl }) ?? '',
        });
      }

      const org = opp?.organization;
      const host = org && !isPlaceholderPartnerOrg(org) ? org.name : '';
      const partners = new Set<string>();
      const sdgs = new Set<number>();
      const faculty = new Set<string>();
      let beneficiaries = 0;
      let verifiedAt: Date | null = null;
      for (const r of group) {
        for (const name of partnerNamesFromSection7(r.section7)) {
          if (name.trim() && name.trim() !== host) partners.add(name.trim());
        }
        for (const g of sdgsFromVerifiedReport({
          primary_sdg_goal: r.primary_sdg_goal,
          section3: r.section3,
          opportunity: r.opportunity
            ? { sdg: r.opportunity.sdg, sdg_info: r.opportunity.sdg_info }
            : null,
        })) {
          sdgs.add(g);
        }
        if (text(r.faculty?.name)) faculty.add(text(r.faculty?.name));
        beneficiaries = Math.max(
          beneficiaries,
          beneficiariesFromSection4(r.section4),
        );
        const at = r.adminApprovedAt ?? r.adminReviewedAt ?? r.updatedAt;
        if (at && (!verifiedAt || at < verifiedAt)) verifiedAt = at;
      }

      const rawCity =
        text((opp?.location as { city?: unknown } | null)?.city) ||
        text(group[0].student?.city);
      const timeline = (opp?.timeline ?? {}) as {
        start_date?: unknown;
        end_date?: unknown;
      };
      drafts.push({
        ref: shortRef('CS', projectId ?? group[0].id),
        source: 'structured',
        title: text(opp?.title) || 'Community service project',
        host,
        partners: [...partners],
        ...place(
          normalizeCityKey(rawCity) ?? cityKeyFromText(rawCity),
          rawCity,
        ),
        sdgs: [...sdgs].sort((a, b) => a - b),
        startDate: text(timeline.start_date).slice(0, 10),
        endDate: text(timeline.end_date).slice(0, 10),
        verifiedOn: pktDate(verifiedAt),
        beneficiaries,
        faculty: [...faculty],
        credits,
      });
    }
    return drafts;
  }

  /** Approved Quick Community Impact logs, each present student credited their own minutes. */
  private async quickDrafts(): Promise<CsProjectDraft[]> {
    const logs = await this.quickLogs.find({
      where: { status: 'approved' },
      relations: ['participants'],
    });
    if (!logs.length) return [];

    const userIds = new Set<string>();
    for (const log of logs) {
      userIds.add(log.leadUserId);
      for (const p of log.participants ?? []) userIds.add(p.userId);
    }
    const users = await this.usersById([...userIds]);
    const frontendUrl = this.frontendUrl();

    return logs.map((log): CsProjectDraft => {
      const credits = (log.participants ?? [])
        .filter((p) => isCreditedParticipant(p))
        .map((p): CsStudentCredit => {
          const user = users.get(p.userId);
          const code = text(p.certificateCode);
          return {
            userId: p.userId,
            name: text(p.name) || text(user?.name),
            university: text(user?.university) || text(log.university),
            programme:
              text(user?.department) || (p.isLead ? text(log.department) : ''),
            batch: text(user?.enrollmentYear),
            rollNo: text(user?.registrationNumber) || text(p.studentId),
            hours: (Number(p.minutes) || 0) / 60,
            hoursSource: CS_HOURS_SOURCE.quick,
            certificateId: code,
            verifyUrl: code
              ? `${frontendUrl}/quick-impact/verify/${encodeURIComponent(code)}`
              : '',
          };
        });
      const sdg = Number(log.sdg);
      const cityKey =
        cityKeyFromPin(log.locationPin) ??
        cityKeyFromText(log.location) ??
        normalizeCityKey(users.get(log.leadUserId)?.city);
      return {
        ref: shortRef('QCI', log.id),
        source: 'quick',
        title: text(log.title) || 'Quick Community Impact',
        host: text(log.host),
        partners: partnerList(log.partners)
          .map((p) => p.name.trim())
          .filter(Boolean),
        ...place(cityKey),
        sdgs: Number.isInteger(sdg) && sdg >= 1 && sdg <= 17 ? [sdg] : [],
        startDate: text(log.activityDate),
        endDate: text(log.activityDate),
        verifiedOn: pktDate(log.reviewedAt ?? log.updatedAt),
        beneficiaries: Math.max(0, Number(log.peopleReached) || 0),
        faculty: text(log.facultyName) ? [text(log.facultyName)] : [],
        credits,
      };
    });
  }

  private async usersById(ids: string[]): Promise<Map<string, User>> {
    if (!ids.length) return new Map();
    const rows = await this.users.find({
      where: { id: In(ids) },
      select: [
        'id',
        'name',
        'university',
        'department',
        'enrollmentYear',
        'registrationNumber',
        'city',
      ],
    });
    return new Map(rows.map((u) => [u.id, u]));
  }
}

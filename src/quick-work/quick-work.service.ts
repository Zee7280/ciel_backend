import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { S3Service } from '../common/s3.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import {
  QuickWorkEvidence,
  QuickWorkHistoryEntry,
  QuickWorkLog,
} from './entities/quick-work-log.entity';
import { QuickWorkParticipant } from './entities/quick-work-participant.entity';
import {
  AdminQuickWorkListQuery,
  AdminQuickWorkReassignDto,
  QuickWorkPresignDto,
  QuickWorkReviewDto,
  SaveQuickWorkLogDto,
} from './dto/quick-work.dto';
import {
  attendanceMinutes,
  EMAIL_RE,
  normalizeEmail,
  QUICK_WORK_CLAIMING,
  QUICK_WORK_EDITABLE,
  QUICK_WORK_EVIDENCE_TYPES,
  QUICK_WORK_MAX_DAILY_MINUTES,
  QUICK_WORK_MAX_EVIDENCE_BYTES,
  QUICK_WORK_MAX_PARTICIPANTS,
  quickWorkSubmitErrors,
  QuickWorkStatus,
  timesOverlap,
} from './quick-work.util';

/** Accounts that can take part (and confirm): a pending-fee or suspended student cannot. */
const ACTIVE_STUDENT_STATUSES = ['active', 'approved'];

const EVIDENCE_FOLDER = 'quick-work';

/** Logs an admin sees by default: everything a student has sent for review (drafts on request). */
const ADMIN_DEFAULT_STATUSES: QuickWorkStatus[] = [
  'submitted',
  'changes',
  'approved',
  'rejected',
];
const ADMIN_STATUSES: QuickWorkStatus[] = ['draft', ...ADMIN_DEFAULT_STATUSES];
const ADMIN_EXPORT_MAX_LOGS = 5000;

type Viewer = { id: string };
type ReviewOutcome = 'approved' | 'changes' | 'rejected';

@Injectable()
export class QuickWorkService {
  private readonly logger = new Logger(QuickWorkService.name);

  constructor(
    @InjectRepository(QuickWorkLog)
    private readonly logRepo: Repository<QuickWorkLog>,
    @InjectRepository(QuickWorkParticipant)
    private readonly participantRepo: Repository<QuickWorkParticipant>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(AttendanceLog)
    private readonly attendanceRepo: Repository<AttendanceLog>,
    private readonly s3Service: S3Service,
    private readonly universityScope: FacultyUniversityScopeService,
    @Optional() private readonly mailService?: MailService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /* ------------------------------------------------------------------ reads */

  /** Student dashboard: every log I lead or take part in, invitations, and my own hour totals. */
  async listMine(viewer: Viewer) {
    const mine = await this.participantRepo.find({
      where: { userId: viewer.id },
      select: ['logId'],
    });
    const logs = mine.length
      ? await this.logRepo.find({
          where: { id: In(mine.map((p) => p.logId)) },
          relations: ['participants'],
          order: { updatedAt: 'DESC' },
        })
      : [];
    const views = logs.map((log) => this.toView(log, viewer.id));
    const own = (v: (typeof views)[number]) =>
      v.participants.find((p) => p.userId === viewer.id);
    const approved = views.filter((v) => v.status === 'approved');
    const pending = views.filter((v) => v.status === 'submitted');
    const sum = (list: typeof views) =>
      list.reduce((a, v) => a + (own(v)?.minutes ?? 0), 0);
    return {
      logs: views,
      totals: {
        approvedMinutes: sum(approved),
        pendingMinutes: sum(pending),
        approvedActivities: approved.filter((v) => (own(v)?.minutes ?? 0) > 0)
          .length,
      },
    };
  }

  async getForParticipant(viewer: Viewer, id: string) {
    const log = await this.loadLog(id);
    if (!log.participants.some((p) => p.userId === viewer.id)) {
      throw new NotFoundException('Quick-work log not found');
    }
    return this.toView(log, viewer.id);
  }

  /** Faculty review queue: logs naming this faculty member's email, once submitted. */
  async listForFaculty(viewer: Viewer) {
    const email = await this.viewerEmail(viewer);
    const logs = await this.logRepo.find({
      where: {
        facultyEmail: email,
        status: In(['submitted', 'changes', 'approved', 'rejected']),
      },
      relations: ['participants'],
      order: { submittedAt: 'DESC' },
      take: 200,
    });
    const pending = await Promise.all(
      logs
        .filter((log) => log.status === 'submitted')
        .map(async (log) => ({
          ...this.toView(log, null),
          approveBlockedReason: await this.approvalScopeError(viewer.id, log),
        })),
    );
    return {
      pending,
      reviewed: logs
        .filter((log) => log.status !== 'submitted')
        .slice(0, 50)
        .map((log) => this.toView(log, null)),
    };
  }

  /* ------------------------------------------------------------------ drafts */

  async createDraft(viewer: Viewer, dto: SaveQuickWorkLogDto) {
    const lead = await this.userRepo.findOne({ where: { id: viewer.id } });
    if (!lead) throw new NotFoundException('User not found');
    const log = this.logRepo.create({
      leadUserId: lead.id,
      status: 'draft',
      mode: 'solo',
      university: (lead.university || lead.institution || '').slice(0, 120),
      department: (lead.department || '').slice(0, 120),
      evidence: [],
      history: [],
    });
    const saved = await this.logRepo.save(log);
    await this.participantRepo.save(
      this.participantRepo.create({
        logId: saved.id,
        userId: lead.id,
        isLead: true,
        name: (lead.name || '').slice(0, 100),
        email: normalizeEmail(lead.email).slice(0, 120),
        studentId: (lead.registrationNumber || '').slice(0, 60),
        joinStatus: 'joined',
        present: true,
      }),
    );
    return this.saveDraft(viewer, saved.id, dto);
  }

  async saveDraft(viewer: Viewer, id: string, dto: SaveQuickWorkLogDto) {
    const log = await this.loadEditableAsLead(viewer, id);
    const lead = log.participants.find((p) => p.isLead) as QuickWorkParticipant;

    const text = (v: string | null | undefined) => (v ?? '').trim();
    if (dto.mode !== undefined) log.mode = dto.mode;
    if (dto.university !== undefined) log.university = text(dto.university);
    if (dto.department !== undefined) log.department = text(dto.department);
    if (dto.facultyName !== undefined) log.facultyName = text(dto.facultyName);
    if (dto.facultyEmail !== undefined) {
      log.facultyEmail = normalizeEmail(dto.facultyEmail);
    }
    if (dto.title !== undefined) log.title = text(dto.title);
    if (dto.activityType !== undefined)
      log.activityType = text(dto.activityType);
    if (dto.activityDate !== undefined) {
      log.activityDate = text(dto.activityDate) || null;
    }
    if (dto.startTime !== undefined)
      log.startTime = text(dto.startTime) || null;
    if (dto.endTime !== undefined) log.endTime = text(dto.endTime) || null;
    if (dto.location !== undefined) log.location = text(dto.location);
    if (dto.host !== undefined) log.host = text(dto.host) || null;
    if (dto.sdg !== undefined) log.sdg = dto.sdg ?? null;
    if (dto.summary !== undefined) log.summary = dto.summary ?? '';
    if (dto.peopleReached !== undefined) {
      log.peopleReached = dto.peopleReached ?? null;
    }
    if (dto.visibility !== undefined) log.visibility = dto.visibility;
    if (dto.consent !== undefined) log.consent = dto.consent;
    if (dto.honest !== undefined) log.honest = dto.honest;
    if (dto.leadStudentId !== undefined)
      lead.studentId = text(dto.leadStudentId);
    if (dto.evidence !== undefined) {
      log.evidence = this.checkedEvidence(log.leadUserId, dto.evidence);
    }

    const invited = await this.reconcileTeam(log, dto);

    if (dto.attendance !== undefined) {
      const byEmail = new Map(
        log.participants.map((p) => [normalizeEmail(p.email), p]),
      );
      for (const a of dto.attendance) {
        const p = byEmail.get(normalizeEmail(a.email));
        if (!p) continue;
        p.present = a.present;
        p.startTime = text(a.startTime) || null;
        p.endTime = text(a.endTime) || null;
        p.breakMinutes = a.breakMinutes;
      }
    }
    for (const p of log.participants) p.minutes = attendanceMinutes(p);

    await this.logRepo.save(this.withoutParticipants(log));
    await this.participantRepo.save(log.participants);

    for (const p of invited) {
      void this.notify(
        p.userId,
        'Quick Community Work: confirm you took part',
        `${lead.name || 'A student'} added you to "${log.title || 'a quick community activity'}". Open My Quick Work to confirm or decline.`,
      );
    }
    return this.toView(await this.loadLog(log.id), viewer.id);
  }

  async deleteDraft(viewer: Viewer, id: string) {
    const log = await this.loadLog(id);
    if (log.leadUserId !== viewer.id) {
      throw new NotFoundException('Quick-work log not found');
    }
    if (log.status !== 'draft') {
      throw new BadRequestException('Only an unsent draft can be deleted.');
    }
    await this.logRepo.delete({ id: log.id, status: 'draft' });
    return { deleted: true };
  }

  /** A teammate confirms (or declines) they took part. Only while the lead can still edit. */
  async respondToInvite(viewer: Viewer, id: string, accept: boolean) {
    const log = await this.loadLog(id);
    const me = log.participants.find((p) => p.userId === viewer.id);
    if (!me) throw new NotFoundException('Quick-work log not found');
    if (me.isLead) {
      throw new BadRequestException('You lead this activity.');
    }
    if (!QUICK_WORK_EDITABLE.includes(log.status)) {
      throw new BadRequestException(
        'This log has already been submitted; your participation can no longer change.',
      );
    }
    me.joinStatus = accept ? 'joined' : 'declined';
    await this.participantRepo.update(
      { id: me.id },
      { joinStatus: me.joinStatus },
    );
    void this.notify(
      log.leadUserId,
      accept
        ? 'Quick Community Work: teammate joined'
        : 'Quick Community Work: teammate declined',
      `${me.name || me.email} ${accept ? 'confirmed they took part in' : 'declined'} "${log.title || 'your quick community activity'}".`,
    );
    return this.toView(log, viewer.id);
  }

  /* ------------------------------------------------------------------ submit + review */

  async submit(viewer: Viewer, id: string) {
    const log = await this.loadEditableAsLead(viewer, id);
    const errors = [
      ...quickWorkSubmitErrors({
        ...log,
        evidence: log.evidence ?? [],
        participants: log.participants,
      }),
      ...(await this.claimErrors(log)),
    ];
    if (errors.length) throw new BadRequestException(errors);

    const now = new Date();
    for (const p of log.participants) p.minutes = attendanceMinutes(p);
    await this.participantRepo.save(log.participants);
    const result = await this.logRepo.update(
      { id: log.id, status: In([...QUICK_WORK_EDITABLE]) },
      {
        status: 'submitted',
        submittedAt: now,
        reviewNote: null,
        history: [
          ...(log.history ?? []),
          this.historyEntry(
            log.status === 'changes' ? 'resubmitted' : 'submitted',
            viewer.id,
          ),
        ],
      },
    );
    if (!result.affected) {
      throw new ConflictException('This log was already submitted.');
    }

    const lead = log.participants.find((p) => p.isLead);
    void this.notifyFaculty(log, lead?.name || 'A student');
    for (const p of log.participants) {
      if (p.isLead) continue;
      void this.notify(
        p.userId,
        'Quick Community Work submitted',
        `"${log.title}" was submitted to ${log.facultyName} for review. Your hours count once it is approved.`,
      );
    }
    return this.toView(await this.loadLog(log.id), viewer.id);
  }

  async review(viewer: Viewer, id: string, dto: QuickWorkReviewDto) {
    const email = await this.viewerEmail(viewer);
    const log = await this.loadLog(id);
    if (log.facultyEmail !== email) {
      throw new NotFoundException('Quick-work log not found');
    }
    if (dto.action === 'approve') {
      const blocked = await this.approvalScopeError(viewer.id, log);
      if (blocked) throw new ForbiddenException(blocked);
    }
    return this.applyReview(log, viewer.id, dto, '');
  }

  /**
   * Shared by faculty and admin review. Approval re-checks overlaps; a return or decline needs a
   * reason. `historyPrefix` marks an admin decision in the log history.
   */
  private async applyReview(
    log: QuickWorkLog,
    reviewerId: string,
    dto: QuickWorkReviewDto,
    historyPrefix: '' | 'admin_',
  ) {
    if (log.status !== 'submitted') {
      throw new BadRequestException('This log is not awaiting review.');
    }
    const note = (dto.note ?? '').trim();
    if (dto.action !== 'approve' && !note) {
      throw new BadRequestException('Add a brief reason or correction first.');
    }
    if (dto.action === 'approve') {
      if (!dto.verified) {
        throw new BadRequestException(
          'Confirm you reviewed the attendance and evidence.',
        );
      }
      const clash = await this.claimErrors(log);
      if (clash.length) {
        throw new BadRequestException([
          'An overlapping record exists. Return this log for correction.',
          ...clash,
        ]);
      }
    }
    const status: ReviewOutcome =
      dto.action === 'approve'
        ? 'approved'
        : dto.action === 'changes'
          ? 'changes'
          : 'rejected';
    const result = await this.logRepo.update(
      { id: log.id, status: 'submitted' },
      {
        status,
        reviewNote: note || null,
        reviewedByUserId: reviewerId,
        reviewedAt: new Date(),
        history: [
          ...(log.history ?? []),
          this.historyEntry(
            `${historyPrefix}${status}`,
            reviewerId,
            note || undefined,
          ),
        ],
      },
    );
    if (!result.affected) {
      throw new ConflictException('This log was already reviewed.');
    }

    const outcome =
      status === 'approved'
        ? 'was approved. Your approved hours now appear in My Quick Work.'
        : status === 'changes'
          ? `was returned for changes: ${note}`
          : `was not approved: ${note}`;
    for (const p of log.participants) {
      void this.notify(
        p.userId,
        'Quick Community Work reviewed',
        `"${log.title}" ${outcome}`,
      );
    }
    return this.toView(await this.loadLog(log.id), null);
  }

  /**
   * Why this faculty member may not approve the log, or null when they may: their account must be
   * authorised for a university (Faculty ↔ University scope) and every student credited with time
   * must belong to that university. Stops a self-made "faculty" account approving its own hours.
   */
  private async approvalScopeError(
    facultyUserId: string,
    log: QuickWorkLog,
  ): Promise<string | null> {
    const assignment =
      await this.universityScope.getAssignmentForFaculty(facultyUserId);
    if (!assignment?.universityOrganization) {
      return 'Your faculty account is not yet linked to a university on CIEL PK, so you cannot approve hours. Ask your university or CIEL PK to authorise your account, or return the log.';
    }
    const credited = log.participants.filter(
      (p) => p.present && attendanceMinutes(p) > 0,
    );
    if (!credited.length) return null;
    const students = await this.userRepo.find({
      where: { id: In(credited.map((p) => p.userId)) },
      relations: ['organization'],
    });
    const byId = new Map(students.map((u) => [u.id, u]));
    for (const p of credited) {
      const ok =
        await this.universityScope.canFacultyReviewApplicationAsUniversityDelegate(
          facultyUserId,
          byId.get(p.userId),
        );
      if (!ok) {
        return `${p.name || p.email} is not a student of ${assignment.universityOrganization.name}, so you cannot approve this log. Return it, or ask CIEL PK to review it.`;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ admin */

  /** Every log (drafts only on request), filtered and paged, with status counts and approved hours. */
  async listForAdmin(q: AdminQuickWorkListQuery) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 20));
    const qb = this.adminFilteredQuery(q, false);
    const [logs, total] = await qb
      .orderBy('log.submittedAt', 'DESC', 'NULLS LAST')
      .addOrderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const withParticipants = logs.length
      ? await this.logRepo.find({
          where: { id: In(logs.map((l) => l.id)) },
          relations: ['participants'],
        })
      : [];
    const byId = new Map(withParticipants.map((l) => [l.id, l]));
    const facultyEmails = [
      ...new Set(logs.map((l) => l.facultyEmail).filter(Boolean)),
    ];
    const facultyAccounts = facultyEmails.length
      ? await this.userRepo
          .createQueryBuilder('u')
          .select(['u.id', 'u.email'])
          .where('LOWER(u.email) IN (:...emails)', { emails: facultyEmails })
          .andWhere('u.role = :role', { role: UserRole.FACULTY })
          .getMany()
      : [];
    const facultyByEmail = new Set(
      facultyAccounts.map((u) => normalizeEmail(u.email)),
    );

    const rows = logs.map((l) => {
      const full = byId.get(l.id) ?? l;
      const participants = full.participants ?? [];
      const lead = participants.find((p) => p.isLead);
      return {
        id: l.id,
        title: l.title,
        status: l.status,
        activityDate: l.activityDate,
        university: l.university,
        department: l.department,
        leadName: lead?.name ?? '',
        leadEmail: lead?.email ?? '',
        facultyName: l.facultyName,
        facultyEmail: l.facultyEmail,
        facultyHasAccount: facultyByEmail.has(l.facultyEmail),
        participantCount: participants.length,
        minutes: participants.reduce(
          (a, p) => a + (p.present ? p.minutes || 0 : 0),
          0,
        ),
        evidenceCount: (l.evidence ?? []).length,
        submittedAt: l.submittedAt,
        reviewedAt: l.reviewedAt,
        createdAt: l.createdAt,
      };
    });

    const countRows = await this.adminFilteredQuery(
      { ...q, status: undefined },
      true,
    )
      .select('log.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('log.status')
      .getRawMany<{ status: QuickWorkStatus; count: string }>();
    const counts: Record<QuickWorkStatus, number> = {
      draft: 0,
      submitted: 0,
      changes: 0,
      approved: 0,
      rejected: 0,
    };
    for (const r of countRows) {
      if (r.status in counts) counts[r.status] = Number(r.count) || 0;
    }
    const approved = await this.adminFilteredQuery(
      { ...q, status: 'approved' },
      false,
    )
      .innerJoin('log.participants', 'p')
      .select(
        'COALESCE(SUM(CASE WHEN p.present THEN p.minutes ELSE 0 END), 0)',
        'minutes',
      )
      .getRawOne<{ minutes: string }>();

    return {
      rows,
      total,
      page,
      limit,
      counts,
      approvedMinutes: Number(approved?.minutes) || 0,
    };
  }

  async getForAdmin(id: string) {
    const log = await this.loadLog(id);
    const faculty = log.facultyEmail
      ? await this.userRepo
          .createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email', 'u.status'])
          .where('LOWER(u.email) = :email', { email: log.facultyEmail })
          .andWhere('u.role = :role', { role: UserRole.FACULTY })
          .getOne()
      : null;
    const assignment = faculty
      ? await this.universityScope.getAssignmentForFaculty(faculty.id)
      : null;
    const actorIds = [
      ...new Set((log.history ?? []).map((h) => h.byUserId).filter(Boolean)),
    ];
    const actors = actorIds.length
      ? await this.userRepo.find({
          where: { id: In(actorIds) },
          select: ['id', 'name', 'email', 'role'],
        })
      : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));
    return {
      ...this.toView(log, null),
      facultyAccount: faculty
        ? {
            exists: true,
            name: faculty.name,
            status: faculty.status,
            authorisedUniversity:
              assignment?.universityOrganization?.name ?? null,
          }
        : {
            exists: false,
            name: null,
            status: null,
            authorisedUniversity: null,
          },
      history: (log.history ?? []).map((h) => {
        const actor = actorById.get(h.byUserId);
        return {
          ...h,
          byName: actor?.name || actor?.email || null,
          byRole: actor?.role ?? null,
        };
      }),
    };
  }

  /** Point a log at a different reviewing faculty member (wrong email, no account, left the university). */
  async reassignFaculty(
    admin: Viewer,
    id: string,
    dto: AdminQuickWorkReassignDto,
  ) {
    const log = await this.loadLog(id);
    if (log.status === 'approved' || log.status === 'rejected') {
      throw new BadRequestException(
        'This log has already been reviewed, so its faculty cannot change.',
      );
    }
    const facultyEmail = normalizeEmail(dto.facultyEmail);
    if (!EMAIL_RE.test(facultyEmail)) {
      throw new BadRequestException('Enter a valid faculty email.');
    }
    const facultyName = dto.facultyName.trim().slice(0, 100);
    if (!facultyName) {
      throw new BadRequestException('Enter the faculty member’s name.');
    }
    if (facultyEmail === log.facultyEmail && facultyName === log.facultyName) {
      throw new BadRequestException('That is already the reviewing faculty.');
    }
    if (
      log.participants.some((p) => normalizeEmail(p.email) === facultyEmail)
    ) {
      throw new BadRequestException(
        'A participant of this log cannot be its reviewer.',
      );
    }
    const from = `${log.facultyName || '—'} <${log.facultyEmail || '—'}>`;
    const reason = (dto.note ?? '').trim();
    await this.logRepo.update(
      { id: log.id },
      {
        facultyName,
        facultyEmail,
        history: [
          ...(log.history ?? []),
          this.historyEntry(
            'admin_faculty_changed',
            admin.id,
            `From ${from} to ${facultyName} <${facultyEmail}>${reason ? `. ${reason}` : ''}`,
          ),
        ],
      },
    );
    const updated = await this.loadLog(log.id);
    if (updated.status === 'submitted') {
      const lead = updated.participants.find((p) => p.isLead);
      void this.notifyFaculty(updated, lead?.name || 'A student');
    }
    if (updated.leadUserId) {
      void this.notify(
        updated.leadUserId,
        'Reviewing faculty changed',
        `CIEL PK changed the reviewer of "${updated.title || 'your quick community activity'}" to ${facultyName}.`,
      );
    }
    return this.getForAdmin(updated.id);
  }

  /** CIEL PK admin decision on a submitted log, e.g. when its faculty cannot review it. */
  async adminReview(admin: Viewer, id: string, dto: QuickWorkReviewDto) {
    const log = await this.loadLog(id);
    await this.applyReview(log, admin.id, dto, 'admin_');
    return this.getForAdmin(log.id);
  }

  /** One row per participant for every log matching the filters (capped), for CSV export. */
  async exportForAdmin(q: AdminQuickWorkListQuery) {
    const ids = await this.adminFilteredQuery(q, false)
      .select(['log.id'])
      .orderBy('log.submittedAt', 'DESC', 'NULLS LAST')
      .addOrderBy('log.createdAt', 'DESC')
      .take(ADMIN_EXPORT_MAX_LOGS)
      .getMany();
    if (!ids.length) return { rows: [], truncated: false };
    const logs = await this.logRepo.find({
      where: { id: In(ids.map((l) => l.id)) },
      relations: ['participants'],
    });
    const order = new Map(ids.map((l, i) => [l.id, i]));
    logs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const rows = logs.flatMap((log) =>
      [...(log.participants ?? [])]
        .sort((a, b) => Number(b.isLead) - Number(a.isLead))
        .map((p) => ({
          logId: log.id,
          title: log.title,
          status: log.status,
          activityType: log.activityType,
          activityDate: log.activityDate,
          university: log.university,
          department: log.department,
          location: log.location,
          facultyName: log.facultyName,
          facultyEmail: log.facultyEmail,
          studentName: p.name,
          studentEmail: p.email,
          studentId: p.studentId,
          role: p.isLead ? 'lead' : 'teammate',
          joinStatus: p.joinStatus,
          present: p.present,
          startTime: p.startTime,
          endTime: p.endTime,
          breakMinutes: p.breakMinutes,
          minutes: p.present ? p.minutes || 0 : 0,
          submittedAt: log.submittedAt,
          reviewedAt: log.reviewedAt,
          reviewNote: log.reviewNote,
        })),
    );
    return { rows, truncated: ids.length >= ADMIN_EXPORT_MAX_LOGS };
  }

  /** Filters shared by the admin list, counts and export. */
  private adminFilteredQuery(q: AdminQuickWorkListQuery, allStatuses: boolean) {
    const qb = this.logRepo.createQueryBuilder('log');
    if (!allStatuses) {
      const statuses =
        q.status && ADMIN_STATUSES.includes(q.status)
          ? [q.status]
          : ADMIN_DEFAULT_STATUSES;
      qb.where('log.status IN (:...statuses)', { statuses });
    } else {
      qb.where('1 = 1');
    }
    const university = (q.university ?? '').trim();
    if (university) {
      qb.andWhere('log.university ILIKE :university', {
        university: `%${escapeLike(university)}%`,
      });
    }
    if (q.from) qb.andWhere('log.activityDate >= :from', { from: q.from });
    if (q.to) qb.andWhere('log.activityDate <= :to', { to: q.to });
    const search = (q.search ?? '').trim();
    if (search) {
      const term = `%${escapeLike(search)}%`;
      qb.andWhere(
        new Brackets((w) => {
          w.where('log.title ILIKE :term', { term })
            .orWhere('log.facultyEmail ILIKE :term', { term })
            .orWhere('log.facultyName ILIKE :term', { term })
            .orWhere(
              'EXISTS (SELECT 1 FROM quick_work_participants qp WHERE qp."logId" = log.id AND (qp.email ILIKE :term OR qp.name ILIKE :term OR qp."studentId" ILIKE :term))',
              { term },
            );
        }),
      );
    }
    return qb;
  }

  /* ------------------------------------------------------------------ evidence */

  async presignEvidence(viewer: Viewer, dto: QuickWorkPresignDto) {
    if (
      !(QUICK_WORK_EVIDENCE_TYPES as readonly string[]).includes(
        dto.contentType,
      )
    ) {
      throw new BadRequestException('Use JPG, PNG, WEBP or PDF files.');
    }
    if (dto.size > QUICK_WORK_MAX_EVIDENCE_BYTES) {
      throw new BadRequestException(`${dto.filename} exceeds 5 MB.`);
    }
    return this.s3Service.presignPutObject({
      folder: `${EVIDENCE_FOLDER}/${viewer.id}`,
      originalName: dto.filename,
      contentType: dto.contentType,
      contentLength: dto.size,
    });
  }

  /* ------------------------------------------------------------------ internals */

  /** Same-student overlap across quick-work logs and structured attendance, plus the daily cap. */
  private async claimErrors(log: QuickWorkLog): Promise<string[]> {
    const errors: string[] = [];
    if (!log.activityDate) return errors;
    for (const p of log.participants) {
      if (!p.present || attendanceMinutes(p) <= 0) continue;
      const who = p.name || p.email;
      const others = await this.participantRepo
        .createQueryBuilder('p')
        .innerJoin('p.log', 'log')
        .select(['p.id', 'p.startTime', 'p.endTime', 'p.minutes', 'p.present'])
        .where('p.userId = :userId', { userId: p.userId })
        .andWhere('p.present = true')
        .andWhere('log.id <> :logId', { logId: log.id })
        .andWhere('log.activityDate = :date', { date: log.activityDate })
        .andWhere('log.status IN (:...statuses)', {
          statuses: [...QUICK_WORK_CLAIMING],
        })
        .getMany();
      if (
        others.some((o) =>
          timesOverlap(p.startTime, p.endTime, o.startTime, o.endTime),
        )
      ) {
        errors.push(
          `${who} already has an overlapping pending or approved log.`,
        );
      }
      const dayTotal =
        others.reduce((a, o) => a + (o.minutes || 0), 0) + attendanceMinutes(p);
      if (dayTotal > QUICK_WORK_MAX_DAILY_MINUTES) {
        errors.push(`${who} would exceed 9 hours of quick work on this date.`);
      }
      const structured = await this.attendanceRepo
        .createQueryBuilder('a')
        .innerJoin('a.participant', 'part')
        .select(['a.id', 'a.startTime', 'a.endTime'])
        .where('part.studentId = :userId', { userId: p.userId })
        .andWhere('a.dateOfEngagement = :date', { date: log.activityDate })
        .andWhere("COALESCE(a.approvalStatus, '') <> 'rejected'")
        .getMany();
      if (
        structured.some((a) =>
          timesOverlap(p.startTime, p.endTime, a.startTime, a.endTime),
        )
      ) {
        errors.push(
          `${who} already logged structured community service attendance at this time. Do not count the same activity twice.`,
        );
      }
    }
    return errors;
  }

  /** Apply the teammate list; returns participants newly invited (to notify after saving). */
  private async reconcileTeam(
    log: QuickWorkLog,
    dto: SaveQuickWorkLogDto,
  ): Promise<QuickWorkParticipant[]> {
    const lead = log.participants.find((p) => p.isLead) as QuickWorkParticipant;
    let wanted = dto.teammates;
    if (log.mode === 'solo') wanted = [];
    if (wanted === undefined) return [];

    const seen = new Set<string>();
    const desired: { email: string; studentId?: string }[] = [];
    for (const t of wanted) {
      const email = normalizeEmail(t.email);
      if (!EMAIL_RE.test(email)) {
        throw new BadRequestException(`"${t.email}" is not a valid email.`);
      }
      if (email === normalizeEmail(lead.email)) {
        throw new BadRequestException(
          'You are already on this log as the lead.',
        );
      }
      if (seen.has(email)) {
        throw new BadRequestException(`${email} is already on this team.`);
      }
      seen.add(email);
      desired.push({ email, studentId: t.studentId?.trim() });
    }
    if (desired.length + 1 > QUICK_WORK_MAX_PARTICIPANTS) {
      throw new BadRequestException(
        `This log allows up to ${QUICK_WORK_MAX_PARTICIPANTS} participants.`,
      );
    }

    const current = log.participants.filter((p) => !p.isLead);
    const removed = current.filter((p) => !seen.has(normalizeEmail(p.email)));
    if (removed.length) {
      await this.participantRepo.delete({ id: In(removed.map((p) => p.id)) });
    }
    const kept = current.filter((p) => seen.has(normalizeEmail(p.email)));
    const keptByEmail = new Map(kept.map((p) => [normalizeEmail(p.email), p]));

    const invited: QuickWorkParticipant[] = [];
    for (const d of desired) {
      const existing = keptByEmail.get(d.email);
      if (existing) {
        if (d.studentId !== undefined) existing.studentId = d.studentId;
        continue;
      }
      const user = await this.userRepo
        .createQueryBuilder('u')
        .where('LOWER(u.email) = :email', { email: d.email })
        .getOne();
      if (!user || user.role !== UserRole.STUDENT) {
        throw new BadRequestException(
          `No CIEL student account uses ${d.email}. Ask your teammate to sign up as a student first.`,
        );
      }
      if (!ACTIVE_STUDENT_STATUSES.includes(user.status)) {
        throw new BadRequestException(
          `${user.name || d.email}'s CIEL account is not active yet, so they cannot confirm joining.`,
        );
      }
      const p = this.participantRepo.create({
        logId: log.id,
        userId: user.id,
        isLead: false,
        name: (user.name || '').slice(0, 100),
        email: d.email,
        studentId: (d.studentId || user.registrationNumber || '').slice(0, 60),
        joinStatus: 'invited',
        present: true,
      });
      kept.push(p);
      invited.push(p);
    }
    log.participants = [lead, ...kept];
    return invited;
  }

  /** Evidence must be files this lead uploaded through our presign (their own S3 folder). */
  private checkedEvidence(
    leadUserId: string,
    items: SaveQuickWorkLogDto['evidence'],
  ): QuickWorkEvidence[] {
    return (items ?? []).map((e) => {
      const key = this.s3Service.keyFromPublicUrl(e.url);
      if (!key || !key.startsWith(`${EVIDENCE_FOLDER}/${leadUserId}/`)) {
        throw new BadRequestException(
          `Upload ${e.name || 'each evidence file'} again from this form.`,
        );
      }
      return {
        url: e.url,
        name: e.name.trim(),
        type: e.type,
        size: e.size,
        caption: e.caption.trim(),
      };
    });
  }

  private async loadLog(id: string): Promise<QuickWorkLog> {
    const log = await this.logRepo.findOne({
      where: { id },
      relations: ['participants'],
    });
    if (!log) throw new NotFoundException('Quick-work log not found');
    log.participants.sort((a, b) => Number(b.isLead) - Number(a.isLead));
    return log;
  }

  private async loadEditableAsLead(
    viewer: Viewer,
    id: string,
  ): Promise<QuickWorkLog> {
    const log = await this.loadLog(id);
    if (log.leadUserId !== viewer.id) {
      throw new NotFoundException('Quick-work log not found');
    }
    if (!QUICK_WORK_EDITABLE.includes(log.status)) {
      throw new BadRequestException(
        'This log has been submitted and can no longer be edited.',
      );
    }
    return log;
  }

  private async viewerEmail(viewer: Viewer): Promise<string> {
    const user = await this.userRepo.findOne({
      where: { id: viewer.id },
      select: ['id', 'email'],
    });
    if (!user) throw new ForbiddenException();
    return normalizeEmail(user.email);
  }

  /** Save the log row alone: participants are saved separately so removals are not re-inserted. */
  private withoutParticipants(log: QuickWorkLog): QuickWorkLog {
    const copy = Object.assign(this.logRepo.create(), log);
    delete (copy as Partial<QuickWorkLog>).participants;
    return copy;
  }

  private historyEntry(
    action: string,
    byUserId: string,
    note?: string,
  ): QuickWorkHistoryEntry {
    return {
      action,
      at: new Date().toISOString(),
      byUserId,
      ...(note ? { note } : {}),
    };
  }

  private toView(log: QuickWorkLog, viewerId: string | null) {
    const participants = [...(log.participants ?? [])]
      .sort((a, b) => Number(b.isLead) - Number(a.isLead))
      .map((p) => ({
        id: p.id,
        userId: p.userId,
        isLead: p.isLead,
        name: p.name,
        email: p.email,
        studentId: p.studentId,
        joinStatus: p.joinStatus,
        present: p.present,
        startTime: p.startTime,
        endTime: p.endTime,
        breakMinutes: p.breakMinutes,
        minutes: p.minutes,
      }));
    return {
      id: log.id,
      status: log.status,
      mode: log.mode,
      university: log.university,
      department: log.department,
      facultyName: log.facultyName,
      facultyEmail: log.facultyEmail,
      title: log.title,
      activityType: log.activityType,
      activityDate: log.activityDate,
      startTime: log.startTime,
      endTime: log.endTime,
      location: log.location,
      host: log.host,
      sdg: log.sdg,
      summary: log.summary,
      peopleReached: log.peopleReached,
      visibility: log.visibility,
      evidence: log.evidence ?? [],
      consent: log.consent,
      honest: log.honest,
      reviewNote: log.reviewNote,
      reviewedAt: log.reviewedAt,
      submittedAt: log.submittedAt,
      createdAt: log.createdAt,
      updatedAt: log.updatedAt,
      isLead: viewerId != null && log.leadUserId === viewerId,
      /** The viewing student's own row (their hours / join status); null for faculty. */
      viewerParticipantId:
        participants.find((p) => viewerId != null && p.userId === viewerId)
          ?.id ?? null,
      participants,
    };
  }

  private async notify(userId: string, title: string, message: string) {
    try {
      await this.notificationsService?.createNotification(userId, {
        type: 'quick_work',
        title,
        message,
      });
    } catch (e) {
      this.logger.warn(
        `Quick-work notification failed: ${(e as Error).message}`,
      );
    }
  }

  private async notifyFaculty(log: QuickWorkLog, leadName: string) {
    const faculty = await this.userRepo
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email: log.facultyEmail })
      .andWhere('u.role = :role', { role: UserRole.FACULTY })
      .getOne()
      .catch(() => null);
    if (faculty) {
      void this.notify(
        faculty.id,
        'Quick Community Work to review',
        `${leadName} submitted "${log.title}" for your review.`,
      );
    }
    try {
      await this.mailService?.sendQuickWorkSubmittedForReview({
        to: log.facultyEmail,
        facultyName: log.facultyName,
        leadName,
        title: log.title,
        participants: log.participants.length,
      });
    } catch (e) {
      this.logger.warn(
        `Quick-work faculty email failed: ${(e as Error).message}`,
      );
    }
  }
}

/** Escape LIKE wildcards in user input so "50%" matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

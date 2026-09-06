import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  CourseProjectEntry,
  CourseProjectStudentInfo,
} from './entities/course-project-entry.entity';
import {
  DEFAULT_FYP_MILESTONES,
  FypEntry,
  FypProjectInfo,
} from './entities/fyp-entry.entity';
import { VentureEntry } from './entities/venture-entry.entity';
import {
  TeamMemberInvite,
  TeamMemberInviteKind,
} from './entities/team-member-invite.entity';
import { PathGraderRun, PathGraderRunScope, PathGraderRunKind } from './entities/path-grader-run.entity';
import { formatCertificateVerificationCode } from '../reports/certificate-verification-code.util';
import { UpdateCourseProjectDto } from './dto/update-course-project.dto';
import { AddFypDeliverableDto, UpdateFypDto } from './dto/update-fyp.dto';
import { FypMeritModelQueryDto } from './dto/fyp-merit-model-query.dto';
import { VentureMeritModelQueryDto } from './dto/venture-merit-model-query.dto';
import { AddVentureDocumentDto, UpdateVentureDto } from './dto/update-venture.dto';
import { ventureMatchesFaculty } from './venture-faculty-scope.util';
import {
  ventureCompletenessPercent,
  ventureMissingItems,
  VENTURE_VISIBILITY_THRESHOLD,
} from './venture-completeness.constants';
import { computeVentureGates, deriveVentureIsVisible } from './venture-gates.util';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MeritModelQueryDto, NotifyMeritRanksDto } from './dto/merit-model-query.dto';
import { byMerit, computeMeritCard, deriveMeritYear } from './merit-model/merit-model.util';
import { RankedMeritCard } from './merit-model/merit-model.types';
import { byFypMerit, computeFypMeritCard, deriveFypCompletionMonth, deriveFypRoute } from './merit-model/fyp-merit-model.util';
import { RankedFypMeritCard } from './merit-model/fyp-merit-model.types';
import { byVentureMerit, computeVentureMeritCard } from './merit-model/venture-merit-model.util';
import { RankedVentureMeritCard } from './merit-model/venture-merit-model.types';

@Injectable()
export class PathsService {
  private readonly logger = new Logger(PathsService.name);

  constructor(
    @InjectRepository(CourseProjectEntry)
    private readonly courseProjectRepo: Repository<CourseProjectEntry>,
    @InjectRepository(FypEntry)
    private readonly fypRepo: Repository<FypEntry>,
    @InjectRepository(VentureEntry)
    private readonly ventureRepo: Repository<VentureEntry>,
    @InjectRepository(TeamMemberInvite)
    private readonly teamMemberInviteRepo: Repository<TeamMemberInvite>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly organizationsRepo: Repository<Organization>,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    @InjectRepository(PathGraderRun)
    private readonly graderRunRepo: Repository<PathGraderRun>,
  ) {}

  // ---------- Team-member invites (shared across Course Project / FYP / Venture) ----------

  private static readonly INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  /** Pulls valid-looking, deduped emails out of a groupMembers/teamMembers/team array — entries
   * may be a plain legacy string (no email) or an object with an optional email field. */
  private extractMemberEmails(members: unknown[] | undefined | null): string[] {
    if (!members?.length) return [];
    const emails = new Set<string>();
    for (const m of members) {
      if (m && typeof m === 'object' && 'email' in (m as Record<string, unknown>)) {
        const raw = (m as { email?: unknown }).email;
        if (typeof raw === 'string' && raw.trim()) emails.add(raw.trim().toLowerCase());
      }
    }
    return [...emails];
  }

  /** Fires a real, verifiable invite email to any newly-named team member with an email that
   * hasn't already been invited for this exact (kind, entryId, email) — dedup makes this safe to
   * call on every autosave without re-sending mail each time. Best-effort: a failed row/email must
   * never block the report save that triggered it. */
  private async syncTeamInvites(
    kind: TeamMemberInviteKind,
    entryId: string,
    invitedByUserId: string,
    inviterName: string,
    kindLabel: string,
    title: string,
    members: unknown[] | undefined | null,
  ): Promise<void> {
    const emails = this.extractMemberEmails(members);
    if (!emails.length) return;
    const existing = await this.teamMemberInviteRepo.find({ where: { kind, entryId } });
    const existingEmails = new Set(existing.map((i) => i.email));
    const toInvite = emails.filter((e) => !existingEmails.has(e));
    for (const email of toInvite) {
      try {
        const existingUser = await this.usersRepo.findOne({
          where: { email },
          select: ['id', 'role'],
        });
        const autoConnect =
          !!existingUser?.id && existingUser.role === UserRole.STUDENT;
        const invite = this.teamMemberInviteRepo.create({
          kind,
          entryId,
          email,
          token: randomUUID(),
          status: autoConnect ? 'accepted' : 'pending',
          invitedByUserId,
          expiresAt: new Date(Date.now() + PathsService.INVITE_TTL_MS),
          ...(autoConnect
            ? { acceptedByUserId: existingUser.id, acceptedAt: new Date() }
            : {}),
        });
        await this.teamMemberInviteRepo.save(invite);
        await this.mailService.sendPathTeamInvite(email, {
          inviterName,
          kindLabel,
          title,
          token: invite.token,
        });
      } catch (err) {
        // best-effort — see docstring — but must still be visible, or a stuck
        // invite (e.g. a bad row insert) silently pins the student's badge on
        // "Will invite on save" forever with no way to diagnose why.
        this.logger.error(
          `syncTeamInvites failed for ${kind}/${entryId}/${email}: ${(err as Error)?.message ?? err}`,
          (err as Error)?.stack,
        );
      }
    }
  }

  /** Annotates each entry's group/team member array with `inviteStatus` ('pending' | 'accepted')
   * from team_member_invites, so owners (and faculty/admin views) can see real confirmation state
   * instead of the old always-on fake badge. Never exposes the invite token. */
  private async annotateInviteStatus<T extends { id: string }>(
    entries: T[],
    kind: TeamMemberInviteKind,
    getMembers: (entry: T) => unknown[] | undefined | null,
    setMembers: (entry: T, members: unknown[]) => T,
  ): Promise<T[]> {
    if (!entries.length) return entries;
    const ids = entries.map((e) => e.id);
    const invites = await this.teamMemberInviteRepo.find({
      where: { kind, entryId: In(ids) },
    });
    if (!invites.length) return entries;
    const statusByKey = new Map(invites.map((i) => [`${i.entryId}::${i.email}`, i.status]));
    return entries.map((entry) => {
      const members = getMembers(entry);
      if (!members?.length) return entry;
      const annotated = members.map((m) => {
        if (!m || typeof m !== 'object' || !('email' in (m as Record<string, unknown>))) return m;
        const raw = (m as { email?: unknown }).email;
        if (typeof raw !== 'string' || !raw.trim()) return m;
        const status = statusByKey.get(`${entry.id}::${raw.trim().toLowerCase()}`);
        return status ? { ...(m as object), inviteStatus: status } : m;
      });
      return setMembers(entry, annotated);
    });
  }

  private async describeInvite(invite: TeamMemberInvite): Promise<{
    title: string;
    inviterName: string;
    kindLabel: string;
  }> {
    const inviter = await this.usersRepo.findOne({
      where: { id: invite.invitedByUserId },
      select: ['name'],
    });
    const inviterName = inviter?.name || 'A fellow student';
    if (invite.kind === 'course_project') {
      const entry = await this.courseProjectRepo.findOne({ where: { id: invite.entryId } });
      return {
        title: entry?.projectTitle || entry?.course || 'a Course Project report',
        inviterName,
        kindLabel: 'Course Project',
      };
    }
    if (invite.kind === 'fyp') {
      const entry = await this.fypRepo.findOne({ where: { id: invite.entryId } });
      return {
        title: entry?.projectTitle || 'an FYP / Thesis record',
        inviterName,
        kindLabel: 'FYP / Thesis',
      };
    }
    const entry = await this.ventureRepo.findOne({ where: { id: invite.entryId } });
    return {
      title: entry?.ventureName || 'a Startup / Business venture',
      inviterName,
      kindLabel: 'Startup / Business',
    };
  }

  /** Public preview shown on the /verify/team-invite landing page before the teammate accepts. */
  async getTeamInvitePreview(token: string) {
    const invite = await this.teamMemberInviteRepo.findOne({ where: { token } });
    if (!invite) throw new NotFoundException('Invite not found');
    const { title, inviterName, kindLabel } = await this.describeInvite(invite);
    return {
      kind: invite.kind,
      entryId: invite.entryId,
      email: invite.email,
      status: invite.status,
      expired: invite.status === 'pending' && invite.expiresAt < new Date(),
      inviterName,
      title,
      kindLabel,
    };
  }

  /** The only way a team member's email becomes query-matchable for read access — requires the
   * accepting account's own (already-verified-at-signup) email to exactly match the invite's
   * target email, so this doubles as ownership proof without a second OTP step. */
  async acceptTeamInvite(token: string, userId: string, userEmail: string) {
    const invite = await this.teamMemberInviteRepo.findOne({ where: { token } });
    if (!invite) throw new NotFoundException('Invite not found');
    const email = (userEmail || '').trim().toLowerCase();
    if (!email || email !== invite.email) {
      throw new ForbiddenException(
        'This invite was sent to a different email address — sign in with that email to accept it.',
      );
    }
    if (invite.status === 'pending' && invite.expiresAt < new Date()) {
      throw new BadRequestException(
        'This invite has expired — ask the report owner to resend it.',
      );
    }
    if (invite.status !== 'accepted') {
      invite.status = 'accepted';
      invite.acceptedByUserId = userId;
      invite.acceptedAt = new Date();
      await this.teamMemberInviteRepo.save(invite);
    }
    const { title, kindLabel } = await this.describeInvite(invite);
    return { kind: invite.kind, entryId: invite.entryId, title, kindLabel };
  }

  /** Owner-triggered resend — looked up by (kind, entryId, email) rather than token, since the
   * owner's own view of their report never exposes teammates' invite tokens. */
  async resendTeamInvite(
    requesterUserId: string,
    kind: TeamMemberInviteKind,
    entryId: string,
    email: string,
  ) {
    const normEmail = (email || '').trim().toLowerCase();
    const invite = await this.teamMemberInviteRepo.findOne({
      where: { kind, entryId, email: normEmail },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.invitedByUserId !== requesterUserId) {
      throw new ForbiddenException('Only the report owner can resend this invite');
    }
    if (invite.status === 'accepted') return { success: true, alreadyAccepted: true };
    invite.expiresAt = new Date(Date.now() + PathsService.INVITE_TTL_MS);
    await this.teamMemberInviteRepo.save(invite);
    const { title, inviterName, kindLabel } = await this.describeInvite(invite);
    await this.mailService.sendPathTeamInvite(normEmail, {
      inviterName,
      kindLabel,
      title,
      token: invite.token,
    });
    return { success: true };
  }

  // ---------- Course Project ----------

  /** class-transformer instantiates every declared DTO field as an own property, `undefined`
   * for whatever the caller didn't send — so `{...entry.group, ...dto.group}` silently wipes
   * previously-saved sibling fields on any partial patch (e.g. patching just `groupMembers`
   * would erase `teacherEmail`, `studentName`, etc.). Stripping the `undefined` keys first
   * restores real partial-merge (PATCH) semantics. */
  private static withoutUndefined<T extends object>(obj: T | undefined): Partial<T> {
    if (!obj) return {};
    const out: Partial<T> = {};
    for (const key of Object.keys(obj) as (keyof T)[]) {
      if (obj[key] !== undefined) out[key] = obj[key];
    }
    return out;
  }

  private applyCourseProjectPatch(
    entry: CourseProjectEntry,
    dto: UpdateCourseProjectDto,
  ): {
    entry: CourseProjectEntry;
    notify: 'first_submission' | 'resubmission' | null;
    /** True the moment a faculty email is first attached to this record — the "one master record,
     * auto-connected to student + faculty + university + CIEL PK" moment, independent of submission. */
    justConnected: boolean;
  } {
    const keep = PathsService.withoutUndefined;
    const previousStatus = entry.status;
    const hadTeacherEmail = !!(entry.studentInfo?.teacherEmail || '').trim();
    if (dto.course !== undefined) entry.course = dto.course;
    if (dto.projectTitle !== undefined) entry.projectTitle = dto.projectTitle;
    if (dto.projectDescription !== undefined)
      entry.projectDescription = dto.projectDescription;
    if (dto.sdgs !== undefined) entry.sdgs = dto.sdgs;
    if (dto.evidenceUrls !== undefined) entry.evidenceUrls = dto.evidenceUrls;
    if (dto.evidenceTypes !== undefined)
      entry.evidenceTypes = dto.evidenceTypes;
    if (dto.assignmentFileUrl !== undefined)
      entry.assignmentFileUrl = dto.assignmentFileUrl;
    if (dto.studentInfo !== undefined)
      entry.studentInfo = {
        ...entry.studentInfo,
        ...keep(dto.studentInfo),
      } as CourseProjectStudentInfo;
    if (dto.assignmentInfo !== undefined)
      entry.assignmentInfo = { ...entry.assignmentInfo, ...keep(dto.assignmentInfo) };
    if (dto.aimsInfo !== undefined)
      entry.aimsInfo = { ...entry.aimsInfo, ...keep(dto.aimsInfo) };
    if (dto.processInfo !== undefined)
      entry.processInfo = { ...entry.processInfo, ...keep(dto.processInfo) };
    if (dto.resultsInfo !== undefined)
      entry.resultsInfo = { ...entry.resultsInfo, ...keep(dto.resultsInfo) };
    if (dto.sdgMapping !== undefined)
      entry.sdgMapping = { ...entry.sdgMapping, ...keep(dto.sdgMapping) };
    if (dto.reflectionInfo !== undefined)
      entry.reflectionInfo = { ...entry.reflectionInfo, ...keep(dto.reflectionInfo) };
    if (dto.moduleInclusion !== undefined)
      entry.moduleInclusion = {
        ...entry.moduleInclusion,
        ...keep(dto.moduleInclusion),
      };
    if (dto.sectionSummaries !== undefined)
      entry.sectionSummaries = {
        ...entry.sectionSummaries,
        ...keep(dto.sectionSummaries),
      };
    if (dto.addedNote !== undefined) entry.addedNote = dto.addedNote;
    if (dto.stepCompleted !== undefined)
      entry.stepCompleted = dto.stepCompleted;
    if (dto.status !== undefined) entry.status = dto.status;
    // Editing a previously-approved report after the fact invalidates that approval — send it
    // back to the teacher's queue rather than silently keeping stale content "live".
    // Same for a returned (rejected/revision-requested) report: fix & resubmit should land as a
    // fresh review, not stay stuck on "returned". Keep the teacher's notes so the student still sees them.
    let notify: 'first_submission' | 'resubmission' | null = null;
    if (entry.status === 'submitted' && entry.facultyApprovalStatus === 'approved') {
      entry.facultyApprovalStatus = 'pending';
      entry.facultyApprovalNote = null;
      entry.facultyApprovalAt = null;
      entry.meritRibbon = null;
      notify = 'resubmission';
    } else if (
      entry.status === 'submitted' &&
      (entry.facultyApprovalStatus === 'rejected' || entry.facultyApprovalStatus === 'revision_requested')
    ) {
      entry.facultyApprovalStatus = 'pending';
      entry.facultyApprovalAt = null;
      entry.meritRibbon = null;
      notify = 'resubmission';
    } else if (previousStatus !== 'submitted' && entry.status === 'submitted') {
      notify = 'first_submission';
    }
    const justConnected = !hadTeacherEmail && !!(entry.studentInfo?.teacherEmail || '').trim();
    return { entry, notify, justConnected };
  }

  /** Best-effort — a submission/resubmission email failure must never fail the student's save. */
  private async notifyCourseworkTransition(
    entry: CourseProjectEntry,
    transition: 'first_submission' | 'resubmission' | null,
  ): Promise<void> {
    if (!transition) return;
    const studentName = entry.studentInfo?.studentName?.trim() || 'Student';
    const title = entry.projectTitle || 'Untitled coursework';
    const teacherEmail = (entry.studentInfo?.teacherEmail || '').trim();
    try {
      if (transition === 'first_submission') {
        if (teacherEmail) {
          await this.mailService.sendCourseworkSubmittedForReview(teacherEmail, studentName, title);
        }
        const student = await this.usersRepo.findOne({ where: { id: entry.userId }, select: ['email'] });
        if (student?.email) {
          const first = studentName.split(' ')[0];
          await this.mailService.sendCourseworkSubmissionConfirmation(student.email, first, title);
        }
      } else if (teacherEmail) {
        await this.mailService.sendCourseworkResubmittedForReview(teacherEmail, studentName, title);
      }
    } catch (err) {
      this.logger.warn(
        `Coursework transition email failed for ${entry.id} (${transition}): ${(err as Error).message}`,
      );
    }
  }

  /** Fires once — the moment a faculty email is first attached to a draft coursework record, i.e.
   * "one master record, auto-connected to student + faculty + university + CIEL PK". Best-effort:
   * an email failure here must never fail the student's autosave. */
  private async notifyCourseworkConnected(entry: CourseProjectEntry): Promise<void> {
    const studentName = entry.studentInfo?.studentName?.trim() || 'Student';
    const title = entry.projectTitle || entry.course || 'Untitled coursework';
    const teacherEmail = (entry.studentInfo?.teacherEmail || '').trim();
    const teacherName = entry.studentInfo?.teacherName?.trim() || 'there';
    const universityName = entry.studentInfo?.universityName?.trim() || undefined;
    try {
      if (teacherEmail) {
        await this.mailService.sendPathProjectConnectedToFaculty(teacherEmail, teacherName, studentName, 'Coursework', title, '/dashboard/faculty/coursework-projects');
      }
      const student = await this.usersRepo.findOne({ where: { id: entry.userId }, select: ['email'] });
      if (student?.email) {
        await this.mailService.sendPathProjectConnectedToStudent(student.email, studentName.split(' ')[0], 'Coursework', title, teacherEmail ? teacherName : undefined, universityName);
      }
      await this.mailService.sendPathProjectConnectedToCielPk(studentName, teacherEmail ? teacherName : undefined, universityName, 'Coursework', title);
    } catch (err) {
      this.logger.warn(`Coursework connection email failed for ${entry.id}: ${(err as Error).message}`);
    }
  }

  private courseProjectAnnotate(entries: CourseProjectEntry[]) {
    return this.annotateInviteStatus(
      entries,
      'course_project',
      (e) => e.studentInfo?.groupMembers,
      (e, members) =>
        ({
          ...e,
          studentInfo: { ...e.studentInfo, groupMembers: members } as CourseProjectStudentInfo,
        }) as CourseProjectEntry,
    );
  }

  private async syncCourseProjectInvites(entry: CourseProjectEntry, invitedByUserId: string) {
    await this.syncTeamInvites(
      'course_project',
      entry.id,
      invitedByUserId,
      entry.studentInfo?.studentName || 'A fellow student',
      'Course Project',
      entry.projectTitle || entry.course || 'a Course Project report',
      entry.studentInfo?.groupMembers,
    );
  }

  /** Faculty approve/reject a submitted Course Project entry — only "approved" entries are eligible for Merit Model ranking/showcase. Matched the same way as listCourseProjectsForTeacher: the teacher email the student entered in step 1. */
  async facultyReviewCourseProject(
    facultyEmail: string,
    id: string,
    action: 'approve' | 'reject' | 'revision',
    note?: string,
  ) {
    const email = (facultyEmail || '').trim().toLowerCase();
    if (!email) throw new NotFoundException('Course project entry not found');
    const entry = await this.courseProjectRepo.findOne({ where: { id } });
    if (
      !entry ||
      entry.status !== 'submitted' ||
      (entry.studentInfo?.teacherEmail || '').trim().toLowerCase() !== email
    ) {
      throw new NotFoundException('Course project entry not found');
    }
    entry.facultyApprovalStatus =
      action === 'approve' ? 'approved' : action === 'revision' ? 'revision_requested' : 'rejected';
    entry.facultyApprovalNote = note ?? null;
    entry.facultyApprovalAt = new Date();
    if (action !== 'approve') entry.meritRibbon = null;
    const saved = await this.courseProjectRepo.save(entry);
    const first = saved.studentInfo?.studentName?.split(' ')[0] || 'there';
    const title = saved.projectTitle || 'Untitled';
    try {
      if (action === 'approve') {
        await this.notificationsService.createNotification(saved.userId, {
          type: 'approval',
          title: 'Your coursework was approved',
          message: `${first}, “${title}” is live. It now hangs on My Impact Wall — wait for end-of-semester ranking and badge allocation.`,
        });
      } else if (action === 'revision') {
        const extra = (note || '').trim();
        await this.notificationsService.createNotification(saved.userId, {
          type: 'update',
          title: 'Revision requested on your coursework',
          message: extra
            ? `${first}, “${title}” needs a revision before it can be approved. ${extra} Open the report, fix, and resubmit — nothing is penalised.`
            : `${first}, “${title}” needs a revision before it can be approved. Open the report, fix, and resubmit — nothing is penalised.`,
        });
      } else {
        const extra = (note || '').trim();
        await this.notificationsService.createNotification(saved.userId, {
          type: 'update',
          title: 'Your coursework was rejected',
          message: extra
            ? `${first}, “${title}” was rejected. ${extra} Open the report, fix, and resubmit — nothing is penalised.`
            : `${first}, “${title}” was rejected. Open the report, fix, and resubmit — nothing is penalised.`,
        });
      }
      const student = await this.usersRepo.findOne({ where: { id: saved.userId }, select: ['email'] });
      if (student?.email) {
        if (action === 'approve') {
          await this.mailService.sendCourseworkApproved(student.email, first, title);
        } else if (action === 'revision') {
          await this.mailService.sendCourseworkRevisionRequested(student.email, first, title, note);
        } else {
          await this.mailService.sendCourseworkRejected(student.email, first, title, note);
        }
      }
    } catch (err) {
      this.logger.warn(`Coursework review notification failed for ${saved.id}: ${(err as Error).message}`);
    }
    return saved;
  }

  /** @deprecated single-entry accessor, kept for backward compatibility — returns the most recently touched entry. */
  async getCourseProject(userId: string) {
    return this.courseProjectRepo.findOne({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  /** @deprecated single-entry upsert, kept for backward compatibility — use create/update-by-id for multi-entry decks. */
  async upsertCourseProject(userId: string, dto: UpdateCourseProjectDto) {
    // Locked read-modify-write: without this, two near-simultaneous saves (autosave + a manual
    // click, or two open tabs) can both read the same pre-image and the second save silently
    // discards the first's changes. The lock serializes them so the second read sees the first's write.
    let notify: 'first_submission' | 'resubmission' | null = null;
    let justConnected = false;
    const saved = await this.courseProjectRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(CourseProjectEntry);
      let entry = await repo.findOne({
        where: { userId },
        order: { updatedAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) entry = repo.create({ userId });
      const patched = this.applyCourseProjectPatch(entry, dto);
      notify = patched.notify;
      justConnected = patched.justConnected;
      return repo.save(patched.entry);
    });
    await this.syncCourseProjectInvites(saved, userId);
    await this.notifyCourseworkTransition(saved, notify);
    if (justConnected) await this.notifyCourseworkConnected(saved);
    const [annotated] = await this.courseProjectAnnotate([saved]);
    return annotated;
  }

  /** Postgres JSONB match: does this entry's studentInfo.groupMembers list include userEmailNorm,
   * AND has that exact (entry, email) pair been through a real accept — not just typed by the
   * owner? Both conditions must hold, so removing someone from the list revokes their access even
   * if their invite row stays accepted. groupMembers elements may be a plain string (legacy) or
   * {name, email} — jsonb_typeof guards the ->>'email' lookup so legacy string entries don't error
   * the whole query. */
  private static readonly TEAM_MEMBER_EMAIL_MATCH = `(
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE("studentInfo"->'groupMembers', '[]'::jsonb)) AS gm
        WHERE jsonb_typeof(gm) = 'object'
          AND LOWER(TRIM(COALESCE(gm->>'email', ''))) = :teamEmail
      )
      AND EXISTS (
        SELECT 1 FROM team_member_invites ti
        WHERE ti."entryId" = e.id::text AND ti.kind = 'course_project'
          AND ti.status = 'accepted' AND ti.email = :teamEmail
      )
    )`;

  /** One student can have many coursework reports (one per assignment) — this is their own deck, plus any
   * teammate's report they were named on by email and have accepted (drafts included so the team
   * can finish the same in-progress record together). */
  async listCourseProjects(userId: string, userEmail?: string) {
    const email = (userEmail || '').trim().toLowerCase();
    const qb = this.courseProjectRepo
      .createQueryBuilder('e')
      .where('e."userId" = :userId', { userId });
    if (email) {
      qb.orWhere(`(${PathsService.TEAM_MEMBER_EMAIL_MATCH})`, { teamEmail: email });
    }
    const entries = await qb.orderBy('e."updatedAt"', 'DESC').getMany();
    const annotated = await this.courseProjectAnnotate(entries);
    const withRanks = await this.attachLiveCourseworkRanks(annotated);
    return withRanks.map((e) => ({ ...e, isOwner: e.userId === userId }));
  }

  async createCourseProject(userId: string) {
    const saved = await this.courseProjectRepo.save(
      this.courseProjectRepo.create({ userId }),
    );
    return { ...saved, isOwner: true };
  }

  /** Owner gets full access at any stage; a named team member who has accepted (or was auto-connected
   * as a registered student) can read and edit the same record, including drafts. */
  async getCourseProjectByIdForUser(userId: string, userEmail: string, id: string) {
    const email = (userEmail || '').trim().toLowerCase();
    const qb = this.courseProjectRepo
      .createQueryBuilder('e')
      .where('e.id = :id', { id })
      .andWhere(
        new Brackets((b) => {
          b.where('e."userId" = :userId', { userId });
          if (email) {
            b.orWhere(`(${PathsService.TEAM_MEMBER_EMAIL_MATCH})`, { teamEmail: email });
          }
        }),
      );
    const entry = await qb.getOne();
    if (!entry) throw new NotFoundException('Course project entry not found');
    const [annotated] = await this.courseProjectAnnotate([entry]);
    const [withRank] = await this.attachLiveCourseworkRanks([annotated]);
    return { ...withRank, isOwner: entry.userId === userId };
  }

  private async canEditCourseProject(
    entry: CourseProjectEntry,
    userId: string,
    userEmail?: string,
  ): Promise<boolean> {
    if (entry.userId === userId) return true;
    const email = (userEmail || '').trim().toLowerCase();
    if (!email) return false;
    if (!this.extractMemberEmails(entry.studentInfo?.groupMembers).includes(email)) {
      return false;
    }
    const invite = await this.teamMemberInviteRepo.findOne({
      where: { kind: 'course_project', entryId: entry.id, email, status: 'accepted' },
    });
    return !!invite;
  }

  async updateCourseProjectByIdForUser(
    userId: string,
    id: string,
    dto: UpdateCourseProjectDto,
    userEmail?: string,
  ) {
    // Same locked read-modify-write as upsertCourseProject — see comment there.
    let notify: 'first_submission' | 'resubmission' | null = null;
    let justConnected = false;
    const saved = await this.courseProjectRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(CourseProjectEntry);
      const entry = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) throw new NotFoundException('Course project entry not found');
      if (!(await this.canEditCourseProject(entry, userId, userEmail))) {
        throw new NotFoundException('Course project entry not found');
      }
      const patched = this.applyCourseProjectPatch(entry, dto);
      notify = patched.notify;
      justConnected = patched.justConnected;
      return repo.save(patched.entry);
    });
    await this.syncCourseProjectInvites(saved, saved.userId);
    await this.notifyCourseworkTransition(saved, notify);
    if (justConnected) await this.notifyCourseworkConnected(saved);
    const [annotated] = await this.courseProjectAnnotate([saved]);
    return { ...annotated, isOwner: saved.userId === userId };
  }

  async deleteCourseProjectByIdForUser(userId: string, id: string) {
    // Delete is owner-only regardless — the final .delete({id, userId}) call below enforces
    // that on its own, so no team-member email is needed for this existence/status check.
    const entry = await this.getCourseProjectByIdForUser(userId, '', id);
    if (entry.status === 'submitted') {
      throw new NotFoundException('Submitted reports cannot be deleted');
    }
    await this.courseProjectRepo.delete({ id, userId });
  }

  /** Cards from students this teacher supervises — matched on the email they entered in step 1, scoped to submitted reports only. */
  async listCourseProjectsForTeacher(teacherEmail: string) {
    const email = teacherEmail.trim().toLowerCase();
    if (!email) return [];
    const entries = await this.courseProjectRepo.find({
      where: { status: 'submitted' },
      order: { updatedAt: 'DESC' },
    });
    const matched = entries.filter(
      (e) => (e.studentInfo?.teacherEmail || '').trim().toLowerCase() === email,
    );
    const annotated = await this.courseProjectAnnotate(matched);
    return this.attachStudents(await this.attachLiveCourseworkRanks(annotated));
  }

  /** Draft cards from students this teacher supervises — same scoping as
   * listCourseProjectsForTeacher, but for records that haven't been submitted yet, so faculty can
   * nudge stalled students. */
  async listInProgressCourseProjectsForTeacher(teacherEmail: string) {
    const email = teacherEmail.trim().toLowerCase();
    if (!email) return [];
    const entries = await this.courseProjectRepo.find({
      where: { status: 'draft' },
      order: { updatedAt: 'DESC' },
    });
    const matched = entries.filter(
      (e) => (e.studentInfo?.teacherEmail || '').trim().toLowerCase() === email,
    );
    const annotated = await this.courseProjectAnnotate(matched);
    return this.attachStudents(annotated);
  }

  /** The university showcase deck — reports from students linked to this university org, either
   * formally (organizationId) or by the university name they entered in step 1. Same scoping
   * approach as the university analytics endpoint, so the two stay consistent. Defaults to
   * submitted-only (the existing showcase); pass 'draft' for the in-progress companion view. */
  async listCourseProjectsForUniversity(organizationId: string, status: 'draft' | 'submitted' = 'submitted') {
    const org = await this.organizationsRepo.findOne({
      where: { id: organizationId },
    });
    if (!org) return [];
    const orgNameNorm = org.name.trim().toLowerCase();
    const entries = await this.courseProjectRepo
      .createQueryBuilder('e')
      .leftJoin('users', 'u', 'u.id::text = e."userId"')
      .where('e.status = :status', { status })
      .andWhere(
        new Brackets((b) => {
          b.where('u."organizationId"::text = :orgId', { orgId: organizationId }).orWhere(
            `LOWER(TRIM(COALESCE(e."studentInfo"->>'universityName', ''))) = :orgNameNorm`,
            { orgNameNorm },
          );
        }),
      )
      .orderBy('e."updatedAt"', 'DESC')
      .getMany();
    const annotated = await this.courseProjectAnnotate(entries);
    return this.attachStudents(await this.attachLiveCourseworkRanks(annotated));
  }

  async listCourseProjectsForAdmin(status?: 'draft' | 'submitted') {
    const entries = await this.courseProjectRepo.find({
      where: status ? { status } : {},
      order: { updatedAt: 'DESC' },
    });
    if (!entries.length) return [];

    const annotated = await this.attachLiveCourseworkRanks(
      await this.courseProjectAnnotate(entries),
    );
    const users = await this.usersRepo.find({
      where: { id: In(entries.map((e) => e.userId)) },
      select: ['id', 'name', 'email', 'institution', 'department'],
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    return annotated.map(
      (entry) =>
        ({
          ...entry,
          student: userById.get(entry.userId) ?? null,
        }) as CourseProjectEntry & { student: User | null },
    );
  }

  async getCourseProjectForAdmin(id: string) {
    const entry = await this.courseProjectRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException('Course project entry not found');
    const [annotated] = await this.attachLiveCourseworkRanks(
      await this.courseProjectAnnotate([entry]),
    );
    const student = await this.usersRepo.findOne({
      where: { id: entry.userId },
      select: ['id', 'name', 'email', 'institution', 'department'],
    });
    return { ...annotated, student: student ?? null };
  }

  /** Live rank preview for approved cards that do not yet have a published meritRibbon.
   * Published faculty/university ribbons stay untouched. Rank is computed in-memory from the
   * same rubric as the Merit Model and never persisted. */
  private async attachLiveCourseworkRanks<T extends CourseProjectEntry>(
    entries: T[],
  ): Promise<T[]> {
    const needRank = entries.filter(
      (e) =>
        e.status === 'submitted' &&
        e.facultyApprovalStatus === 'approved' &&
        !e.meritRibbon,
    );
    if (!needRank.length) return entries;

    const pool = await this.courseProjectRepo.find({
      where: { status: 'submitted', facultyApprovalStatus: 'approved' },
    });
    const groups = new Map<string, CourseProjectEntry[]>();
    for (const e of pool) {
      const key =
        (e.studentInfo?.universityName || '').trim().toLowerCase() || '__ciel__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }

    const liveById = new Map<
      string,
      NonNullable<CourseProjectEntry['meritRibbon']>
    >();
    for (const [key, group] of groups) {
      const ranked = group.map((e) => computeMeritCard(e)).sort(byMerit);
      const of = ranked.length;
      const scope =
        key === '__ciel__'
          ? 'CIEL PK live'
          : `${group[0]?.studentInfo?.universityName || 'University'} live`;
      ranked.forEach((card, i) => {
        const rank = i + 1;
        liveById.set(card.id, {
          rank,
          of,
          scope,
          total: card.scorecard.total,
          badgeLevel: PathsService.computeRankBadgeLevel(rank, of),
          previousRank: null,
          at: new Date().toISOString(),
        });
      });
    }

    return entries.map((e) => {
      if (e.meritRibbon) return e;
      const live = liveById.get(e.id);
      return live ? { ...e, meritRibbon: live } : e;
    });
  }

  /** The Merit Model — 100pt, 7-criterion rubric ranking of eligible (submitted + faculty-approved)
   * Course Project entries. The base pool and which filters apply are scoped by the caller's real
   * role, reusing the same scoping as listCourseProjectsForTeacher/University/Admin above rather
   * than a client-selectable role switch. */
  async getCourseProjectMeritModel(
    user: { role: string; email: string; organizationId?: string },
    filters: MeritModelQueryDto,
  ) {
    const role = user.role;
    let pool: Array<CourseProjectEntry & { student: User | null }> = [];
    let scopeLabel = 'No scope';
    const honorsWideFilters =
      role === UserRole.UNIVERSITY || role === UserRole.ORGANIZATION_ADMIN || role === UserRole.SUPER_ADMIN;
    const graderRuns = await this.peekGraderRunUsage('coursework', user);

    if (role === UserRole.FACULTY) {
      pool = await this.listCourseProjectsForTeacher(user.email);
      scopeLabel = 'Faculty supervision';
    } else if (role === UserRole.UNIVERSITY || role === UserRole.ORGANIZATION_ADMIN) {
      if (user.organizationId) {
        pool = await this.listCourseProjectsForUniversity(user.organizationId);
        const org = await this.organizationsRepo.findOne({ where: { id: user.organizationId } });
        scopeLabel = org?.name ?? 'University';
      }
    } else if (role === UserRole.SUPER_ADMIN) {
      if (filters.university) {
        pool = await this.listCourseProjectsForUniversity(filters.university);
        const org = await this.organizationsRepo.findOne({ where: { id: filters.university } });
        scopeLabel = org?.name ?? 'CIEL — all universities';
      } else {
        pool = await this.listCourseProjectsForAdmin('submitted');
        scopeLabel = 'CIEL — all universities';
      }
    } else {
      return {
        scope: { role, label: scopeLabel, mode: filters.mode ?? 'overall', filters: {} },
        cohortAverage: 0,
        count: 0,
        entries: [],
        graderRuns,
      };
    }

    // Eligibility gate — only faculty-approved, submitted entries count toward the Merit Model.
    let eligible = pool.filter((e) => e.facultyApprovalStatus === 'approved');

    if (honorsWideFilters) {
      if (filters.discipline) {
        const target = filters.discipline.trim().toLowerCase();
        eligible = eligible.filter((e) => (e.studentInfo?.disciplineName || '').trim().toLowerCase() === target);
      }
      if (filters.faculty) {
        const target = filters.faculty.trim().toLowerCase();
        eligible = eligible.filter((e) => (e.studentInfo?.teacherEmail || '').trim().toLowerCase() === target);
      }
      if (filters.year) {
        eligible = eligible.filter((e) => String(deriveMeritYear(e)) === filters.year);
      }
      if (filters.teamType) {
        const wantsInterdisciplinary = filters.teamType === 'interdisciplinary';
        eligible = eligible.filter(
          (e) => (e.studentInfo?.teamMode === 'Interdisciplinary team') === wantsInterdisciplinary,
        );
      }
    }
    if (filters.semesterFrom || filters.semesterTo) {
      const from = filters.semesterFrom ? parseInt(filters.semesterFrom.replace(/\D/g, ''), 10) : -Infinity;
      const to = filters.semesterTo ? parseInt(filters.semesterTo.replace(/\D/g, ''), 10) : Infinity;
      eligible = eligible.filter((e) => {
        const sem = parseInt((e.studentInfo?.semester || '').replace(/\D/g, ''), 10);
        return !Number.isNaN(sem) && sem >= from && sem <= to;
      });
    }

    const mode: 'overall' | 'discipline' = filters.mode === 'discipline' ? 'discipline' : 'overall';
    const cards = eligible.map((e) => ({ ...computeMeritCard(e), student: e.student }));
    const cohortAverage = cards.length
      ? Math.round(cards.reduce((sum, c) => sum + c.scorecard.total, 0) / cards.length)
      : 0;
    const appliedFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));

    if (mode === 'discipline') {
      const groups = new Map<string, typeof cards>();
      for (const card of cards) {
        const key = card.discipline || 'Unspecified';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(card);
      }
      const rankedGroups = [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([discipline, groupCards]) => {
          const sorted = [...groupCards].sort(byMerit);
          const ranked: RankedMeritCard[] = sorted.map((card, i) => ({ ...card, rank: i + 1, isTopPick: i === 0 }));
          return { discipline, count: ranked.length, entries: ranked };
        });
      return {
        scope: { role, label: scopeLabel, mode, filters: appliedFilters },
        cohortAverage,
        count: cards.length,
        groups: rankedGroups,
        graderRuns,
      };
    }

    const sorted = [...cards].sort(byMerit);
    // Overall mode highlights the top 10 as AI picks (matches the prototype's `ranked && i<10`);
    // discipline mode above highlights only the #1 pick per group (matches its `j===0`).
    const ranked: RankedMeritCard[] = sorted.map((card, i) => ({ ...card, rank: i + 1, isTopPick: i < 10 }));
    return {
      scope: { role, label: scopeLabel, mode, filters: appliedFilters },
      cohortAverage,
      count: ranked.length,
      entries: ranked,
      graderRuns,
    };
  }

  /** Which grader-run scope (and key) this caller consumes against — null means unlimited (CIEL/admin). */
  private resolveGraderRunScope(user: {
    role: string;
    email: string;
    organizationId?: string;
  }): { scope: PathGraderRunScope; key: string } | null {
    if (user.role === UserRole.FACULTY) {
      return { scope: 'faculty', key: (user.email || '').trim().toLowerCase() };
    }
    if ((user.role === UserRole.UNIVERSITY || user.role === UserRole.ORGANIZATION_ADMIN) && user.organizationId) {
      return { scope: 'university', key: user.organizationId };
    }
    return null;
  }

  /** Read-only peek at this caller's grader-run usage for one path — never creates/increments a row. */
  private async peekGraderRunUsage(
    pathKind: PathGraderRunKind,
    user: { role: string; email: string; organizationId?: string },
  ): Promise<{ unlimited: boolean; used: number; limit: number }> {
    const resolved = this.resolveGraderRunScope(user);
    if (!resolved) return { unlimited: true, used: 0, limit: 0 };
    const academicYear = new Date().getFullYear();
    const row = await this.graderRunRepo.findOne({
      where: { pathKind, scope: resolved.scope, scopeKey: resolved.key, academicYear },
    });
    return { unlimited: false, used: row?.runCount ?? 0, limit: 3 };
  }

  /** Checks and atomically consumes one grader run for this caller's pathKind+scope+year — throws
   * GRADER_RUNS_EXHAUSTED (403) once the cap of 3/year is reached. CIEL/admin is unlimited. Each
   * path (coursework/fyp/startup) has its own independent counter. */
  private async checkAndConsumeGraderRun(
    pathKind: PathGraderRunKind,
    user: { role: string; email: string; organizationId?: string },
  ): Promise<{ unlimited: boolean; used: number; limit: number }> {
    const resolved = this.resolveGraderRunScope(user);
    if (!resolved) return { unlimited: true, used: 0, limit: 0 };
    const academicYear = new Date().getFullYear();
    const limit = 3;
    // Locked read-modify-write — without this, two near-simultaneous "Run" clicks from the same
    // pathKind+scope+year can both read the same pre-image and both save runCount+1, undercounting by one.
    const runCount = await this.graderRunRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(PathGraderRun);
      let row = await repo.findOne({
        where: { pathKind, scope: resolved.scope, scopeKey: resolved.key, academicYear },
        lock: { mode: 'pessimistic_write' },
      });
      const used = row?.runCount ?? 0;
      if (used >= limit) {
        throw new ForbiddenException({
          success: false,
          code: 'GRADER_RUNS_EXHAUSTED',
          message: `No AI Grader runs left this year (used ${used} of ${limit}). Runs reset next academic year.`,
          used,
          limit,
        });
      }
      if (!row) {
        row = repo.create({ pathKind, scope: resolved.scope, scopeKey: resolved.key, academicYear, runCount: 0 });
      }
      row.runCount = used + 1;
      row.lastRunAt = new Date();
      const saved = await repo.save(row);
      return saved.runCount;
    });
    return { unlimited: false, used: runCount, limit };
  }

  /** Notify owners of analyzer top-picks. Only ids in this caller's eligible (approved) pool are sent — a faculty member cannot notify another cohort. Ranks come from the UI so filtered runs match what students see. */
  async notifyCourseProjectMeritRanks(
    user: { role: string; email: string; organizationId?: string },
    dto: NotifyMeritRanksDto,
  ) {
    const model = await this.getCourseProjectMeritModel(user, {});
    const ranked: RankedMeritCard[] = Array.isArray(model.entries)
      ? model.entries
      : Array.isArray((model as { groups?: { entries: RankedMeritCard[] }[] }).groups)
        ? (model as { groups: { entries: RankedMeritCard[] }[] }).groups.flatMap((g) => g.entries)
        : [];
    const allowed = new Set(ranked.map((c) => c.id));
    const scope = (dto.scopeLabel || model.scope?.label || 'this ranking').trim();
    const picks = (dto.picks?.length
      ? dto.picks
      : (dto.entryIds || []).map((entryId, i) => ({ entryId, rank: i + 1, of: ranked.length, total: undefined as number | undefined }))
    )
      .filter((p) => p.entryId && allowed.has(p.entryId))
      .slice(0, 3);
    const graderRuns = picks.length
      ? await this.checkAndConsumeGraderRun('coursework', user)
      : await this.peekGraderRunUsage('coursework', user);
    const seen = new Set<string>();
    let sent = 0;
    for (const pick of picks) {
      if (seen.has(pick.entryId)) continue;
      seen.add(pick.entryId);
      const entry = await this.courseProjectRepo.findOne({ where: { id: pick.entryId } });
      if (!entry || entry.facultyApprovalStatus !== 'approved') continue;
      const of = pick.of || ranked.length;
      const rank = pick.rank;
      const previousRank = entry.meritRibbon?.rank ?? null;
      const badgeLevel = PathsService.computeRankBadgeLevel(rank, of);
      const ribbon = { rank, of, scope, total: pick.total, badgeLevel, previousRank, at: new Date().toISOString() };
      const already =
        entry.meritRibbon?.rank === rank &&
        entry.meritRibbon?.of === of &&
        entry.meritRibbon?.scope === scope;
      entry.meritRibbon = ribbon;
      await this.courseProjectRepo.save(entry);
      if (already) {
        sent += 1;
        continue;
      }
      const first = entry.studentInfo?.studentName?.split(' ')[0] || 'there';
      const title = entry.projectTitle || 'Untitled';
      try {
        await this.notificationsService.createNotification(entry.userId, {
          type: 'update',
          title: `Your coursework ranked #${rank}`,
          message: `${first}, your coursework “${title}” ranked #${rank} of ${of} in ${scope} (${badgeLevel}). Open Coursework → My Impact Wall to see the ribbon.`,
        });
        const student = await this.usersRepo.findOne({ where: { id: entry.userId }, select: ['email'] });
        if (student?.email) {
          await this.mailService.sendCourseworkRankNotification(
            student.email,
            first,
            title,
            rank,
            of,
            scope,
            badgeLevel,
            previousRank,
          );
        }
        sent += 1;
      } catch (err) {
        this.logger.warn(`Merit rank notification failed for ${entry.id}: ${(err as Error).message}`);
      }
    }
    return { notified: sent, scope, graderRuns };
  }

  /** Rank badge tier shared by Coursework/FYP/Startup ribbons — a display label derived purely
   * from rank/of, no separate score:
   *  top 10% of the ranked pool     -> Gold
   *  top 30%                        -> Silver
   *  top 60%                        -> Bronze
   *  everyone else in a ranked pick -> Participant
   * Percentile is rank/of so rank 1 of a small cohort still lands correctly (e.g. of=2 -> rank1 Gold, rank2 Bronze). */
  private static computeRankBadgeLevel(
    rank: number,
    of: number,
  ): 'Gold' | 'Silver' | 'Bronze' | 'Participant' {
    if (!rank || !of || rank <= 0 || of <= 0) return 'Participant';
    const percentile = rank / of;
    if (percentile <= 0.1) return 'Gold';
    if (percentile <= 0.3) return 'Silver';
    if (percentile <= 0.6) return 'Bronze';
    return 'Participant';
  }

  /** Public, unauthenticated badge-verification lookup for a coursework entry's QR/share link —
   * mirrors StudentReport's getPublicImpactReportVerification. PII-minimal: no student name/email
   * on the verified branch, matching that precedent. */
  async getPublicCourseworkVerification(verificationKey: string) {
    const key = (verificationKey || '').trim();
    if (!key) throw new NotFoundException('Verification link not found');
    let entry = await this.courseProjectRepo.findOne({ where: { verificationPublicSlug: key } });
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
    if (!entry && isUuid) {
      entry = await this.courseProjectRepo.findOne({ where: { id: key } });
    }
    if (!entry) throw new NotFoundException('Verification link not found');
    if (entry.facultyApprovalStatus !== 'approved') {
      return { success: true, verified: false, status: entry.facultyApprovalStatus };
    }
    return {
      success: true,
      verified: true,
      project_title: entry.projectTitle || 'Untitled coursework',
      badge_level: entry.meritRibbon?.badgeLevel ?? null,
      rank: entry.meritRibbon?.rank ?? null,
      of: entry.meritRibbon?.of ?? null,
      scope: entry.meritRibbon?.scope ?? null,
      verification_code: formatCertificateVerificationCode(entry.verificationPublicSlug),
      verified_at: entry.facultyApprovalAt,
    };
  }

  private async attachStudents<T extends { userId: string }>(entries: T[]) {
    if (!entries.length) return [];
    const users = await this.usersRepo.find({
      where: { id: In(entries.map((e) => e.userId)) },
      select: ['id', 'name', 'email', 'institution', 'department'],
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return entries.map((entry) => ({
      ...entry,
      student: userById.get(entry.userId) ?? null,
    }));
  }

  private enrichFypForAdmin(entry: FypEntry) {
    const total = entry.milestones?.length || DEFAULT_FYP_MILESTONES.length;
    const complete =
      entry.milestones?.filter((m) => m.status === 'complete').length ?? 0;
    // The 9-step guided wizard never touches `milestones` — once a student has used it
    // (stepCompleted > 0 or submitted), it's the source of truth for admin progress instead
    // of the frozen legacy timeline. Entries never opened in the new wizard still fall back
    // to the milestone-based calculation for backward compatibility.
    const usesWizard = entry.stepCompleted > 0 || entry.status === 'submitted';
    const wizardTotalSteps = 9; // must match the frontend FYP wizard's STEPS.length
    return {
      ...entry,
      milestonesComplete: complete,
      milestonesTotal: total,
      deliverablesCount: entry.deliverables?.length ?? 0,
      wizardStepsComplete: usesWizard ? entry.stepCompleted : null,
      wizardStepsTotal: usesWizard ? wizardTotalSteps : null,
      progressStatus: usesWizard
        ? (entry.status === 'submitted'
            ? ('complete' as const)
            : ('in_progress' as const))
        : complete >= total && total > 0
          ? ('complete' as const)
          : ('in_progress' as const),
    };
  }

  async listFypForAdmin(progress?: 'complete' | 'in_progress') {
    const entries = await this.fypRepo.find({ order: { updatedAt: 'DESC' } });
    const annotated = await this.fypAnnotate(entries);
    const enriched = annotated.map((entry) => this.enrichFypForAdmin(entry));
    const filtered = progress
      ? enriched.filter((entry) => entry.progressStatus === progress)
      : enriched;
    return this.attachStudents(filtered);
  }

  async getFypForAdmin(id: string) {
    const entry = await this.fypRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException('FYP entry not found');
    const [annotated] = await this.fypAnnotate([entry]);
    const [withStudent] = await this.attachStudents([
      this.enrichFypForAdmin(annotated),
    ]);
    return withStudent;
  }

  private enrichVentureForAdmin(entry: VentureEntry) {
    return {
      ...entry,
      completenessPercent: ventureCompletenessPercent(entry),
      missingItems: ventureMissingItems(entry),
      gates: computeVentureGates(entry),
    };
  }

  async listVenturesForAdmin(visibility?: 'visible' | 'private') {
    const where =
      visibility === 'visible'
        ? { isVisible: true }
        : visibility === 'private'
          ? { isVisible: false }
          : {};
    const entries = await this.ventureRepo.find({
      where,
      order: { updatedAt: 'DESC' },
    });
    const annotated = await this.ventureAnnotate(entries);
    const enriched = annotated.map((entry) => this.enrichVentureForAdmin(entry));
    return this.attachStudents(enriched);
  }

  async getVentureForAdmin(id: string) {
    const entry = await this.ventureRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException('Venture entry not found');
    const [annotated] = await this.ventureAnnotate([entry]);
    const [withStudent] = await this.attachStudents([
      this.enrichVentureForAdmin(annotated),
    ]);
    return withStudent;
  }

  // ---------- FYP / Thesis ----------

  private fypAnnotate(entries: FypEntry[]) {
    return this.annotateInviteStatus(
      entries,
      'fyp',
      (e) => e.projectInfo?.teamMembers,
      (e, members) => ({
        ...e,
        projectInfo: { ...e.projectInfo, teamMembers: members } as FypProjectInfo,
      }),
    );
  }

  private async syncFypInvites(entry: FypEntry, invitedByUserId: string) {
    await this.syncTeamInvites(
      'fyp',
      entry.id,
      invitedByUserId,
      entry.projectInfo?.studentName || 'A fellow student',
      'FYP / Thesis',
      entry.projectTitle || entry.projectInfo?.title || 'an FYP / Thesis record',
      entry.projectInfo?.teamMembers,
    );
  }

  /** Same jsonb email-match pattern as Course Project's TEAM_MEMBER_EMAIL_MATCH, scoped to
   * projectInfo.teamMembers instead of studentInfo.groupMembers, and gated the same way on a real
   * accepted invite rather than just the typed string. */
  private static readonly FYP_TEAM_MEMBER_EMAIL_MATCH = `(
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE("projectInfo"->'teamMembers', '[]'::jsonb)) AS tm
        WHERE jsonb_typeof(tm) = 'object'
          AND LOWER(TRIM(COALESCE(tm->>'email', ''))) = :teamEmail
      )
      AND EXISTS (
        SELECT 1 FROM team_member_invites ti
        WHERE ti."entryId" = e.id::text AND ti.kind = 'fyp'
          AND ti.status = 'accepted' AND ti.email = :teamEmail
      )
    )`;

  /** FYP is one record per student — a co-author with no record of their own sees the lead's
   * record on their own dashboard instead (read-only), same drafts-included visibility as
   * Course Project's team-sharing (listCourseProjects), gated on a real accepted invite. A
   * teammate added while the lead is still drafting should be able to track progress, not wait
   * until submission to even discover the record exists. A student's own record always takes
   * priority. */
  async getFyp(userId: string, userEmail?: string) {
    const own = await this.fypRepo.findOne({ where: { userId } });
    if (own) {
      const [annotated] = await this.fypAnnotate([own]);
      return { ...annotated, isOwner: true };
    }
    const email = (userEmail || '').trim().toLowerCase();
    if (!email) return null;
    const shared = await this.fypRepo
      .createQueryBuilder('e')
      .where(PathsService.FYP_TEAM_MEMBER_EMAIL_MATCH, { teamEmail: email })
      .getOne();
    if (!shared) return null;
    const [annotated] = await this.fypAnnotate([shared]);
    return { ...annotated, isOwner: false };
  }

  /** The faculty supervision deck — submitted FYP records naming this supervisor by email, same
   * scoping as listCourseProjectsForTeacher. */
  async listFypForTeacher(supervisorEmail: string) {
    const email = supervisorEmail.trim().toLowerCase();
    if (!email) return [];
    const entries = await this.fypRepo.find({
      where: { status: 'submitted' },
      order: { updatedAt: 'DESC' },
    });
    const matched = entries.filter(
      (e) => (e.projectInfo?.supervisorEmail || '').trim().toLowerCase() === email,
    );
    const annotated = await this.fypAnnotate(matched);
    return this.attachStudents(annotated);
  }

  /** The university showcase deck — submitted FYP records from students formally affiliated with
   * this university org (via their account's organizationId). Unlike Course Project, FYP has no
   * free-text university-name field on the entry itself to fall back on. */
  async listFypForUniversity(organizationId: string, status: 'draft' | 'submitted' = 'submitted') {
    const org = await this.organizationsRepo.findOne({
      where: { id: organizationId },
    });
    if (!org) return [];
    const entries = await this.fypRepo
      .createQueryBuilder('e')
      .leftJoin('users', 'u', 'u.id::text = e."userId"')
      .where('e.status = :status', { status })
      .andWhere('u."organizationId"::text = :orgId', { orgId: organizationId })
      .orderBy('e."updatedAt"', 'DESC')
      .getMany();
    const annotated = await this.fypAnnotate(entries);
    return this.attachStudents(annotated);
  }

  async upsertFyp(userId: string, dto: UpdateFypDto) {
    // Locked read-modify-write — see comment on upsertCourseProject for why this matters.
    let justConnected = false;
    const saved = await this.fypRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(FypEntry);
      let entry = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry)
        entry = repo.create({ userId, milestones: DEFAULT_FYP_MILESTONES });
      const hadSupervisorEmail = !!(entry.projectInfo?.supervisorEmail || '').trim();
      if (dto.projectTitle !== undefined)
        entry.projectTitle = dto.projectTitle;
      if (dto.overview !== undefined) entry.overview = dto.overview;
      if (dto.milestones !== undefined) entry.milestones = dto.milestones;
      if (dto.communityLinkage !== undefined)
        entry.communityLinkage = dto.communityLinkage;
      // 9-step guided wizard — frontend sends each group fully merged, so a straight assign is safe.
      if (dto.projectInfo !== undefined)
        entry.projectInfo = dto.projectInfo as FypProjectInfo;
      if (dto.background !== undefined) entry.background = dto.background;
      if (dto.objectivesInfo !== undefined)
        entry.objectivesInfo = dto.objectivesInfo;
      if (dto.literature !== undefined) entry.literature = dto.literature;
      if (dto.methodology !== undefined) entry.methodology = dto.methodology;
      if (dto.findings !== undefined) entry.findings = dto.findings;
      if (dto.routeDetails !== undefined) entry.routeDetails = dto.routeDetails;
      if (dto.sdgMapping !== undefined) entry.sdgMapping = dto.sdgMapping;
      if (dto.reflectionInfo !== undefined)
        entry.reflectionInfo = dto.reflectionInfo;
      if (dto.repository !== undefined) entry.repository = dto.repository;
      if (dto.sectionSummaries !== undefined)
        entry.sectionSummaries = dto.sectionSummaries;
      if (dto.addedNote !== undefined) entry.addedNote = dto.addedNote;
      if (dto.stepCompleted !== undefined)
        entry.stepCompleted = dto.stepCompleted;
      if (dto.status !== undefined) entry.status = dto.status;
      // Editing a previously-approved record after the fact invalidates that approval — same
      // rule as Course Project's applyCourseProjectPatch, see the comment there. Same for a
      // rejected record: fix & resubmit should land as a fresh review, not stay stuck on
      // "rejected". Keep the supervisor's note so the student still sees it.
      if (entry.status === 'submitted' && entry.supervisorApprovalStatus === 'approved') {
        entry.supervisorApprovalStatus = 'pending';
        entry.supervisorApprovalNote = null;
        entry.supervisorApprovalAt = null;
        entry.meritRibbon = null;
      } else if (
        entry.status === 'submitted' &&
        (entry.supervisorApprovalStatus === 'rejected' || entry.supervisorApprovalStatus === 'revision_requested')
      ) {
        entry.supervisorApprovalStatus = 'pending';
        entry.supervisorApprovalAt = null;
        entry.meritRibbon = null;
      }
      justConnected = !hadSupervisorEmail && !!(entry.projectInfo?.supervisorEmail || '').trim();
      return repo.save(entry);
    });
    await this.syncFypInvites(saved, userId);
    if (justConnected) await this.notifyFypConnected(saved);
    const [annotated] = await this.fypAnnotate([saved]);
    return { ...annotated, isOwner: true };
  }

  /** Fires once — the moment a supervisor email is first attached to a draft FYP record, i.e. "one
   * master record, auto-connected to student + supervisor + university + CIEL PK". Best-effort: an
   * email failure here must never fail the student's autosave. */
  private async notifyFypConnected(entry: FypEntry): Promise<void> {
    const pi = entry.projectInfo || {};
    const studentName = pi.studentName?.trim() || 'Student';
    const title = entry.projectTitle || pi.title || 'Untitled FYP';
    const supervisorEmail = (pi.supervisorEmail || '').trim();
    const supervisorName = pi.supervisorName?.trim() || 'there';
    const universityName = pi.university?.trim() || undefined;
    try {
      if (supervisorEmail) {
        await this.mailService.sendPathProjectConnectedToFaculty(supervisorEmail, supervisorName, studentName, 'Final Year Project', title, '/dashboard/faculty/fyp-thesis');
      }
      const student = await this.usersRepo.findOne({ where: { id: entry.userId }, select: ['email'] });
      if (student?.email) {
        await this.mailService.sendPathProjectConnectedToStudent(student.email, studentName.split(' ')[0], 'Final Year Project', title, supervisorEmail ? supervisorName : undefined, universityName);
      }
      await this.mailService.sendPathProjectConnectedToCielPk(studentName, supervisorEmail ? supervisorName : undefined, universityName, 'Final Year Project', title);
    } catch (err) {
      this.logger.warn(`FYP connection email failed for ${entry.id}: ${(err as Error).message}`);
    }
  }

  /** Supervisor approve/reject a submitted FYP entry — only "approved" entries are eligible for
   * Merit Model ranking/showcase. Matched the same way as listFypForTeacher: the supervisor email
   * the student entered in step 1. */
  async supervisorReviewFyp(
    supervisorEmail: string,
    id: string,
    action: 'approve' | 'reject' | 'revision',
    note?: string,
  ) {
    const email = (supervisorEmail || '').trim().toLowerCase();
    if (!email) throw new NotFoundException('FYP entry not found');
    const entry = await this.fypRepo.findOne({ where: { id } });
    if (
      !entry ||
      entry.status !== 'submitted' ||
      (entry.projectInfo?.supervisorEmail || '').trim().toLowerCase() !== email
    ) {
      throw new NotFoundException('FYP entry not found');
    }
    entry.supervisorApprovalStatus =
      action === 'approve' ? 'approved' : action === 'revision' ? 'revision_requested' : 'rejected';
    entry.supervisorApprovalNote = note ?? null;
    entry.supervisorApprovalAt = new Date();
    if (action !== 'approve') entry.meritRibbon = null;
    const saved = await this.fypRepo.save(entry);
    const first = saved.projectInfo?.studentName?.split(' ')[0] || 'there';
    const title = saved.projectTitle || 'Untitled FYP';
    try {
      if (action === 'approve') {
        await this.notificationsService.createNotification(saved.userId, {
          type: 'approval',
          title: 'Your FYP was approved',
          message: `${first}, “${title}” is live. It now hangs on My Impact Wall — wait for end-of-semester ranking and badge allocation.`,
        });
      } else if (action === 'revision') {
        const extra = (note || '').trim();
        await this.notificationsService.createNotification(saved.userId, {
          type: 'update',
          title: 'Revision requested on your FYP',
          message: extra
            ? `${first}, “${title}” needs a revision before it can be approved. ${extra} Open the report, fix, and resubmit — nothing is penalised.`
            : `${first}, “${title}” needs a revision before it can be approved. Open the report, fix, and resubmit — nothing is penalised.`,
        });
      } else {
        const extra = (note || '').trim();
        await this.notificationsService.createNotification(saved.userId, {
          type: 'update',
          title: 'Your FYP was rejected',
          message: extra
            ? `${first}, “${title}” was rejected. ${extra} Open the report, fix, and resubmit — nothing is penalised.`
            : `${first}, “${title}” was rejected. Open the report, fix, and resubmit — nothing is penalised.`,
        });
      }
    } catch (err) {
      this.logger.warn(`FYP review notification failed for ${saved.id}: ${(err as Error).message}`);
    }
    return saved;
  }

  /** The FYP Merit Model — 100pt, 7-criterion route-adjusted rubric ranking of eligible (submitted +
   * supervisor-approved) FYP entries. Base pool and which filters apply are scoped by the caller's
   * real role, reusing the same scoping as listFypForTeacher/University above. */
  async getFypMeritModel(
    user: { role: string; email: string; organizationId?: string },
    filters: FypMeritModelQueryDto,
  ) {
    const role = user.role;
    let pool: Array<FypEntry & { student: User | null }> = [];
    let scopeLabel = 'No scope';
    const honorsSupervisorFilter = role !== UserRole.FACULTY;
    const graderRuns = await this.peekGraderRunUsage('fyp', user);

    if (role === UserRole.FACULTY) {
      pool = await this.listFypForTeacher(user.email);
      scopeLabel = 'Faculty supervision';
    } else if (role === UserRole.UNIVERSITY || role === UserRole.ORGANIZATION_ADMIN) {
      if (user.organizationId) {
        pool = await this.listFypForUniversity(user.organizationId);
        const org = await this.organizationsRepo.findOne({ where: { id: user.organizationId } });
        scopeLabel = org?.name ?? 'University';
      }
    } else if (role === UserRole.SUPER_ADMIN) {
      if (filters.university) {
        pool = await this.listFypForUniversity(filters.university);
        const org = await this.organizationsRepo.findOne({ where: { id: filters.university } });
        scopeLabel = org?.name ?? 'CIEL — all universities';
      } else {
        const entries = await this.fypRepo.find({
          where: { status: 'submitted' },
          order: { updatedAt: 'DESC' },
        });
        const annotated = await this.fypAnnotate(entries);
        pool = await this.attachStudents(annotated);
        scopeLabel = 'CIEL — all universities';
      }
    } else {
      return {
        scope: { role, label: scopeLabel, filters: {} },
        cohortAverage: 0,
        routeFairness: [],
        count: 0,
        entries: [],
        graderRuns,
      };
    }

    // Eligibility gate — only supervisor-approved, submitted entries count toward the Merit Model.
    let eligible = pool.filter((e) => e.supervisorApprovalStatus === 'approved');

    if (filters.route) {
      eligible = eligible.filter((e) => deriveFypRoute(e) === filters.route);
    }
    if (filters.school) {
      const target = filters.school.trim().toLowerCase();
      eligible = eligible.filter((e) => (e.projectInfo?.school || '').trim().toLowerCase() === target);
    }
    if (filters.semester) {
      const target = filters.semester.trim().toLowerCase();
      eligible = eligible.filter((e) => (e.projectInfo?.span || '').trim().toLowerCase() === target);
    }
    if (honorsSupervisorFilter && filters.supervisor) {
      const target = filters.supervisor.trim().toLowerCase();
      eligible = eligible.filter((e) => (e.projectInfo?.supervisorEmail || '').trim().toLowerCase() === target);
    }
    if (filters.year) {
      eligible = eligible.filter((e) => deriveFypCompletionMonth(e).slice(0, 4) === filters.year);
    }
    if (filters.from) {
      eligible = eligible.filter((e) => deriveFypCompletionMonth(e) >= filters.from!);
    }
    if (filters.to) {
      eligible = eligible.filter((e) => deriveFypCompletionMonth(e) <= filters.to!);
    }
    // `university` (organizationId) is only meaningful for CIEL scope — it's already applied above
    // when resolving the SUPER_ADMIN pool; for other roles it's silently ignored, matching the
    // prototype's control panel where the university dropdown is hidden entirely outside CIEL scope.

    const cards = eligible.map((e) => ({ ...computeFypMeritCard(e), student: e.student }));
    const cohortAverage = cards.length
      ? Math.round(cards.reduce((sum, c) => sum + c.scorecard.total, 0) / cards.length)
      : 0;

    const appliedFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));
    const sorted = [...cards].sort(byFypMerit);
    const ranked: RankedFypMeritCard[] = sorted.map((card, i) => ({
      ...card,
      rank: i + 1,
      isTopPick: i < 10,
    }));

    // Route-fairness averages — built from the merit-sorted list, same first-seen insertion order
    // as the prototype's `F.forEach` (which runs after `F.sort(...)`), not re-sorted by average.
    const routeTotals = new Map<string, number[]>();
    for (const card of sorted) {
      if (!routeTotals.has(card.route)) routeTotals.set(card.route, []);
      routeTotals.get(card.route)!.push(card.scorecard.total);
    }
    const routeFairness = [...routeTotals.entries()].map(([route, totals]) => ({
      route,
      average: Math.round(totals.reduce((s, t) => s + t, 0) / totals.length),
      count: totals.length,
    }));

    return {
      scope: { role, label: scopeLabel, filters: appliedFilters },
      cohortAverage,
      routeFairness,
      count: ranked.length,
      entries: ranked,
      graderRuns,
    };
  }

  /** Notify owners of FYP merit-model top-picks. Mirrors notifyCourseProjectMeritRanks exactly —
   * only ids in this caller's eligible (approved) pool are sent, ranks come from the UI. */
  async notifyFypMeritRanks(
    user: { role: string; email: string; organizationId?: string },
    dto: NotifyMeritRanksDto,
  ) {
    const model = await this.getFypMeritModel(user, {});
    const ranked: RankedFypMeritCard[] = Array.isArray(model.entries) ? model.entries : [];
    const allowed = new Set(ranked.map((c) => c.id));
    const scope = (dto.scopeLabel || model.scope?.label || 'this ranking').trim();
    const picks = (dto.picks?.length
      ? dto.picks
      : (dto.entryIds || []).map((entryId, i) => ({ entryId, rank: i + 1, of: ranked.length, total: undefined as number | undefined }))
    )
      .filter((p) => p.entryId && allowed.has(p.entryId))
      .slice(0, 3);
    const graderRuns = picks.length
      ? await this.checkAndConsumeGraderRun('fyp', user)
      : await this.peekGraderRunUsage('fyp', user);
    const seen = new Set<string>();
    let sent = 0;
    for (const pick of picks) {
      if (seen.has(pick.entryId)) continue;
      seen.add(pick.entryId);
      const entry = await this.fypRepo.findOne({ where: { id: pick.entryId } });
      if (!entry || entry.supervisorApprovalStatus !== 'approved') continue;
      const of = pick.of || ranked.length;
      const rank = pick.rank;
      const previousRank = entry.meritRibbon?.rank ?? null;
      const badgeLevel = PathsService.computeRankBadgeLevel(rank, of);
      const ribbon = { rank, of, scope, total: pick.total, badgeLevel, previousRank, at: new Date().toISOString() };
      const already =
        entry.meritRibbon?.rank === rank &&
        entry.meritRibbon?.of === of &&
        entry.meritRibbon?.scope === scope;
      entry.meritRibbon = ribbon;
      await this.fypRepo.save(entry);
      if (already) {
        sent += 1;
        continue;
      }
      const first = entry.projectInfo?.studentName?.split(' ')[0] || 'there';
      const title = entry.projectTitle || 'Untitled';
      try {
        await this.notificationsService.createNotification(entry.userId, {
          type: 'update',
          title: `Your FYP ranked #${rank}`,
          message: `${first}, your FYP “${title}” ranked #${rank} of ${of} in ${scope} (${badgeLevel}). Open FYP / Thesis → My Impact Wall to see the ribbon.`,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(`FYP merit rank notification failed for ${entry.id}: ${(err as Error).message}`);
      }
    }
    return { notified: sent, scope, graderRuns };
  }

  async addFypDeliverable(userId: string, dto: AddFypDeliverableDto) {
    // Locked so two near-simultaneous uploads can't compute the same `nextVersion` and
    // have the second save silently overwrite the first's deliverable entry.
    return this.fypRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(FypEntry);
      let entry = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry)
        entry = repo.create({ userId, milestones: DEFAULT_FYP_MILESTONES });
      const nextVersion = (entry.deliverables?.length ?? 0) + 1;
      entry.deliverables = [
        ...(entry.deliverables ?? []),
        {
          version: nextVersion,
          label: dto.label,
          fileUrl: dto.fileUrl,
          uploadedAt: new Date().toISOString(),
        },
      ];
      return repo.save(entry);
    });
  }

  // ---------- Startup / Business ----------

  private ventureAnnotate(entries: VentureEntry[]) {
    return this.annotateInviteStatus(
      entries,
      'venture',
      (e) => e.team,
      (e, members) => ({ ...e, team: members as VentureEntry['team'] }),
    );
  }

  private async syncVentureInvites(entry: VentureEntry, invitedByUserId: string) {
    await this.syncTeamInvites(
      'venture',
      entry.id,
      invitedByUserId,
      entry.academicSetup?.founderName || 'A fellow student',
      'Startup / Business',
      entry.ventureName || 'a Startup / Business venture',
      entry.team,
    );
  }

  /** Same jsonb email-match pattern as Course Project/FYP, scoped to the top-level `team` column
   * (Venture has no legacy plain-string members, so no jsonb_typeof guard is needed here). */
  private static readonly VENTURE_TEAM_MEMBER_EMAIL_MATCH = `(
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE("team", '[]'::jsonb)) AS tm
        WHERE LOWER(TRIM(COALESCE(tm->>'email', ''))) = :teamEmail
      )
      AND EXISTS (
        SELECT 1 FROM team_member_invites ti
        WHERE ti."entryId" = e.id::text AND ti.kind = 'venture'
          AND ti.status = 'accepted' AND ti.email = :teamEmail
      )
    )`;

  /** Venture is one record per student — a named teammate with no venture of their own sees the
   * founder's *submitted* venture on their own dashboard instead (read-only), gated on a real
   * accepted invite, same pattern as getFyp. A student's own record always takes priority. */
  async getVenture(userId: string, userEmail?: string) {
    const own = await this.ventureRepo.findOne({ where: { userId } });
    if (own) return { ...this.withCompleteness((await this.ventureAnnotate([own]))[0]), isOwner: true };
    const email = (userEmail || '').trim().toLowerCase();
    if (!email) return null;
    const shared = await this.ventureRepo
      .createQueryBuilder('e')
      .where(`e.status = 'submitted'`)
      .andWhere(PathsService.VENTURE_TEAM_MEMBER_EMAIL_MATCH, { teamEmail: email })
      .getOne();
    if (!shared) return null;
    const [annotated] = await this.ventureAnnotate([shared]);
    return { ...this.withCompleteness(annotated), isOwner: false };
  }

  async upsertVenture(userId: string, dto: UpdateVentureDto) {
    // Locked read-modify-write — see comment on upsertCourseProject for why this matters.
    const saved = await this.ventureRepo.manager.transaction(
      async (manager) => {
        const repo = manager.getRepository(VentureEntry);
        let entry = await repo.findOne({
          where: { userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!entry) entry = repo.create({ userId });
        if (dto.ventureName !== undefined) entry.ventureName = dto.ventureName;
        if (dto.description !== undefined) entry.description = dto.description;
        if (dto.stage !== undefined) entry.stage = dto.stage;
        if (dto.tractionRows !== undefined)
          entry.tractionRows = dto.tractionRows;
        if (dto.team !== undefined) entry.team = dto.team;
        if (dto.materialUrls !== undefined)
          entry.materialUrls = dto.materialUrls;
        // 8-step guided wizard — frontend sends each group fully merged, so a straight assign is safe.
        if (dto.academicSetup !== undefined)
          entry.academicSetup = dto.academicSetup;
        if (dto.ideaInfo !== undefined) entry.ideaInfo = dto.ideaInfo;
        if (dto.solutionInfo !== undefined)
          entry.solutionInfo = dto.solutionInfo;
        if (dto.sdgMapping !== undefined) entry.sdgMapping = dto.sdgMapping;
        if (dto.evidenceInfo !== undefined)
          entry.evidenceInfo = dto.evidenceInfo;
        if (dto.reviewPipeline !== undefined)
          entry.reviewPipeline = dto.reviewPipeline;
        if (dto.publishSettings !== undefined)
          entry.publishSettings = dto.publishSettings;
        if (dto.teamConsent !== undefined) entry.teamConsent = dto.teamConsent;
        if (dto.sectionSummaries !== undefined)
          entry.sectionSummaries = dto.sectionSummaries;
        if (dto.stepCompleted !== undefined)
          entry.stepCompleted = dto.stepCompleted;
        if (dto.status !== undefined) entry.status = dto.status;
        // Editing a previously-reviewed record after the fact invalidates that review — same rule
        // as Course Project/FYP: fix & resubmit should land as a fresh review. Keep the supervisor's
        // note so the student still sees it.
        const priorStatus = entry.reviewPipeline?.supervisorStatus;
        if (
          entry.status === 'submitted' &&
          (priorStatus === 'approved' || priorStatus === 'rejected' || priorStatus === 'revisions_requested')
        ) {
          entry.reviewPipeline = { ...entry.reviewPipeline, supervisorStatus: 'pending' };
          entry.meritRibbon = null;
        }
        // isVisible is earned, not self-toggled, once the guided wizard is in use — recomputed
        // on every save so it always reflects the current Showcase-Ready + audience state.
        entry.isVisible = deriveVentureIsVisible(entry);
        return repo.save(entry);
      },
    );
    await this.syncVentureInvites(saved, userId);
    const [annotated] = await this.ventureAnnotate([saved]);
    return this.withCompleteness(annotated);
  }

  /** Submitted ventures that name this teacher — email first, then stripped supervisor name. */
  async listVenturesForTeacher(facultyEmail: string, facultyUserId?: string) {
    const email = (facultyEmail || '').trim().toLowerCase();
    if (!email) return [];
    const faculty = facultyUserId
      ? await this.usersRepo.findOne({ where: { id: facultyUserId } })
      : await this.usersRepo.findOne({ where: { email } });
    const facultyName = faculty?.name ?? null;
    const entries = await this.ventureRepo.find({
      where: { status: 'submitted' },
      order: { updatedAt: 'DESC' },
    });
    const matched = entries.filter((e) =>
      ventureMatchesFaculty(e.academicSetup, { email, name: facultyName }),
    );
    const annotated = await this.ventureAnnotate(matched);
    const enriched = annotated.map((entry) => this.withCompleteness(entry)!);
    return this.attachStudents(enriched);
  }

  /** Supervisor approve / request-revision / reject for a submitted venture — same gate students
   * already wait on. 'revision' keeps its existing 'revisions_requested' meaning (fix & resubmit);
   * 'reject' is a genuinely new, harder terminal state — additive, not a rename. */
  async supervisorReviewVenture(
    facultyEmail: string,
    id: string,
    action: 'approve' | 'reject' | 'revision',
    note?: string,
    facultyUserId?: string,
  ) {
    const email = (facultyEmail || '').trim().toLowerCase();
    if (!email) throw new NotFoundException('Venture entry not found');
    const entry = await this.ventureRepo.findOne({ where: { id } });
    const faculty = facultyUserId
      ? await this.usersRepo.findOne({ where: { id: facultyUserId } })
      : await this.usersRepo.findOne({ where: { email } });
    if (
      !entry ||
      entry.status !== 'submitted' ||
      !ventureMatchesFaculty(entry.academicSetup, { email, name: faculty?.name ?? null })
    ) {
      throw new NotFoundException('Venture entry not found');
    }
    const supervisorStatus = action === 'approve' ? 'approved' : action === 'revision' ? 'revisions_requested' : 'rejected';
    entry.reviewPipeline = {
      ...entry.reviewPipeline,
      supervisorStatus,
      supervisorNote: action === 'approve' ? null : note?.trim() || entry.reviewPipeline?.supervisorNote || null,
    };
    entry.isVisible = deriveVentureIsVisible(entry);
    if (action !== 'approve') entry.meritRibbon = null;
    const saved = await this.ventureRepo.save(entry);
    const student = await this.usersRepo.findOne({ where: { id: saved.userId }, select: ['name'] });
    const first = student?.name?.split(' ')[0] || 'there';
    const title = saved.ventureName || 'your venture';
    try {
      if (action === 'approve') {
        await this.notificationsService.createNotification(saved.userId, {
          type: 'approval',
          title: 'Your venture was approved',
          message: `${first}, “${title}” is live. It now hangs on My Impact Wall — wait for end-of-semester ranking and badge allocation.`,
        });
      } else if (action === 'revision') {
        const extra = (note || '').trim();
        await this.notificationsService.createNotification(saved.userId, {
          type: 'update',
          title: 'Revision requested on your venture',
          message: extra
            ? `${first}, “${title}” needs a revision before it can be approved. ${extra} Open the report, fix, and resubmit — nothing is penalised.`
            : `${first}, “${title}” needs a revision before it can be approved. Open the report, fix, and resubmit — nothing is penalised.`,
        });
      } else {
        const extra = (note || '').trim();
        await this.notificationsService.createNotification(saved.userId, {
          type: 'update',
          title: 'Your venture was rejected',
          message: extra
            ? `${first}, “${title}” was rejected. ${extra} Open the report, fix, and resubmit — nothing is penalised.`
            : `${first}, “${title}” was rejected. Open the report, fix, and resubmit — nothing is penalised.`,
        });
      }
    } catch (err) {
      this.logger.warn(`Venture review notification failed for ${saved.id}: ${(err as Error).message}`);
    }
    const [annotated] = await this.ventureAnnotate([saved]);
    const [withStudent] = await this.attachStudents([this.withCompleteness(annotated)!]);
    return withStudent;
  }

  /** The Venture Merit Model — 100pt rubric ranking of eligible (submitted + supervisor-approved)
   * ventures. Phase A+B scope: faculty + CIEL only — no listVenturesForUniversity exists yet, so
   * university/org-admin roles fall through to the same empty "No scope" shape Coursework/FYP use
   * elsewhere. Follow-on: add university scoping once that listing method exists. */
  async getVentureMeritModel(
    user: { role: string; email: string; organizationId?: string },
    _filters: VentureMeritModelQueryDto,
  ) {
    const role = user.role;
    let pool: Array<VentureEntry & { student: User | null }> = [];
    let scopeLabel = 'No scope';
    const graderRuns = await this.peekGraderRunUsage('startup', user);

    if (role === UserRole.FACULTY) {
      pool = await this.listVenturesForTeacher(user.email);
      scopeLabel = 'Faculty supervision';
    } else if (role === UserRole.SUPER_ADMIN) {
      pool = await this.listVenturesForAdmin();
      scopeLabel = 'CIEL — all universities';
    } else {
      return {
        scope: { role, label: scopeLabel, filters: {} },
        cohortAverage: 0,
        count: 0,
        entries: [],
        graderRuns,
      };
    }

    // Eligibility gate — only supervisor-approved, submitted entries count toward the Merit Model.
    const eligible = pool.filter((e) => e.reviewPipeline?.supervisorStatus === 'approved');

    const cards = eligible.map((e) => ({ ...computeVentureMeritCard(e), student: e.student }));
    const cohortAverage = cards.length
      ? Math.round(cards.reduce((sum, c) => sum + c.scorecard.total, 0) / cards.length)
      : 0;
    const sorted = [...cards].sort(byVentureMerit);
    const ranked: RankedVentureMeritCard[] = sorted.map((card, i) => ({ ...card, rank: i + 1, isTopPick: i < 10 }));

    return {
      scope: { role, label: scopeLabel, filters: {} },
      cohortAverage,
      count: ranked.length,
      entries: ranked,
      graderRuns,
    };
  }

  /** Notify owners of venture merit-model top-picks. Mirrors notifyCourseProjectMeritRanks exactly. */
  async notifyVentureMeritRanks(
    user: { role: string; email: string; organizationId?: string },
    dto: NotifyMeritRanksDto,
  ) {
    const model = await this.getVentureMeritModel(user, {});
    const ranked: RankedVentureMeritCard[] = Array.isArray(model.entries) ? model.entries : [];
    const allowed = new Set(ranked.map((c) => c.id));
    const scope = (dto.scopeLabel || model.scope?.label || 'this ranking').trim();
    const picks = (dto.picks?.length
      ? dto.picks
      : (dto.entryIds || []).map((entryId, i) => ({ entryId, rank: i + 1, of: ranked.length, total: undefined as number | undefined }))
    )
      .filter((p) => p.entryId && allowed.has(p.entryId))
      .slice(0, 3);
    const graderRuns = picks.length
      ? await this.checkAndConsumeGraderRun('startup', user)
      : await this.peekGraderRunUsage('startup', user);
    const seen = new Set<string>();
    let sent = 0;
    for (const pick of picks) {
      if (seen.has(pick.entryId)) continue;
      seen.add(pick.entryId);
      const entry = await this.ventureRepo.findOne({ where: { id: pick.entryId } });
      if (!entry || entry.reviewPipeline?.supervisorStatus !== 'approved') continue;
      const of = pick.of || ranked.length;
      const rank = pick.rank;
      const previousRank = entry.meritRibbon?.rank ?? null;
      const badgeLevel = PathsService.computeRankBadgeLevel(rank, of);
      const ribbon = { rank, of, scope, total: pick.total, badgeLevel, previousRank, at: new Date().toISOString() };
      const already =
        entry.meritRibbon?.rank === rank &&
        entry.meritRibbon?.of === of &&
        entry.meritRibbon?.scope === scope;
      entry.meritRibbon = ribbon;
      await this.ventureRepo.save(entry);
      if (already) {
        sent += 1;
        continue;
      }
      const student = await this.usersRepo.findOne({ where: { id: entry.userId }, select: ['name'] });
      const first = student?.name?.split(' ')[0] || 'there';
      const title = entry.ventureName || 'Untitled venture';
      try {
        await this.notificationsService.createNotification(entry.userId, {
          type: 'update',
          title: `Your venture ranked #${rank}`,
          message: `${first}, your venture “${title}” ranked #${rank} of ${of} in ${scope} (${badgeLevel}). Open Startup / Business → My Impact Wall to see the ribbon.`,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(`Venture merit rank notification failed for ${entry.id}: ${(err as Error).message}`);
      }
    }
    return { notified: sent, scope, graderRuns };
  }

  async addVentureDocument(userId: string, dto: AddVentureDocumentDto) {
    return this.ventureRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(VentureEntry);
      let entry = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) entry = repo.create({ userId });
      const priorVersions = (entry.documents ?? []).filter(
        (d) => d.type === dto.type,
      ).length;
      entry.documents = [
        ...(entry.documents ?? []),
        {
          type: dto.type,
          version: priorVersions + 1,
          fileUrl: dto.fileUrl,
          uploadedAt: new Date().toISOString(),
        },
      ];
      const saved = await repo.save(entry);
      return this.withCompleteness(saved);
    });
  }

  /** @deprecated the guided wizard derives isVisible automatically — kept only for the legacy 4-tab flow's manual toggle on older entries. */
  async setVentureVisibility(userId: string, isVisible: boolean) {
    return this.ventureRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(VentureEntry);
      let entry = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) entry = repo.create({ userId });
      if (entry.stepCompleted > 0 || entry.status === 'submitted') {
        return {
          error: 'wizard_managed',
          message:
            'Visibility is now earned automatically through the guided wizard — reach Showcase Ready and choose an audience in the publish step.',
          data: this.withCompleteness(entry),
        };
      }
      const percent = ventureCompletenessPercent(entry);
      if (isVisible && percent < VENTURE_VISIBILITY_THRESHOLD) {
        return {
          error: 'incomplete_profile',
          message: `Your venture profile is ${percent}% complete. Reach ${VENTURE_VISIBILITY_THRESHOLD}% before making it visible.`,
          data: this.withCompleteness(entry),
        };
      }
      entry.isVisible = isVisible;
      const saved = await repo.save(entry);
      return { data: this.withCompleteness(saved) };
    });
  }

  private withCompleteness(entry: VentureEntry | null) {
    if (!entry) return null;
    return {
      ...entry,
      completenessPercent: ventureCompletenessPercent(entry),
      missingItems: ventureMissingItems(entry),
      gates: computeVentureGates(entry),
    };
  }
}

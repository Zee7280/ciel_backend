import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
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
import { UpdateCourseProjectDto } from './dto/update-course-project.dto';
import { AddFypDeliverableDto, UpdateFypDto } from './dto/update-fyp.dto';
import { AddVentureDocumentDto, UpdateVentureDto } from './dto/update-venture.dto';
import {
  ventureCompletenessPercent,
  ventureMissingItems,
  VENTURE_VISIBILITY_THRESHOLD,
} from './venture-completeness.constants';
import { computeVentureGates, deriveVentureIsVisible } from './venture-gates.util';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';

@Injectable()
export class PathsService {
  constructor(
    @InjectRepository(CourseProjectEntry)
    private readonly courseProjectRepo: Repository<CourseProjectEntry>,
    @InjectRepository(FypEntry)
    private readonly fypRepo: Repository<FypEntry>,
    @InjectRepository(VentureEntry)
    private readonly ventureRepo: Repository<VentureEntry>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly organizationsRepo: Repository<Organization>,
  ) {}

  // ---------- Course Project ----------

  private applyCourseProjectPatch(
    entry: CourseProjectEntry,
    dto: UpdateCourseProjectDto,
  ): CourseProjectEntry {
    if (dto.course !== undefined) entry.course = dto.course;
    if (dto.projectTitle !== undefined) entry.projectTitle = dto.projectTitle;
    if (dto.projectDescription !== undefined)
      entry.projectDescription = dto.projectDescription;
    if (dto.sdgs !== undefined) entry.sdgs = dto.sdgs;
    if (dto.evidenceUrls !== undefined) entry.evidenceUrls = dto.evidenceUrls;
    if (dto.studentInfo !== undefined)
      entry.studentInfo = {
        ...entry.studentInfo,
        ...dto.studentInfo,
      } as CourseProjectStudentInfo;
    if (dto.assignmentInfo !== undefined)
      entry.assignmentInfo = { ...entry.assignmentInfo, ...dto.assignmentInfo };
    if (dto.aimsInfo !== undefined)
      entry.aimsInfo = { ...entry.aimsInfo, ...dto.aimsInfo };
    if (dto.processInfo !== undefined)
      entry.processInfo = { ...entry.processInfo, ...dto.processInfo };
    if (dto.resultsInfo !== undefined)
      entry.resultsInfo = { ...entry.resultsInfo, ...dto.resultsInfo };
    if (dto.sdgMapping !== undefined)
      entry.sdgMapping = { ...entry.sdgMapping, ...dto.sdgMapping };
    if (dto.reflectionInfo !== undefined)
      entry.reflectionInfo = { ...entry.reflectionInfo, ...dto.reflectionInfo };
    if (dto.moduleInclusion !== undefined)
      entry.moduleInclusion = {
        ...entry.moduleInclusion,
        ...dto.moduleInclusion,
      };
    if (dto.sectionSummaries !== undefined)
      entry.sectionSummaries = {
        ...entry.sectionSummaries,
        ...dto.sectionSummaries,
      };
    if (dto.addedNote !== undefined) entry.addedNote = dto.addedNote;
    if (dto.stepCompleted !== undefined)
      entry.stepCompleted = dto.stepCompleted;
    if (dto.status !== undefined) entry.status = dto.status;
    return entry;
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
    return this.courseProjectRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(CourseProjectEntry);
      let entry = await repo.findOne({
        where: { userId },
        order: { updatedAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) entry = repo.create({ userId });
      return repo.save(this.applyCourseProjectPatch(entry, dto));
    });
  }

  /** Postgres JSONB match: does this entry's studentInfo.groupMembers list include userEmailNorm?
   * groupMembers elements may be a plain string (legacy) or {name, email} — jsonb_typeof guards the
   * ->>'email' lookup so legacy string entries (not JSON objects) don't error the whole query. */
  private static readonly TEAM_MEMBER_EMAIL_MATCH = `EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE("studentInfo"->'groupMembers', '[]'::jsonb)) AS gm
      WHERE jsonb_typeof(gm) = 'object'
        AND LOWER(TRIM(COALESCE(gm->>'email', ''))) = :teamEmail
    )`;

  /** A teammate only sees the report once it's submitted (not a mid-draft in progress) — same
   * "visible once official" moment as Community Service's team members (there it's approval;
   * here, since there's no separate approval step, submission is the equivalent trigger). */
  private static readonly TEAM_VISIBLE_STATUS = `e.status = 'submitted'`;

  /** One student can have many coursework reports (one per assignment) — this is their own deck, plus any
   * teammate's *submitted* report they were named on by email. */
  async listCourseProjects(userId: string, userEmail?: string) {
    const email = (userEmail || '').trim().toLowerCase();
    const qb = this.courseProjectRepo
      .createQueryBuilder('e')
      .where('e."userId" = :userId', { userId });
    if (email) {
      qb.orWhere(
        `(${PathsService.TEAM_VISIBLE_STATUS} AND ${PathsService.TEAM_MEMBER_EMAIL_MATCH})`,
        { teamEmail: email },
      );
    }
    const entries = await qb.orderBy('e."updatedAt"', 'DESC').getMany();
    return entries.map((e) => ({ ...e, isOwner: e.userId === userId }));
  }

  async createCourseProject(userId: string) {
    const saved = await this.courseProjectRepo.save(
      this.courseProjectRepo.create({ userId }),
    );
    return { ...saved, isOwner: true };
  }

  /** Owner gets full access at any stage; a named team member can only read it once submitted. */
  async getCourseProjectByIdForUser(userId: string, userEmail: string, id: string) {
    const email = (userEmail || '').trim().toLowerCase();
    const qb = this.courseProjectRepo
      .createQueryBuilder('e')
      .where('e.id = :id', { id })
      .andWhere(
        new Brackets((b) => {
          b.where('e."userId" = :userId', { userId });
          if (email) {
            b.orWhere(
              `(${PathsService.TEAM_VISIBLE_STATUS} AND ${PathsService.TEAM_MEMBER_EMAIL_MATCH})`,
              { teamEmail: email },
            );
          }
        }),
      );
    const entry = await qb.getOne();
    if (!entry) throw new NotFoundException('Course project entry not found');
    return { ...entry, isOwner: entry.userId === userId };
  }

  async updateCourseProjectByIdForUser(
    userId: string,
    id: string,
    dto: UpdateCourseProjectDto,
  ) {
    // Same locked read-modify-write as upsertCourseProject — see comment there.
    return this.courseProjectRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(CourseProjectEntry);
      const entry = await repo.findOne({
        where: { id, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry)
        throw new NotFoundException('Course project entry not found');
      const saved = await repo.save(this.applyCourseProjectPatch(entry, dto));
      // where: {id, userId} above means this only ever succeeds for the owner.
      return { ...saved, isOwner: true };
    });
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
    return this.attachStudents(matched);
  }

  /** The university showcase deck — submitted reports from students linked to this university org,
   * either formally (organizationId) or by the university name they entered in step 1. Same
   * scoping approach as the university analytics endpoint, so the two stay consistent. */
  async listCourseProjectsForUniversity(organizationId: string) {
    const org = await this.organizationsRepo.findOne({
      where: { id: organizationId },
    });
    if (!org) return [];
    const orgNameNorm = org.name.trim().toLowerCase();
    const entries = await this.courseProjectRepo
      .createQueryBuilder('e')
      .leftJoin('users', 'u', 'u.id::text = e."userId"')
      .where('e.status = :status', { status: 'submitted' })
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
    return this.attachStudents(entries);
  }

  async listCourseProjectsForAdmin(status?: 'draft' | 'submitted') {
    const entries = await this.courseProjectRepo.find({
      where: status ? { status } : {},
      order: { updatedAt: 'DESC' },
    });
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

  async getCourseProjectForAdmin(id: string) {
    const entry = await this.courseProjectRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException('Course project entry not found');
    const student = await this.usersRepo.findOne({
      where: { id: entry.userId },
      select: ['id', 'name', 'email', 'institution', 'department'],
    });
    return { ...entry, student: student ?? null };
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
    const enriched = entries.map((entry) => this.enrichFypForAdmin(entry));
    const filtered = progress
      ? enriched.filter((entry) => entry.progressStatus === progress)
      : enriched;
    return this.attachStudents(filtered);
  }

  async getFypForAdmin(id: string) {
    const entry = await this.fypRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException('FYP entry not found');
    const [withStudent] = await this.attachStudents([
      this.enrichFypForAdmin(entry),
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
    const enriched = entries.map((entry) => this.enrichVentureForAdmin(entry));
    return this.attachStudents(enriched);
  }

  async getVentureForAdmin(id: string) {
    const entry = await this.ventureRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException('Venture entry not found');
    const [withStudent] = await this.attachStudents([
      this.enrichVentureForAdmin(entry),
    ]);
    return withStudent;
  }

  // ---------- FYP / Thesis ----------

  /** Same jsonb email-match pattern as Course Project's TEAM_MEMBER_EMAIL_MATCH, scoped to
   * projectInfo.teamMembers instead of studentInfo.groupMembers. */
  private static readonly FYP_TEAM_MEMBER_EMAIL_MATCH = `EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE("projectInfo"->'teamMembers', '[]'::jsonb)) AS tm
      WHERE jsonb_typeof(tm) = 'object'
        AND LOWER(TRIM(COALESCE(tm->>'email', ''))) = :teamEmail
    )`;

  /** FYP is one record per student — a co-author with no record of their own sees the lead's
   * *submitted* record on their own dashboard instead (read-only), same "visible once official"
   * trigger as Course Project's team-sharing. A student's own record always takes priority. */
  async getFyp(userId: string, userEmail?: string) {
    const own = await this.fypRepo.findOne({ where: { userId } });
    if (own) return { ...own, isOwner: true };
    const email = (userEmail || '').trim().toLowerCase();
    if (!email) return null;
    const shared = await this.fypRepo
      .createQueryBuilder('e')
      .where(`e.status = 'submitted'`)
      .andWhere(PathsService.FYP_TEAM_MEMBER_EMAIL_MATCH, { teamEmail: email })
      .getOne();
    return shared ? { ...shared, isOwner: false } : null;
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
    return this.attachStudents(matched);
  }

  /** The university showcase deck — submitted FYP records from students formally affiliated with
   * this university org (via their account's organizationId). Unlike Course Project, FYP has no
   * free-text university-name field on the entry itself to fall back on. */
  async listFypForUniversity(organizationId: string) {
    const org = await this.organizationsRepo.findOne({
      where: { id: organizationId },
    });
    if (!org) return [];
    const entries = await this.fypRepo
      .createQueryBuilder('e')
      .leftJoin('users', 'u', 'u.id::text = e."userId"')
      .where('e.status = :status', { status: 'submitted' })
      .andWhere('u."organizationId"::text = :orgId', { orgId: organizationId })
      .orderBy('e."updatedAt"', 'DESC')
      .getMany();
    return this.attachStudents(entries);
  }

  async upsertFyp(userId: string, dto: UpdateFypDto) {
    // Locked read-modify-write — see comment on upsertCourseProject for why this matters.
    return this.fypRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(FypEntry);
      let entry = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry)
        entry = repo.create({ userId, milestones: DEFAULT_FYP_MILESTONES });
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
      const saved = await repo.save(entry);
      return { ...saved, isOwner: true };
    });
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

  async getVenture(userId: string) {
    const entry = await this.ventureRepo.findOne({ where: { userId } });
    return this.withCompleteness(entry);
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
        // isVisible is earned, not self-toggled, once the guided wizard is in use — recomputed
        // on every save so it always reflects the current Showcase-Ready + audience state.
        entry.isVisible = deriveVentureIsVisible(entry);
        return repo.save(entry);
      },
    );
    return this.withCompleteness(saved);
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

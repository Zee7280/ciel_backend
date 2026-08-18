import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CourseProjectEntry } from './entities/course-project-entry.entity';
import { DEFAULT_FYP_MILESTONES, FypEntry } from './entities/fyp-entry.entity';
import { VentureEntry } from './entities/venture-entry.entity';
import { UpdateCourseProjectDto } from './dto/update-course-project.dto';
import { AddFypDeliverableDto, UpdateFypDto } from './dto/update-fyp.dto';
import { UpdateVentureDto } from './dto/update-venture.dto';
import {
  ventureCompletenessPercent,
  ventureMissingItems,
  VENTURE_VISIBILITY_THRESHOLD,
} from './venture-completeness.constants';
import { User } from '../users/entities/user.entity';

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
      entry.studentInfo = { ...entry.studentInfo, ...dto.studentInfo };
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

  /** One student can have many coursework reports (one per assignment) — this is their full deck. */
  async listCourseProjects(userId: string) {
    return this.courseProjectRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  async createCourseProject(userId: string) {
    return this.courseProjectRepo.save(
      this.courseProjectRepo.create({ userId }),
    );
  }

  async getCourseProjectByIdForUser(userId: string, id: string) {
    const entry = await this.courseProjectRepo.findOne({
      where: { id, userId },
    });
    if (!entry) throw new NotFoundException('Course project entry not found');
    return entry;
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
      return repo.save(this.applyCourseProjectPatch(entry, dto));
    });
  }

  async deleteCourseProjectByIdForUser(userId: string, id: string) {
    const entry = await this.getCourseProjectByIdForUser(userId, id);
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

  async getFyp(userId: string) {
    return this.fypRepo.findOne({ where: { userId } });
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
      if (dto.projectInfo !== undefined) entry.projectInfo = dto.projectInfo;
      if (dto.background !== undefined) entry.background = dto.background;
      if (dto.objectivesInfo !== undefined)
        entry.objectivesInfo = dto.objectivesInfo;
      if (dto.literature !== undefined) entry.literature = dto.literature;
      if (dto.methodology !== undefined) entry.methodology = dto.methodology;
      if (dto.findings !== undefined) entry.findings = dto.findings;
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
      return repo.save(entry);
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
        return repo.save(entry);
      },
    );
    return this.withCompleteness(saved);
  }

  async setVentureVisibility(userId: string, isVisible: boolean) {
    return this.ventureRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(VentureEntry);
      let entry = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) entry = repo.create({ userId });
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
    };
  }
}
